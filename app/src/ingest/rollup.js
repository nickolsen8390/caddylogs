// Aggregation pass: turns individual `events` rows into the `rollup` and
// `dims` counters that every stats query reads.
//
// This runs separately from insertion, on events older than ROLLUP_LAG_MS, so
// that IPs which needed a remote ASN lookup have had a chance to resolve
// before they are counted. Any that resolved in the meantime are also written
// back onto the event row, so the live stream and the aggregates agree.

import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { extensionOf, refererHost, latencyBucket, parseLine, VISIT_COLUMNS } from './parser.js';
import { isPageview, isExternalReferer, UTM_KEYS } from './traffic.js';
import { Sessionizer } from './visits.js';

const log = logger('rollup');

export const HOUR = 3600;
export const DAY = 86400;

export const hourBucket = (tsMs) => Math.floor(tsMs / 3_600_000) * HOUR;
export const dayBucket = (tsMs) => Math.floor(tsMs / 86_400_000) * DAY;

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    pick: db.prepare(
      `SELECT id, ts, host, method, path, status, bytes_out, bytes_in, dur_ms, ip, ua,
              referer, referer_host, proto, tls_version, tls_cipher, browser, os, device, bot,
              country, asn, as_org, ${VISIT_COLUMNS.join(', ')}
         FROM events
        WHERE rolled = 0 AND ts < ?
        ORDER BY id
        LIMIT ?`
    ),
    markRolledOne: db.prepare('UPDATE events SET rolled = 1 WHERE id = ?'),
    ipInfo: db.prepare('SELECT ip, country, asn, as_org FROM ip_info WHERE ip = ?'),
    fixEvent: db.prepare('UPDATE events SET country = ?, asn = ?, as_org = ? WHERE id = ?'),
    raw: db.prepare('SELECT raw FROM events WHERE id = ?'),
    setVisit: db.prepare(
      `UPDATE events SET ${VISIT_COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`
    ),
    // Rows stored before the visitor columns existed, in id order.
    unvisited: db.prepare(
      `SELECT id, ts, host, path, status, bytes_out, dur_ms, ip, ua, referer, referer_host,
              rolled, raw
         FROM events
        WHERE id >= ? AND id <= ? AND nav IS NULL
        ORDER BY id
        LIMIT ?`
    ),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
    delMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
    rollup: db.prepare(
      `INSERT INTO rollup (bucket, gran, host, requests, bytes_out, bytes_in, dur_sum,
                           dur_max, c1xx, c2xx, c3xx, c4xx, c5xx, bots, pageviews,
                           visits, visitors, bounces, visit_ms)
         VALUES (@bucket, @gran, @host, @requests, @bytes_out, @bytes_in, @dur_sum,
                 @dur_max, @c1xx, @c2xx, @c3xx, @c4xx, @c5xx, @bots, @pageviews,
                 @visits, @visitors, @bounces, @visit_ms)
       ON CONFLICT(bucket, gran, host) DO UPDATE SET
         requests  = rollup.requests  + excluded.requests,
         bytes_out = rollup.bytes_out + excluded.bytes_out,
         bytes_in  = rollup.bytes_in  + excluded.bytes_in,
         dur_sum   = rollup.dur_sum   + excluded.dur_sum,
         dur_max   = MAX(rollup.dur_max, excluded.dur_max),
         c1xx = rollup.c1xx + excluded.c1xx,
         c2xx = rollup.c2xx + excluded.c2xx,
         c3xx = rollup.c3xx + excluded.c3xx,
         c4xx = rollup.c4xx + excluded.c4xx,
         c5xx = rollup.c5xx + excluded.c5xx,
         bots = rollup.bots + excluded.bots,
         pageviews = rollup.pageviews + excluded.pageviews,
         visits    = rollup.visits    + excluded.visits,
         visitors  = rollup.visitors  + excluded.visitors,
         bounces   = rollup.bounces   + excluded.bounces,
         visit_ms  = rollup.visit_ms  + excluded.visit_ms`
    ),
    dim: db.prepare(
      `INSERT INTO dims (bucket, gran, host, dim, value, requests, bytes, errors, dur_sum)
         VALUES (@bucket, @gran, @host, @dim, @value, @requests, @bytes, @errors, @dur_sum)
       ON CONFLICT(bucket, gran, host, dim, value) DO UPDATE SET
         requests = dims.requests + excluded.requests,
         bytes    = dims.bytes    + excluded.bytes,
         errors   = dims.errors   + excluded.errors,
         dur_sum  = dims.dur_sum  + excluded.dur_sum`
    ),
    host: db.prepare(
      `INSERT INTO hosts (host, first_seen, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
         first_seen = MIN(hosts.first_seen, excluded.first_seen),
         last_seen  = MAX(hosts.last_seen,  excluded.last_seen)`
    ),
    // Ensures a row exists for every ASN we counted, so the background detail
    // worker has something to find. Never overwrites richer data already
    // fetched from the ASN endpoint.
    asnName: db.prepare(
      `INSERT INTO asn_names (asn, org, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(asn) DO UPDATE SET
         org = COALESCE(asn_names.org, excluded.org),
         updated_at = excluded.updated_at`
    ),
  };
  return stmts;
}

