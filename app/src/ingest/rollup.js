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
import { extensionOf, refererHost, latencyBucket } from './parser.js';

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
              country, asn, as_org
         FROM events
        WHERE rolled = 0 AND ts < ?
        ORDER BY id
        LIMIT ?`
    ),
    markRolledOne: db.prepare('UPDATE events SET rolled = 1 WHERE id = ?'),
    ipInfo: db.prepare('SELECT ip, country, asn, as_org FROM ip_info WHERE ip = ?'),
    fixEvent: db.prepare('UPDATE events SET country = ?, asn = ?, as_org = ? WHERE id = ?'),
    rollup: db.prepare(
      `INSERT INTO rollup (bucket, gran, host, requests, bytes_out, bytes_in, dur_sum,
                           dur_max, c1xx, c2xx, c3xx, c4xx, c5xx, bots)
         VALUES (@bucket, @gran, @host, @requests, @bytes_out, @bytes_in, @dur_sum,
                 @dur_max, @c1xx, @c2xx, @c3xx, @c4xx, @c5xx, @bots)
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
         bots = rollup.bots + excluded.bots`
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

/** Accumulator that collapses a batch of events before touching the database. */
class Accumulator {
  constructor() {
    this.rollups = new Map(); // bucket+host -> counters
    this.dims = new Map(); // bucket+host+dim+value -> counters
    this.hosts = new Map(); // host -> [first, last]
    this.asns = new Map(); // asn -> org
  }

  bump(bucket, host, ev) {
    const key = `${bucket}${SEP}${host}`;
    let r = this.rollups.get(key);
    if (!r) {
      r = {
        bucket, gran: 'h', host,
        requests: 0, bytes_out: 0, bytes_in: 0, dur_sum: 0, dur_max: 0,
        c1xx: 0, c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0, bots: 0,
      };
      this.rollups.set(key, r);
    }
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
    if (value === null || value === undefined || value === '') return;
    const v = String(value).slice(0, 512);
    const key = `${bucket}${SEP}${host}${SEP}${dim}${SEP}${v}`;
    let d = this.dims.get(key);
    if (!d) {
      d = { bucket, gran: 'h', host, dim, value: v, requests: 0, bytes: 0, errors: 0, dur_sum: 0 };
      this.dims.set(key, d);
    }
    d.requests += 1;
    d.bytes += ev.bytes_out || 0;
    if ((ev.status || 0) >= 400) d.errors += 1;
    d.dur_sum += ev.dur_ms ?? 0;
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
  }

  flush() {
    const s = prep();
    const now = Date.now();
    for (const r of this.rollups.values()) s.rollup.run(r);
    for (const d of this.dims.values()) s.dim.run(d);
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

  const acc = new Accumulator();
  for (const ev of rows) acc.add(ev);

  const run = db.transaction(() => {
    acc.flush();
    for (const ev of repairs) s.fixEvent.run(ev.country ?? null, ev.asn ?? null, ev.as_org ?? null, ev.id);
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
