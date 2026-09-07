// Read-side query layer.
//
// Aggregates live at two granularities ('h' recent, 'd' after folding) but a
// given instant exists in exactly one of them — folding deletes the hourly
// rows it consumed. Queries can therefore scan both and normalise the bucket
// to whatever step the caller wants, with no risk of double counting.
//
// Note on parameters: better-sqlite3 rejects a bound object containing a name
// the statement does not use, so optional filters must add both the SQL
// fragment and its parameter together. `scope()` below is the only place that
// decides, which keeps the two in step.

import { getDb } from './db.js';
import { config } from './config.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Sub-hour resolution is only possible while raw events are still retained. */
function rawWindowStart() {
  return Date.now() - config.retention.rawHours * HOUR_MS;
}

/** Pick a sensible bucket size (seconds) for a time span. */
export function chooseStep(fromMs, toMs) {
  const span = Math.max(1, toMs - fromMs);
  if (span <= 6 * HOUR_MS && fromMs >= rawWindowStart()) return 60; // minutes, from events
  if (span <= 3 * DAY_MS) return 3600;
  if (span <= 90 * DAY_MS) return 86400;
  return 86400 * 7;
}

const hostClause = (host) => (host ? 'AND host = @host' : '');

/** Bind object for a bucket-range query, adding @host only when it is used. */
function scope(fromMs, toMs, host, extra) {
  const p = { from: Math.floor(fromMs / 1000), to: Math.ceil(toMs / 1000) };
  if (host) p.host = host;
  if (extra) Object.assign(p, extra);
  return p;
}

/** LIKE pattern with SQLite wildcards and the escape character neutralised. */
function likePattern(search) {
  if (!search) return null;
  return `%${String(search).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
}

// ---------------------------------------------------------------------------
//  Headline numbers
// ---------------------------------------------------------------------------

export function totals(fromMs, toMs, host = null) {
  const db = getDb();
  const params = scope(fromMs, toMs, host);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(requests),0)  AS requests,
              COALESCE(SUM(bytes_out),0) AS bytes_out,
              COALESCE(SUM(bytes_in),0)  AS bytes_in,
              COALESCE(SUM(dur_sum),0)   AS dur_sum,
              COALESCE(MAX(dur_max),0)   AS dur_max,
              COALESCE(SUM(c1xx),0) AS c1xx, COALESCE(SUM(c2xx),0) AS c2xx,
              COALESCE(SUM(c3xx),0) AS c3xx, COALESCE(SUM(c4xx),0) AS c4xx,
              COALESCE(SUM(c5xx),0) AS c5xx, COALESCE(SUM(bots),0) AS bots,
              COUNT(DISTINCT host) AS hosts
         FROM rollup
        WHERE bucket >= @from AND bucket < @to ${hostClause(host)}`
    )
    .get(params);

  const uniq = db
    .prepare(
      `SELECT COUNT(DISTINCT value) AS n FROM dims
        WHERE dim = 'ip' AND bucket >= @from AND bucket < @to ${hostClause(host)}`
    )
    .get(params);

  const ok = row.c2xx + row.c3xx;
  return {
    ...row,
    unique_ips: uniq.n,
    avg_ms: row.requests ? row.dur_sum / row.requests : 0,
    success_rate: row.requests ? ok / row.requests : 0,
    error_rate: row.requests ? (row.c4xx + row.c5xx) / row.requests : 0,
  };
}

// ---------------------------------------------------------------------------
//  Time series
// ---------------------------------------------------------------------------