// Separator for composite Map keys. A NUL can never appear in a hostname,
// dimension name or URL path, so it cannot collide the way a space or a pipe
// could when the trailing component is free-form user input.
const SEP = String.fromCharCode(0);

/**
 * Accumulator that collapses a batch of events before touching the database.
 * Exported for the self-test.
 */
export class Accumulator {
  /** @param {object} [store] visit state for the Sessionizer (default: the database) */
  constructor(store) {
    this.rollups = new Map(); // bucket+host -> counters
    this.dims = new Map(); // bucket+host+dim+value -> counters
    this.hosts = new Map(); // host -> [first, last]
    this.asns = new Map(); // asn -> org
    this.sessions = new Sessionizer((v, sign) => this.visitDelta(v, sign), store);
  }

  row(bucket, host) {
    const key = `${bucket}${SEP}${host}`;
    let r = this.rollups.get(key);
    if (!r) {
      r = {
        bucket, gran: 'h', host,
        requests: 0, bytes_out: 0, bytes_in: 0, dur_sum: 0, dur_max: 0,
        c1xx: 0, c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0, bots: 0, pageviews: 0,
        visits: 0, visitors: 0, bounces: 0, visit_ms: 0,
      };
      this.rollups.set(key, r);
    }
    return r;
  }

  bump(bucket, host, ev) {
    const r = this.row(bucket, host);
    r.requests += 1;
    r.bytes_out += ev.bytes_out || 0;
    r.bytes_in += ev.bytes_in || 0;
    const d = ev.dur_ms ?? 0;
    r.dur_sum += d;
    if (d > r.dur_max) r.dur_max = d;
    const cls = Math.floor((ev.status || 0) / 100);
    if (cls === 1) r.c1xx += 1;
    else if (cls === 2) r.c2xx += 1;
    else if (cls === 3) r.c3xx += 1;
    else if (cls === 4) r.c4xx += 1;
    else if (cls === 5) r.c5xx += 1;
    if (ev.bot) r.bots += 1;
  }

  dim(bucket, host, dim, value, ev) {
    this.dimDelta(bucket, host, dim, value, {
      requests: 1,
      bytes: ev.bytes_out || 0,
      errors: (ev.status || 0) >= 400 ? 1 : 0,
      dur_sum: ev.dur_ms ?? 0,
    });
  }

  dimDelta(bucket, host, dim, value, change) {
    if (value === null || value === undefined || value === '') return;
    const v = String(value).slice(0, 512);
    const key = `${bucket}${SEP}${host}${SEP}${dim}${SEP}${v}`;
    let d = this.dims.get(key);
    if (!d) {
      d = { bucket, gran: 'h', host, dim, value: v, requests: 0, bytes: 0, errors: 0, dur_sum: 0 };
      this.dims.set(key, d);
    }
    d.requests += change.requests;
    d.bytes += change.bytes;
    d.errors += change.errors;
    d.dur_sum += change.dur_sum;
  }

  /**
   * Add (sign 1) or withdraw (sign -1) one visit's share of the counters, in
   * the hour the visit started. A visit that grows is withdrawn as it was and
   * added as it is, so every counter moves by exactly the difference: the
   * bounce disappears on the second page view, the exit page moves, the
   * duration lengthens.
   */
  visitDelta(v, sign) {
    const bucket = hourBucket(v.start_ts);
    const bounce = v.pageviews === 1 ? 1 : 0;
    const ms = Math.max(0, v.end_ts - v.start_ts);

    const r = this.row(bucket, v.host);
    r.visits += sign;
    r.visitors += sign * v.first;
    r.bounces += sign * bounce;
    r.visit_ms += sign * ms;

    // Visit dimensions: requests = visits, bytes = page views, errors =
    // bounces, dur_sum = visit duration (see schema.sql).
    const change = { requests: sign, bytes: sign * v.pageviews, errors: sign * bounce, dur_sum: sign * ms };
    this.dimDelta(bucket, v.host, 'entry', v.entry_path, change);
    this.dimDelta(bucket, v.host, 'exit', v.exit_path, change);
    this.dimDelta(bucket, v.host, 'channel', v.channel, change);
    this.dimDelta(bucket, v.host, 'refsite', v.refsite, change);
    this.dimDelta(bucket, v.host, 'lang', v.lang, change);
    for (const k of UTM_KEYS) this.dimDelta(bucket, v.host, k, v[k], change);
  }

