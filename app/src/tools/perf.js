// Where the time goes: what the database file holds, and how long each query
// behind the dashboard, Traffic, domain and request pages takes on it.
//
//   docker compose exec app node src/tools/perf.js
//
// Safe to run beside the live app: it only reads (from 1.2.3 on, through a
// read-only connection; on older images, which lack that, through a normal
// one — opening it re-checks the schema, which is already current, and
// records the schema version). Each query runs twice: the first time shows
// the cost when its data is not cached in memory, the second when it is.
// Takes a minute or two on a large database.

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { config } from '../config.js';
import * as store from '../db.js';
import * as Q from '../queries.js';
import { getSettings } from '../settings.js';

const db = store.openReadOnly ? store.openReadOnly() : store.getDb();
const usedBytes = (h) => (h.pragma('page_count', { simple: true }) - h.pragma('freelist_count', { simple: true })) * h.pragma('page_size', { simple: true });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

const mb = (b) => `${(b / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
const n = (v) => Number(v ?? 0).toLocaleString();
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
section('Database file');
console.log(`  ${pad('stats.db', 14)} ${lpad(mb(fileSize(config.dbPath)), 10)}`);
console.log(`  ${pad('stats.db-wal', 14)} ${lpad(mb(fileSize(`${config.dbPath}-wal`)), 10)}`);
const pageSize = db.pragma('page_size', { simple: true });
const freePages = db.pragma('freelist_count', { simple: true });
console.log(`  ${pad('free space', 14)} ${lpad(mb(freePages * pageSize), 10)}  (reusable, from deleted rows)`);

section('Space by table and index');
try {
  const rows = db
    .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 15')
    .all();
  for (const r of rows) console.log(`  ${pad(r.name, 28)} ${lpad(mb(r.bytes), 10)}`);
} catch (err) {
  console.log(`  (not available in this SQLite build: ${err.message})`);
}

section('Stored requests');
const ev = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM events').get();
// Samples, not full scans: the oldest rows are the likeliest to carry their
// log line inline (written before 1.2.3), the newest to have it packed.
const inline = db
  .prepare('SELECT COUNT(raw) AS n, AVG(LENGTH(raw)) AS a FROM (SELECT raw FROM events ORDER BY id LIMIT 20000)')
  .get();
let packed = { n: 0, a: null };
try {
  packed = db
    .prepare('SELECT COUNT(*) AS n, AVG(LENGTH(raw)) AS a FROM (SELECT raw FROM events_raw ORDER BY id DESC LIMIT 20000)')
    .get();
} catch {
  /* before 1.2.3: no events_raw table */
}
const each = (s) => (s.n ? `${n(Math.round(s.a))} bytes each` : 'none');
console.log(`  rows               ${n(ev.n)}`);
console.log(`  spanning           ${((ev.hi - ev.lo) / HOUR).toFixed(1)} hours`);
console.log(`  per hour, average  ${n(Math.round(ev.n / Math.max(1, (ev.hi - ev.lo) / HOUR)))}`);
console.log(`  log line, inline   ${each(inline)}  (oldest 20,000 rows; written before 1.2.3)`);
console.log(`  log line, packed   ${each(packed)}  (newest 20,000 rows)`);
{
  const s = getSettings();
  console.log(`  retention          ${s.rawRetentionHours ? `${n(s.rawRetentionHours)} hours` : 'until the size limit'}`);
  console.log(`  size limit         ${s.maxDbSizeMb ? mb(s.maxDbSizeMb * 1_048_576) : 'none'}  (data held now: ${mb(usedBytes(db))})`);
}

section('Aggregate rows');
for (const r of db.prepare('SELECT gran, COUNT(*) AS n FROM dims GROUP BY gran').all()) {
  console.log(`  dims, ${r.gran === 'h' ? 'hourly' : 'daily '}       ${n(r.n)}`);
}
console.log(`  rollup             ${n(db.prepare('SELECT COUNT(*) AS n FROM rollup').get().n)}`);
console.log(`  domains            ${n(db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n)}`);
for (const [label, since] of [['last 24 hours', now - DAY], ['last 7 days', now - 7 * DAY]]) {
  const rows = db
    .prepare('SELECT dim, COUNT(*) AS n FROM dims WHERE bucket >= ? GROUP BY dim ORDER BY n DESC LIMIT 8')
    .all(Math.floor(since / 1000));
  console.log(`  busiest dimensions, ${label}: ${rows.map((r) => `${r.dim} ${n(r.n)}`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// The queries each page runs, in the order its API endpoint runs them.

const busiest = Q.domains(now - DAY, now)[0]?.host ?? null;
const topIp = Q.topDim('ip', now - DAY, now, { limit: 1, totals: false }).rows[0]?.value ?? null;

const PAGES = {
  Dashboard: (from, to) => [
    ['totals', () => Q.totals(from, to)],
    ['totals, previous period', () => Q.totals(from - (to - from), from)],
    ['series', () => Q.series(from, to)],
    ...['status', 'path', 'ip', 'referer', 'browser', 'kind'].map((d) => [
      `top ${d}`,
      () => Q.topDim(d, from, to, { limit: 10, totals: false }),
    ]),
    ['countries', () => Q.countries(from, to)],
    ['top ASNs', () => Q.topAsns(from, to, { limit: 8 })],
    ['domains', () => Q.domains(from, to)],
    ['latency', () => Q.latency(from, to)],
  ],
  Traffic: (from, to) => [
    ['active visitors', () => Q.activeVisitors()],
    ['totals', () => Q.totals(from, to)],
    ['totals, previous period', () => Q.totals(from - (to - from), from)],
    ['series', () => Q.series(from, to)],
    ['top page (with totals)', () => Q.topDim('page', from, to, { limit: 10 })],
    ...['entry', 'exit', 'channel', 'lang', 'broken', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map(
      (d) => [`top ${d}`, () => Q.topDim(d, from, to, { limit: 10, totals: false })]
    ),
    ['top refsite (with totals)', () => Q.topDim('refsite', from, to, { limit: 10 })],
  ],
  [`Domain detail (${busiest ?? 'none'})`]: (from, to) =>
    busiest
      ? [
          ['totals', () => Q.totals(from, to, busiest)],
          ['totals, previous period', () => Q.totals(from - (to - from), from, busiest)],
          ['series', () => Q.series(from, to, busiest)],
          ['latency', () => Q.latency(from, to, busiest)],
          ['countries', () => Q.countries(from, to, busiest)],
          ['ASNs', () => Q.topAsns(from, to, { host: busiest, limit: 25 })],
          ...['status', 'method', 'path', 'ip', 'ua', 'browser', 'os', 'device', 'referer', 'proto', 'tls', 'cipher', 'ext', 'kind'].map(
            (d) => [`top ${d}`, () => Q.topDim(d, from, to, { host: busiest, limit: 25, totals: false })]
          ),
          ['error paths', () => Q.errorPaths(from, to, busiest)],
        ]
      : [],
};

function timed(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const slowest = [];

section('Query timings  (ms: first run / cached run)');
for (const [range, span] of [['6h', 6 * HOUR], ['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY]]) {
  for (const [page, build] of Object.entries(PAGES)) {
    const steps = build(now - span, now);
    if (!steps.length) continue;
    let cold = 0;
    let warm = 0;
    const lines = [];
    for (const [label, fn] of steps) {
      try {
        const a = timed(fn);
        const b = timed(fn);
        cold += a;
        warm += b;
        lines.push([label, a, b]);
        slowest.push([`${page}, ${range}: ${label}`, a, b]);
      } catch (err) {
        lines.push([`${label} — FAILED: ${err.message}`, 0, 0]);
      }
    }
    console.log(`\n  ${page}, ${range} — ${Math.round(cold)} ms / ${Math.round(warm)} ms in all`);
    for (const [label, a, b] of lines.sort((x, y) => y[1] - x[1]).slice(0, 6)) {
      console.log(`    ${pad(label, 34)} ${lpad(Math.round(a), 7)} / ${lpad(Math.round(b), 6)}`);
    }
  }
}

section('Request explorer  (ms: first run / cached run)');
const searches = [
  ['newest 100, no filter', {}],
  ['text search with no match (worst case)', { q: 'zz-no-such-text-zz' }],
  ['one domain', busiest ? { host: busiest } : null],
  ['bots only', { bots: 'only' }],
  ['status 404', { status: '404' }],
  ['one address (indexed)', topIp ? { ip: topIp } : null],
];
for (const [label, filters] of searches) {
  if (!filters) continue;
  let res;
  const a = timed(() => {
    res = Q.searchEvents(filters, { limit: 100 });
  });
  const b = timed(() => Q.searchEvents(filters, { limit: 100 }));
  const reach = res.searchedBackTo ? `, searched back ${((now - res.searchedBackTo) / HOUR).toFixed(1)}h before stopping` : '';
  console.log(`  ${pad(label, 40)} ${lpad(Math.round(a), 7)} / ${lpad(Math.round(b), 6)}  (${res.rows.length} rows${reach})`);
  slowest.push([`Requests: ${label}`, a, b]);
}
if (topIp) {
  const a = timed(() => Q.ipDetail(topIp, now - DAY, now));
  const b = timed(() => Q.ipDetail(topIp, now - DAY, now));
  console.log(`  ${pad(`address page (${topIp})`, 40)} ${lpad(Math.round(a), 7)} / ${lpad(Math.round(b), 6)}`);
  slowest.push([`Address page: ${topIp}`, a, b]);
}

section('Slowest 10 overall  (ms: first run / cached run)');
for (const [label, a, b] of slowest.sort((x, y) => y[1] - x[1]).slice(0, 10)) {
  console.log(`  ${pad(label, 60)} ${lpad(Math.round(a), 7)} / ${lpad(Math.round(b), 6)}`);
}

section('Query plan for a typical top-10 list');
for (const r of db
  .prepare(
    `EXPLAIN QUERY PLAN
     SELECT value, SUM(requests) FROM dims
      WHERE gran IN ('h', 'd') AND dim = 'path' AND bucket >= ? AND bucket < ?
      GROUP BY value ORDER BY 2 DESC LIMIT 10`
  )
  .all(Math.floor((now - DAY) / 1000), Math.ceil(now / 1000))) {
  console.log(`  ${r.detail}`);
}
console.log('');