export function series(fromMs, toMs, host = null, stepSec = null) {
  const db = getDb();
  const step = stepSec ?? chooseStep(fromMs, toMs);

  if (step < 3600) {
    // Minute resolution comes straight from the retained event rows.
    const params = { from: fromMs, to: toMs, step };
    if (host) params.host = host;
    const rows = db
      .prepare(
        `SELECT CAST(ts / (@step * 1000) AS INTEGER) * @step AS bucket,
                COUNT(*) AS requests,
                COALESCE(SUM(bytes_out),0) AS bytes_out,
                COALESCE(SUM(bytes_in),0) AS bytes_in,
                COALESCE(SUM(dur_ms),0) AS dur_sum,
                SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS c2xx,
                SUM(CASE WHEN status >= 300 AND status < 400 THEN 1 ELSE 0 END) AS c3xx,
                SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS c4xx,
                SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS c5xx,
                SUM(bot) AS bots
           FROM events
          WHERE ts >= @from AND ts < @to ${hostClause(host)}
          GROUP BY bucket ORDER BY bucket`
      )
      .all(params);
    return { step, points: rows };
  }

  const rows = db
    .prepare(
      `SELECT CAST(bucket / @step AS INTEGER) * @step AS bucket,
              SUM(requests) AS requests, SUM(bytes_out) AS bytes_out,
              SUM(bytes_in) AS bytes_in, SUM(dur_sum) AS dur_sum,
              SUM(c2xx) AS c2xx, SUM(c3xx) AS c3xx,
              SUM(c4xx) AS c4xx, SUM(c5xx) AS c5xx, SUM(bots) AS bots
         FROM rollup
        WHERE bucket >= @from AND bucket < @to ${hostClause(host)}
        GROUP BY 1 ORDER BY 1`
    )
    .all(scope(fromMs, toMs, host, { step }));
  return { step, points: rows };
}

// ---------------------------------------------------------------------------
//  Dimensions
// ---------------------------------------------------------------------------

const SORTS = {
  requests: 'requests DESC',
  bytes: 'bytes DESC',
  errors: 'errors DESC',
  slowest: 'avg_ms DESC',
};

export function topDim(
  dim,
  fromMs,
  toMs,
  { host = null, limit = 20, offset = 0, sort = 'requests', search = null } = {}
) {
  const db = getDb();
  const order = SORTS[sort] ?? SORTS.requests;
  const like = likePattern(search);
  const likeClause = like ? "AND value LIKE @like ESCAPE '\\'" : '';

  const params = scope(fromMs, toMs, host, {
    dim,
    limit: Math.min(1000, Math.max(1, limit)),
    offset: Math.max(0, offset),
  });
  if (like) params.like = like;

  const rows = db
    .prepare(
      `SELECT value,
              SUM(requests) AS requests,
              SUM(bytes)    AS bytes,
              SUM(errors)   AS errors,
              CASE WHEN SUM(requests) > 0 THEN SUM(dur_sum) / SUM(requests) ELSE 0 END AS avg_ms
         FROM dims
        WHERE dim = @dim AND bucket >= @from AND bucket < @to ${hostClause(host)} ${likeClause}
        GROUP BY value
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`
    )
    .all(params);

  const total = db
    .prepare(
      `SELECT COUNT(DISTINCT value) AS n, COALESCE(SUM(requests),0) AS requests
         FROM dims
        WHERE dim = @dim AND bucket >= @from AND bucket < @to ${hostClause(host)}`
    )
    .get(scope(fromMs, toMs, host, { dim }));

  return { rows, distinct: total.n, total: total.requests };
}

/**
 * ASN breakdown, joined to the registrant detail fetched once per ASN.
 * `country` here is where the AS is *registered* — not where the traffic came
 * from, which is `dims.dim = 'country'` via MaxMind.
 */
export function topAsns(fromMs, toMs, { host = null, limit = 20 } = {}) {
  return getDb()
    .prepare(
      `SELECT d.value AS asn,
              COALESCE(n.org, n.as_name,
                       CASE WHEN d.value = '0' THEN 'Unresolved' ELSE 'AS' || d.value END) AS org,
              n.as_name, n.country AS as_country, n.rir, n.description,
              n.prefix_v4, n.prefix_v6,
              SUM(d.requests) AS requests, SUM(d.bytes) AS bytes, SUM(d.errors) AS errors
         FROM dims d
    LEFT JOIN asn_names n ON n.asn = CAST(d.value AS INTEGER)
        WHERE d.dim = 'asn' AND d.bucket >= @from AND d.bucket < @to
              ${host ? 'AND d.host = @host' : ''}
        GROUP BY d.value
        ORDER BY requests DESC
        LIMIT @limit`
    )
    .all(scope(fromMs, toMs, host, { limit: Math.min(1000, Math.max(1, limit)) }));
}

