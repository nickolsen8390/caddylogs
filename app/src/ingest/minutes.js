// The per-minute counters and the client-address sketches (schema.sql:
// rollup_minute, ip_sketch) for requests counted before they existed, built
// once from the requests still stored. Run by db.js on upgrade, before the
// ingester starts, so every request counted so far is in exactly once: it
// takes only those already rolled up, and the rollup counts the rest.

import { PAGEVIEW_SQL } from './traffic.js';
import { addPlace, encode, mergeEncoded, newSketch, placeOf } from '../util/hll.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Days the per-minute counters and sketches are kept. */
export const MINUTE_KEEP_DAYS = 7;

/** @param {import('better-sqlite3').Database} db  @returns {number} requests read */
export function buildMinutesFromEvents(db) {
  db.prepare(
    `INSERT INTO rollup_minute (bucket, host, requests, bytes_out, bytes_in, dur_sum, dur_max,
                                c1xx, c2xx, c3xx, c4xx, c5xx, bots, pageviews)
     SELECT CAST(ts / ${MINUTE_MS} AS INTEGER) * 60, host, COUNT(*),
            COALESCE(SUM(bytes_out),0), COALESCE(SUM(bytes_in),0),
            COALESCE(SUM(dur_ms),0), COALESCE(MAX(dur_ms),0),
            COALESCE(SUM(status / 100 = 1),0), COALESCE(SUM(status / 100 = 2),0),
            COALESCE(SUM(status / 100 = 3),0), COALESCE(SUM(status / 100 = 4),0),
            COALESCE(SUM(status / 100 = 5),0), COALESCE(SUM(bot != 0),0),
            COALESCE(SUM(${PAGEVIEW_SQL}),0)
       FROM events WHERE rolled = 1
      GROUP BY 1, 2
     ON CONFLICT(bucket, host) DO NOTHING`
  ).run();

  const get = db.prepare('SELECT regs FROM ip_sketch WHERE gran = ? AND host = ? AND bucket = ?');
  const set = db.prepare(
    `INSERT INTO ip_sketch (bucket, gran, host, regs) VALUES (?, ?, ?, ?)
     ON CONFLICT(gran, host, bucket) DO UPDATE SET regs = excluded.regs`
  );
  const open = new Map(); // gran+bucket+host -> [gran, bucket, host, registers, last ts]
  const write = ([gran, bucket, host, regs]) => {
    mergeEncoded(regs, get.get(gran, host, bucket)?.regs);
    set.run(bucket, gran, host, encode(regs));
  };

  // In storage order, which is close to time order: sketches are written
  // once their bucket is well behind, so few are held at a time. A request
  // out of order still lands right, merged into what was written.
  // Pages by id: nothing else can run on the connection while a query is
  // being read row by row.
  const page = db.prepare('SELECT id, ts, host, ip FROM events WHERE id > ? AND rolled = 1 ORDER BY id LIMIT 50000');
  let read = 0;
  let oldest = Infinity;
  for (let after = -Infinity; ; ) {
    const rows = page.all(after);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    let newest = -Infinity;
    for (const { ts, host, ip } of rows) {
      read += 1;
      if (ts < oldest) oldest = ts;
      if (ts > newest) newest = ts;
      if (!ip) continue;
      const place = placeOf(ip);
      const minute = Math.floor(ts / MINUTE_MS) * 60;
      const hour = Math.floor(ts / HOUR_MS) * 3600;
      for (const [gran, bucket, h] of [['m', minute, host], ['m', minute, ''], ['h', hour, host], ['h', hour, '']]) {
        const key = `${gran}|${bucket}|${h}`;
        let s = open.get(key);
        if (!s) open.set(key, (s = [gran, bucket, h, newSketch(), ts]));
        addPlace(s[3], place);
        if (ts > s[4]) s[4] = ts;
      }
    }
    for (const [key, s] of open) {
      if (newest - s[4] > 2 * HOUR_MS) {
        write(s);
        open.delete(key);
      }
    }
  }
  for (const s of open.values()) write(s);

  // The oldest hour is partly pruned already; its addresses are also in the
  // hourly ip rows (some, when trimmed).
  if (Number.isFinite(oldest)) {
    const hour = Math.floor(oldest / HOUR_MS) * 3600;
    const byHost = new Map();
    for (const { host, value } of db
      .prepare(`SELECT host, value FROM dims WHERE gran = 'h' AND dim = 'ip' AND bucket = ? AND value <> '(other)'`)
      .iterate(hour)) {
      const place = placeOf(value);
      for (const h of [host, '']) {
        if (!byHost.has(h)) byHost.set(h, newSketch());
        addPlace(byHost.get(h), place);
      }
    }
    for (const [h, regs] of byHost) write(['h', hour, h, regs]);
  }
  return read;
}