  add(ev) {
    const bucket = hourBucket(ev.ts);
    const host = ev.host;

    this.bump(bucket, host, ev);

    const seen = this.hosts.get(host);
    if (!seen) this.hosts.set(host, [ev.ts, ev.ts]);
    else {
      if (ev.ts < seen[0]) seen[0] = ev.ts;
      if (ev.ts > seen[1]) seen[1] = ev.ts;
    }

    this.dim(bucket, host, 'status', ev.status, ev);
    this.dim(bucket, host, 'method', ev.method, ev);
    this.dim(bucket, host, 'path', ev.path, ev);
    this.dim(bucket, host, 'ip', ev.ip, ev);
    this.dim(bucket, host, 'ua', ev.ua ? ev.ua.slice(0, 256) : '(none)', ev);
    this.dim(bucket, host, 'browser', ev.browser, ev);
    this.dim(bucket, host, 'os', ev.os, ev);
    this.dim(bucket, host, 'device', ev.device, ev);
    this.dim(bucket, host, 'country', ev.country ?? 'XX', ev);
    this.dim(bucket, host, 'referer', ev.referer_host ?? refererHost(ev.referer), ev);
    this.dim(bucket, host, 'proto', ev.proto ?? '(unknown)', ev);
    this.dim(bucket, host, 'tls', ev.tls_version ?? '(none)', ev);
    this.dim(bucket, host, 'cipher', ev.tls_cipher ?? '(none)', ev);
    this.dim(bucket, host, 'ext', extensionOf(ev.path), ev);
    this.dim(bucket, host, 'lat', latencyBucket(ev.dur_ms), ev);
    this.dim(bucket, host, 'kind', ev.bot ? 'bot' : 'human', ev);
    if (ev.asn) {
      this.dim(bucket, host, 'asn', ev.asn, ev);
      if (ev.as_org && !this.asns.has(ev.asn)) this.asns.set(ev.asn, ev.as_org);
    } else {
      this.dim(bucket, host, 'asn', '0', ev);
    }

    this.visit(bucket, host, ev);
  }

  /**
   * Visitor-analytics counters. Page views, not requests — a page that pulls
   * in forty assets is one view — and each page view joins a visit, which
   * carries the channel, referrer and campaign of the page it started on.
   */
  visit(bucket, host, ev) {
    const ref = ev.referer_host ?? (ev.referer ? refererHost(ev.referer) : null);
    if (isPageview(ev)) {
      this.row(bucket, host).pageviews += 1;
      this.dim(bucket, host, 'page', ev.path, ev);
      const refsite = isExternalReferer(host, ref) && ref !== '(unknown)' ? ref : null;
      this.sessions.add(ev, refsite);
    } else if (ev.nav && ev.status === 404 && ref) {
      // A browser followed a link — from your site or someone else's — to a
      // page that does not exist.
      this.dim(bucket, host, 'broken', ev.path, ev);
    }
  }

  flush() {
    const s = prep();
    const now = Date.now();
    this.sessions.persist(now);
    for (const r of this.rollups.values()) s.rollup.run(r);
    for (const d of this.dims.values()) {
      // An exit page that changed twice within the batch nets to nothing.
      if (d.requests || d.bytes || d.errors || d.dur_sum) s.dim.run(d);
    }
    for (const [host, [first, last]] of this.hosts) s.host.run(host, first, last);
    for (const [asn, org] of this.asns) s.asnName.run(asn, org, now);
  }
}

/**
 * Aggregate one batch of pending events.
 * @returns {number} how many events were processed
 */