/** Everything known about one ASN, for the drill-down panel. */
export function asnDetail(asn, fromMs, toMs, host = null) {
  const db = getDb();
  const info = db.prepare('SELECT * FROM asn_names WHERE asn = ?').get(asn) ?? null;
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes),0) AS bytes,
              COALESCE(SUM(errors),0) AS errors
         FROM dims
        WHERE dim = 'asn' AND value = @asn AND bucket >= @from AND bucket < @to
              ${hostClause(host)}`
    )
    .get(scope(fromMs, toMs, host, { asn: String(asn) }));
  const addresses = db
    .prepare(
      `SELECT ip, country, as_prefix, as_org, source, updated_at
         FROM ip_info WHERE asn = ? ORDER BY updated_at DESC LIMIT 200`
    )
    .all(asn);
  return { asn, info, totals, addresses };
}

/** Paths responsible for the most 4xx/5xx responses. */
export function errorPaths(fromMs, toMs, host = null, limit = 25) {
  return getDb()
    .prepare(
      `SELECT value AS path, SUM(errors) AS errors, SUM(requests) AS requests,
              CASE WHEN SUM(requests) > 0
                   THEN CAST(SUM(errors) AS REAL) / SUM(requests) ELSE 0 END AS error_rate
         FROM dims
        WHERE dim = 'path' AND bucket >= @from AND bucket < @to ${hostClause(host)}
        GROUP BY value
       HAVING errors > 0
        ORDER BY errors DESC
        LIMIT @limit`
    )
    .all(scope(fromMs, toMs, host, { limit }));
}

/** Country counts for the choropleth. */
export function countries(fromMs, toMs, host = null) {
  return getDb()
    .prepare(
      `SELECT value AS country, SUM(requests) AS requests, SUM(bytes) AS bytes
         FROM dims
        WHERE dim = 'country' AND bucket >= @from AND bucket < @to ${hostClause(host)}
        GROUP BY value ORDER BY requests DESC`
    )
    .all(scope(fromMs, toMs, host));
}

// Upper edge of each latency bucket, used as the (conservative) estimate.
const LATENCY_EDGES = {
  '0-1 ms': 1, '1-5 ms': 5, '5-10 ms': 10, '10-25 ms': 25, '25-50 ms': 50,
  '50-100 ms': 100, '100-250 ms': 250, '250-500 ms': 500, '0.5-1 s': 1000,
  '1-2.5 s': 2500, '2.5-5 s': 5000, '5-10 s': 10000, '10 s+': 30000,
};

/** Approximate percentiles from the latency histogram. */
export function latency(fromMs, toMs, host = null) {
  const rows = getDb()
    .prepare(
      `SELECT value, SUM(requests) AS requests
         FROM dims
        WHERE dim = 'lat' AND bucket >= @from AND bucket < @to ${hostClause(host)}
        GROUP BY value`
    )
    .all(scope(fromMs, toMs, host));

  const ordered = rows
    .filter((r) => LATENCY_EDGES[r.value] !== undefined)
    .sort((a, b) => LATENCY_EDGES[a.value] - LATENCY_EDGES[b.value]);
  const total = ordered.reduce((s, r) => s + r.requests, 0);

  const pct = (p) => {
    if (!total) return null;
    let seen = 0;
    const target = total * p;
    for (const r of ordered) {
      seen += r.requests;
      if (seen >= target) return LATENCY_EDGES[r.value];
    }
    return LATENCY_EDGES[ordered.at(-1)?.value] ?? null;
  };

  return {
    histogram: ordered.map((r) => ({ bucket: r.value, requests: r.requests })),
    total,
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

// ---------------------------------------------------------------------------
//  Domains
// ---------------------------------------------------------------------------

export function domains(fromMs, toMs, { sort = 'requests', search = null } = {}) {
  const order =
    {
      requests: 'requests DESC',
      bytes: 'bytes_out DESC',
      errors: 'errors DESC',
      name: 'r.host ASC',
    }[sort] ?? 'requests DESC';

  const like = likePattern(search);
  const params = { from: Math.floor(fromMs / 1000), to: Math.ceil(toMs / 1000) };
  if (like) params.like = like;

  return getDb()
    .prepare(
      `SELECT r.host,
              SUM(r.requests)  AS requests,
              SUM(r.bytes_out) AS bytes_out,
              SUM(r.bytes_in)  AS bytes_in,
              SUM(r.c2xx) AS c2xx, SUM(r.c3xx) AS c3xx,
              SUM(r.c4xx) AS c4xx, SUM(r.c5xx) AS c5xx,
              SUM(r.c4xx) + SUM(r.c5xx) AS errors,
              SUM(r.bots) AS bots,
              CASE WHEN SUM(r.requests) > 0 THEN SUM(r.dur_sum) / SUM(r.requests) ELSE 0 END AS avg_ms,
              h.first_seen, h.last_seen
         FROM rollup r
    LEFT JOIN hosts h ON h.host = r.host
        WHERE r.bucket >= @from AND r.bucket < @to
          ${like ? "AND r.host LIKE @like ESCAPE '\\'" : ''}
        GROUP BY r.host
        ORDER BY ${order}`
    )
    .all(params);
}

export function hostExists(host) {
  return !!getDb().prepare('SELECT 1 FROM hosts WHERE host = ?').get(host);
}

export function dataRange() {
  const r = getDb().prepare('SELECT MIN(bucket) AS min_b, MAX(bucket) AS max_b FROM rollup').get();
  const e = getDb().prepare('SELECT MIN(ts) AS min_t, MAX(ts) AS max_t FROM events').get();
  return {
    aggregates: {
      from: r.min_b ? r.min_b * 1000 : null,
      to: r.max_b ? (r.max_b + 3600) * 1000 : null,
    },
    events: { from: e.min_t ?? null, to: e.max_t ?? null },
  };
}

// ---------------------------------------------------------------------------
//  Individual requests — the live stream, and every drill-down
// ---------------------------------------------------------------------------
//
// These read `events`, which is retained for RAW_RETENTION_HOURS only. Callers
// that expose this to the UI must say so, otherwise an empty result reads as
// "nothing matched" when it actually means "older than the raw window".

const EVENT_COLUMNS = `id, ts, host, method, path, query, status, bytes_out, bytes_in,
  dur_ms, ip, ua, referer, referer_host, proto, tls_version, tls_cipher, browser,
  os, device, bot, country, asn, as_org`;

/** Latency bucket labels mapped back to the range that produced them. */
const LATENCY_RANGES = {
  '0-1 ms': [0, 1], '1-5 ms': [1, 5], '5-10 ms': [5, 10], '10-25 ms': [10, 25],
  '25-50 ms': [25, 50], '50-100 ms': [50, 100], '100-250 ms': [100, 250],
  '250-500 ms': [250, 500], '0.5-1 s': [500, 1000], '1-2.5 s': [1000, 2500],
  '2.5-5 s': [2500, 5000], '5-10 s': [5000, 10000], '10 s+': [10000, null],
};

/**
 * Build the WHERE fragment shared by the stream, the log view and every
 * drill-down. Every value is bound, never interpolated, and a parameter is
 * only added when the fragment that uses it is.
 */
function eventFilters(f, params) {
  const parts = [];
  const eq = (sql, key, value) => {
    parts.push(sql);
    params[key] = value;
  };

  if (f.host) eq('host = @host', 'host', String(f.host).toLowerCase());
  if (f.ip) eq('ip = @ip', 'ip', String(f.ip));
  if (f.method) eq('method = @method', 'method', String(f.method).toUpperCase());
  if (f.browser) eq('browser = @browser', 'browser', String(f.browser));
  if (f.os) eq('os = @os', 'os', String(f.os));
  if (f.device) eq('device = @device', 'device', String(f.device));
  if (f.proto) eq('proto = @proto', 'proto', String(f.proto));
  if (f.path) eq('path = @path', 'path', String(f.path));
  if (f.ua) eq('ua = @ua', 'ua', String(f.ua));

  // Sentinel values the aggregates use for "no value recorded".
  if (f.tls) {
    if (f.tls === '(none)') parts.push('tls_version IS NULL');
    else eq('tls_version = @tls', 'tls', String(f.tls));
  }
  if (f.cipher) {
    if (f.cipher === '(none)') parts.push('tls_cipher IS NULL');
    else eq('cipher = @cipher', 'cipher', String(f.cipher));
  }
  if (f.country) {
    if (f.country === 'XX') parts.push('country IS NULL');
    else eq('country = @country', 'country', String(f.country).toUpperCase());
  }
  if (f.asn !== undefined && f.asn !== null && f.asn !== '') {
    const n = parseInt(f.asn, 10);
    if (Number.isFinite(n)) {
      if (n === 0) parts.push('(asn IS NULL OR asn = 0)');
      else eq('asn = @asn', 'asn', n);
    }
  }

  if (f.referer) {
    const rh = String(f.referer);
    if (rh === '(direct)') {
      parts.push('(referer IS NULL OR referer = \'\')');
    } else {
      // referer_host is populated from the upgrade onward; older rows fall
      // back to a substring match so drill-down still works on them.
      parts.push(
        "(referer_host = @refhost OR (referer_host IS NULL AND referer LIKE '%//' || @refhost || '%'))"
      );
      params.refhost = rh;
    }
  }

  if (f.ext) {
    if (f.ext === '(none)') {
      parts.push("(path NOT LIKE '%.%' OR substr(path, -1) = '/')");
    } else {
      parts.push("path LIKE '%.' || @ext");
      params.ext = String(f.ext);
    }
  }

  if (f.status) {
    const s = String(f.status);
    if (/^[1-5]xx$/i.test(s)) {
      parts.push('status >= @statusLo AND status < @statusHi');
      params.statusLo = parseInt(s[0], 10) * 100;
      params.statusHi = params.statusLo + 100;
    } else if (/^\d{3}$/.test(s)) {
      eq('status = @status', 'status', parseInt(s, 10));
    }
  }

  // A latency bucket from the histogram, resolved back to its range.
  if (f.lat && LATENCY_RANGES[f.lat]) {
    const [lo, hi] = LATENCY_RANGES[f.lat];
    parts.push('dur_ms >= @latLo');
    params.latLo = lo;
    if (hi !== null) {
      parts.push('dur_ms < @latHi');
      params.latHi = hi;
    }
  }
  if (f.minDur !== undefined && f.minDur !== null && f.minDur !== '') {
    const n = Number(f.minDur);
    if (Number.isFinite(n)) eq('dur_ms >= @minDur', 'minDur', n);
  }

  if (f.bots === 'only') parts.push('bot = 1');
  if (f.bots === 'exclude') parts.push('bot = 0');

  if (f.from) {
    const n = Number(f.from);
    if (Number.isFinite(n)) eq('ts >= @tsFrom', 'tsFrom', n);
  }
  if (f.to) {
    const n = Number(f.to);
    if (Number.isFinite(n)) eq('ts < @tsTo', 'tsTo', n);
  }

  if (f.q) {
    parts.push(
      "(path LIKE @q ESCAPE '\\' OR ua LIKE @q ESCAPE '\\' OR referer LIKE @q ESCAPE '\\'" +
        " OR ip LIKE @q ESCAPE '\\' OR host LIKE @q ESCAPE '\\' OR query LIKE @q ESCAPE '\\')"
    );
    params.q = likePattern(f.q);
  }

  return parts.length ? 'AND ' + parts.join(' AND ') : '';
}

/** Which filters a caller actually supplied, for display as removable chips. */
export const EVENT_FILTER_KEYS = [
  'host', 'ip', 'asn', 'country', 'status', 'method', 'path', 'ua', 'browser',
  'os', 'device', 'referer', 'proto', 'tls', 'cipher', 'ext', 'lat', 'bots',
  'q', 'minDur', 'from', 'to',
];

/**
 * Paginated request search. Descending by id (newest first); pass the last id
 * seen as `before` to continue.
 * @returns {{rows:object[], nextCursor:number|null, window:{from:number|null}}}
 */
export function searchEvents(filters = {}, { limit = 100, before = null } = {}) {
  const capped = Math.min(500, Math.max(1, limit));
  const params = { limit: capped + 1 };
  const where = eventFilters(filters, params);

  let cursorClause = '';
  if (before !== null && before !== undefined && before !== '') {
    const n = parseInt(before, 10);
    if (Number.isFinite(n)) {
      cursorClause = 'AND id < @before';
      params.before = n;
    }
  }

  const rows = getDb()
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE 1=1 ${where} ${cursorClause}
        ORDER BY id DESC LIMIT @limit`
    )
    .all(params);

  // One extra row was requested purely to detect whether more exist.
  const hasMore = rows.length > capped;
  if (hasMore) rows.length = capped;

  return {
    rows,
    nextCursor: hasMore && rows.length ? rows[rows.length - 1].id : null,
    retainedFrom: oldestRetainedEvent(),
  };
}