export function rollupPending(limit = 20000) {
  const db = getDb();
  const s = prep();
  const cutoff = Date.now() - config.ingest.rollupLagMs;
  const rows = s.pick.all(cutoff, limit);
  if (!rows.length) return 0;

  // Late-arriving enrichment: pull anything the background worker resolved
  // since these rows were written, and correct the event rows too.
  const repairs = [];
  const cache = new Map();
  for (const ev of rows) {
    if (ev.asn || !ev.ip) continue;
    let info = cache.get(ev.ip);
    if (info === undefined) {
      info = s.ipInfo.get(ev.ip) ?? null;
      cache.set(ev.ip, info);
    }
    if (info && (info.asn || info.country)) {
      ev.country = ev.country ?? info.country;
      ev.asn = info.asn;
      ev.as_org = info.as_org;
      repairs.push(ev);
    }
  }

  // Rows stored before the visitor columns existed: work them out from the
  // original log line now, and keep the result on the row.
  const visited = [];
  for (const ev of rows) {
    if (ev.nav !== null) continue;
    Object.assign(ev, visitFromRaw(s.raw.get(ev.id)?.raw));
    visited.push(ev);
  }

  const acc = new Accumulator();
  for (const ev of rows) acc.add(ev);

  const run = db.transaction(() => {
    acc.flush();
    for (const ev of repairs) s.fixEvent.run(ev.country ?? null, ev.asn ?? null, ev.as_org ?? null, ev.id);
    for (const ev of visited) s.setVisit.run(visitParams(ev));
    // Rows come back ordered by id, but ids can be sparse after pruning, so
    // mark the exact ids rather than assuming a contiguous range.
    for (const ev of rows) s.markRolledOne.run(ev.id);
  });

  try {
    run();
  } catch (err) {
    log.error('rollup transaction failed', { err: String(err), rows: rows.length });
    throw err;
  }
  return rows.length;
}

/** Visitor columns for a stored row, re-derived from its raw log line. */
function visitFromRaw(raw) {
  const parsed = raw ? parseLine(raw) : null;
  const ev = parsed?.ok ? parsed.event : {};
  const out = {};
  for (const c of VISIT_COLUMNS) out[c] = ev[c] ?? null;
  out.nav ??= 0; // never NULL again, so the row is not revisited
  return out;
}

function visitParams(ev) {
  const p = { id: ev.id };
  for (const c of VISIT_COLUMNS) p[c] = ev[c];
  return p;
}

const BACKFILL_KEY = 'backfill_visits';

/**
 * One chunk of the one-time pass over events stored before the visitor
 * columns existed (see db.js). Rows already rolled up get only the visitor
 * counters added — their request counts are already in. Rows still waiting
 * are left to rollupPending(), which derives the same fields itself. Either
 * way the row's `nav` stops being NULL in the same transaction that counts
 * it, so nothing is counted twice, even across a restart.
 *
 * @returns {number} rows examined; 0 once there is nothing left to do
 */
export function backfillVisits(limit = 5000) {
  const s = prep();
  const marker = s.meta.get(BACKFILL_KEY);
  if (!marker) return 0;
  let state;
  try {
    state = JSON.parse(marker.value);
  } catch {
    s.delMeta.run(BACKFILL_KEY);
    return 0;
  }

  const rows = s.unvisited.all(state.next, state.last, limit);
  const acc = new Accumulator();
  for (const r of rows) {
    Object.assign(r, visitFromRaw(r.raw));
    if (r.rolled) acc.visit(hourBucket(r.ts), r.host, r);
  }
  const next = rows.length ? rows[rows.length - 1].id + 1 : state.last + 1;
  const done = rows.length < limit || next > state.last;

  getDb().transaction(() => {
    acc.flush();
    for (const r of rows) s.setVisit.run(visitParams(r));
    if (done) s.delMeta.run(BACKFILL_KEY);
    else s.setMeta.run(BACKFILL_KEY, JSON.stringify({ next, last: state.last }));
  })();

  if (done) log.info('visitor analytics backfilled from stored requests');
  return rows.length;
}

let timer = null;

export function startRollupLoop(intervalMs = 5000) {
  if (timer) return;
  const tick = () => {
    try {
      // Drain in bounded chunks so a backlog catches up without holding the
      // write lock for an unbounded time.
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const n = rollupPending();
        total += n;
        if (n < 20000) break;
      }
      if (total) log.debug('rolled up events', { count: total });

      // After an upgrade, a bounded slice of the visitor backfill per tick.
      const started = Date.now();
      while (Date.now() - started < 1000 && backfillVisits() > 0) {
        /* keep going within the budget */
      }
    } catch (err) {
      log.error('rollup loop error', { err: String(err) });
    }
  };
  timer = setInterval(tick, intervalMs);
  tick();
}

export function stopRollupLoop() {
  clearInterval(timer);
  timer = null;
}