/** Count matching requests, capped so a broad filter cannot scan forever. */
export function countEvents(filters = {}, cap = 100000) {
  const params = { cap };
  const where = eventFilters(filters, params);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM events WHERE 1=1 ${where} LIMIT @cap
       )`
    )
    .get(params);
  return { count: row.n, capped: row.n >= cap };
}

export function oldestRetainedEvent() {
  return getDb().prepare('SELECT MIN(ts) AS t FROM events').get().t ?? null;
}

export function recentEvents(filters = {}, limit = 100) {
  return searchEvents(filters, { limit }).rows;
}

/** Events strictly newer than `afterId`, oldest first — the stream tail. */
export function eventsAfter(afterId, filters = {}, limit = 300) {
  const params = { afterId, limit: Math.min(1000, Math.max(1, limit)) };
  const where = eventFilters(filters, params);
  return getDb()
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id > @afterId ${where}
        ORDER BY id ASC LIMIT @limit`
    )
    .all(params);
}

export function maxEventId() {
  return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id;
}

/**
 * One request with its original log line.
 * Returns `found: false` rather than throwing, so the UI can distinguish
 * "pruned by retention" from "the request failed".
 */
export function eventById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { found: false, reason: 'bad_id' };

  const event = getDb().prepare('SELECT * FROM events WHERE id = ?').get(n);
  if (!event) {
    return {
      found: false,
      reason: 'pruned',
      retainedFrom: oldestRetainedEvent(),
      retentionHours: config.retention.rawHours,
    };
  }

  let parsed = null;
  let parseError = null;
  if (event.raw) {
    try {
      parsed = JSON.parse(event.raw);
    } catch (err) {
      // Keep the raw text available; a truncated very long line lands here.
      parseError = String(err.message);
    }
  }
  return { found: true, event, parsed, parseError, hasRaw: Boolean(event.raw) };
}

/** Everything known about one source address. */
export function ipDetail(ip, fromMs, toMs, host = null) {
  const db = getDb();
  const info = db.prepare('SELECT * FROM ip_info WHERE ip = ?').get(ip) ?? null;

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes),0) AS bytes,
              COALESCE(SUM(errors),0) AS errors
         FROM dims
        WHERE dim = 'ip' AND value = @ip AND bucket >= @from AND bucket < @to ${hostClause(host)}`
    )
    .get(scope(fromMs, toMs, host, { ip }));

  // Everything below comes from retained events, so it covers the raw window
  // rather than the full statistics range.
  const live = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(bytes_out),0) AS bytes,
              MIN(ts) AS first_seen, MAX(ts) AS last_seen,
              COUNT(DISTINCT host) AS hosts, COUNT(DISTINCT path) AS paths,
              COUNT(DISTINCT ua) AS agents,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN bot = 1 THEN 1 ELSE 0 END) AS bots
         FROM events WHERE ip = ?`
    )
    .get(ip);

  const breakdown = (column) =>
    db
      .prepare(
        `SELECT ${column} AS value, COUNT(*) AS requests,
                COALESCE(SUM(bytes_out),0) AS bytes,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
           FROM events WHERE ip = ? AND ${column} IS NOT NULL
          GROUP BY ${column} ORDER BY requests DESC LIMIT 25`
      )
      .all(ip);

  return {
    ip,
    info,
    totals,
    live,
    hosts: breakdown('host'),
    paths: breakdown('path'),
    agents: breakdown('ua'),
    statuses: breakdown('status'),
    methods: breakdown('method'),
    retainedFrom: oldestRetainedEvent(),
    retentionHours: config.retention.rawHours,
  };
}

export function ingestStats() {
  const db = getDb();
  return {
    days: db.prepare('SELECT * FROM ingest_stats ORDER BY day DESC LIMIT 14').all(),
    files: db
      .prepare('SELECT path, offset, size, updated_at FROM ingest_state ORDER BY updated_at DESC LIMIT 50')
      .all(),
    counts: {
      // COUNT(*) on events can be large; SQLite still answers it from the
      // primary-key index, and this endpoint is only hit by the health page.
      events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      pending: db.prepare('SELECT COUNT(*) AS n FROM events WHERE rolled = 0').get().n,
      dims: db.prepare('SELECT COUNT(*) AS n FROM dims').get().n,
      rollup: db.prepare('SELECT COUNT(*) AS n FROM rollup').get().n,
      ipInfo: db.prepare('SELECT COUNT(*) AS n FROM ip_info').get().n,
    },
  };
}
