// Retention, downsampling and compaction.
//
// Three independent knobs, all from .env:
//   RAW_RETENTION_HOURS   individual request rows (live stream, drill-downs)
//   HOURLY_RETENTION_DAYS hourly aggregates, folded into daily rows when older
//   RETENTION_DAYS        daily aggregates — the long-term history
//
// Because aggregates live in SQLite and are checkpointed independently of the
// log files, rotating or deleting a Caddy log never loses statistics.

import { getDb } from './db.js';
import { config } from './config.js';
import { logger } from './util/log.js';
import { DAY, oldestOpenVisitHour } from './ingest/rollup.js';
import { SALT_PREFIX, forgetSalts } from './ingest/visits.js';

const log = logger('maintain');

let timer = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Hours before this (epoch seconds) are left alone by folding and compaction:
 * a visit still open there will change its counters again, and those changes
 * must land on the rows they were first added to. Only an old-log backfill
 * puts open visits this far back.
 */
function settledBefore() {
  return oldestOpenVisitHour() ?? Infinity;
}

/**
 * Fold hourly rows older than the hourly window into daily rows. The day's
 * visitor ids go at the same time: from then on rollup.visitors, exact for
 * whole days, answers for that day (see seenVisitors in queries.js).
 */
function foldHourlyToDaily(db) {
  const cutoff = Math.min(nowSec() - config.retention.hourlyDays * DAY, settledBefore());
  const boundary = Math.floor(cutoff / DAY) * DAY;

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM rollup WHERE gran = 'h' AND bucket < ?`)
    .get(boundary).n;
  if (!pending) {
    db.prepare('DELETE FROM visitor_seen WHERE bucket < ?').run(boundary);
    return 0;
  }

  const fold = db.transaction(() => {
    db.prepare(
      `INSERT INTO rollup (bucket, gran, host, requests, bytes_out, bytes_in, dur_sum,
                           dur_max, c1xx, c2xx, c3xx, c4xx, c5xx, bots, pageviews,
                           visits, visitors, bounces, visit_ms)
       SELECT CAST(bucket / ${DAY} AS INTEGER) * ${DAY}, 'd', host,
              SUM(requests), SUM(bytes_out), SUM(bytes_in), SUM(dur_sum),
              MAX(dur_max), SUM(c1xx), SUM(c2xx), SUM(c3xx), SUM(c4xx), SUM(c5xx), SUM(bots),
              SUM(pageviews), SUM(visits), SUM(visitors), SUM(bounces), SUM(visit_ms)
         FROM rollup
        WHERE gran = 'h' AND bucket < ?
        GROUP BY 1, host
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
    ).run(boundary);

    db.prepare(
      `INSERT INTO dims (bucket, gran, host, dim, value, requests, bytes, errors, dur_sum)
       SELECT CAST(bucket / ${DAY} AS INTEGER) * ${DAY}, 'd', host, dim, value,
              SUM(requests), SUM(bytes), SUM(errors), SUM(dur_sum)
         FROM dims
        WHERE gran = 'h' AND bucket < ?
        GROUP BY 1, host, dim, value
       ON CONFLICT(bucket, gran, host, dim, value) DO UPDATE SET
         requests = dims.requests + excluded.requests,
         bytes    = dims.bytes    + excluded.bytes,
         errors   = dims.errors   + excluded.errors,
         dur_sum  = dims.dur_sum  + excluded.dur_sum`
    ).run(boundary);

    db.prepare(`DELETE FROM rollup WHERE gran = 'h' AND bucket < ?`).run(boundary);
    db.prepare(`DELETE FROM dims   WHERE gran = 'h' AND bucket < ?`).run(boundary);
    db.prepare('DELETE FROM visitor_seen WHERE bucket < ?').run(boundary);
  });

  fold();
  log.info('folded hourly rows into daily', { boundary, rows: pending });
  return pending;
}

/** Dimensions whose values are unbounded, and so are trimmed. */
const WIDE_DIMS = [
  'path', 'ip', 'ua', 'referer',
  'page', 'entry', 'exit', 'refsite', 'lang', 'broken',
  'utm_source', 'utm_campaign', 'utm_term', 'utm_content',
];

// The values one bucket keeps: its top N by requests, plus its top N by
// errors, so the error lists keep their worst offenders even when those are
// rarely requested. `@bucket @gran @host @dim @topN`.
const IN_BUCKET = 'bucket = @bucket AND gran = @gran AND host = @host AND dim = @dim';
const KEPT = `
  SELECT value FROM (SELECT value FROM dims WHERE ${IN_BUCKET} AND value <> '(other)'
                      ORDER BY requests DESC LIMIT @topN)
  UNION
  SELECT value FROM (SELECT value FROM dims WHERE ${IN_BUCKET} AND value <> '(other)' AND errors > 0
                      ORDER BY errors DESC LIMIT @topN)`;

/**
 * Trim wide dimensions to the values worth keeping (see KEPT), folding the
 * rest of each bucket into a single "(other)" row so totals stay exact.
 *
 * Two passes. Buckets older than DIM_COMPACT_AFTER_DAYS are trimmed once
 * they hold more than DIM_TOP_N values. Before that, only a bucket that has
 * exploded — more than DIM_HOURLY_MAX values, as an API answering
 * /lookup/<anything> produces, every lookup a new URL — is trimmed, as soon
 * as its hour is over (DIM_COMPACT_AFTER_HOURS). Ordinary sites keep every
 * value for the week, so distinct counts stay exact; one exploding site no
 * longer makes every list read a million rows.
 *
 * Hours with visits still open are left alone (settledBefore), and the work
 * stops after `budgetMs`, to resume on the next run.
 */
function compactDims(db, { early = true, late = true, budgetMs = 20_000 } = {}) {
  const started = Date.now();
  const topN = config.retention.dimTopN;
  // The early pass first: it is the one the pages are waiting on.
  const passes = [];
  if (early) {
    const thisHour = Math.floor(nowSec() / 3600) * 3600;
    passes.push({
      cutoff: Math.min(thisHour - (config.retention.dimCompactAfterHours - 1) * 3600, settledBefore()),
      over: Math.max(topN, config.retention.dimHourlyMax),
    });
  }
  if (late) {
    passes.push({
      cutoff: Math.min(nowSec() - config.retention.dimCompactAfterDays * DAY, settledBefore()),
      over: topN,
    });
  }

  const groupsOf = db.prepare(
    `SELECT bucket, gran, host, COUNT(*) AS n
       FROM dims
      WHERE gran IN ('h', 'd') AND dim = ? AND bucket < ? AND value <> '(other)'
      GROUP BY bucket, gran, host
     HAVING n > ?
      LIMIT 500`
  );
  const surplusOf = db.prepare(
    `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes),0) AS bytes,
            COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(dur_sum),0) AS dur_sum
       FROM dims
      WHERE ${IN_BUCKET} AND value <> '(other)' AND value NOT IN (${KEPT})`
  );
  const drop = db.prepare(
    `DELETE FROM dims WHERE ${IN_BUCKET} AND value <> '(other)' AND value NOT IN (${KEPT})`
  );
  const addOther = db.prepare(
    `INSERT INTO dims (bucket, gran, host, dim, value, requests, bytes, errors, dur_sum)
       VALUES (@bucket, @gran, @host, @dim, '(other)', @requests, @bytes, @errors, @dur_sum)
     ON CONFLICT(bucket, gran, host, dim, value) DO UPDATE SET
       requests = dims.requests + excluded.requests,
       bytes    = dims.bytes    + excluded.bytes,
       errors   = dims.errors   + excluded.errors,
       dur_sum  = dims.dur_sum  + excluded.dur_sum`
  );

  let compacted = 0;
  let removed = 0;
  outer: for (const { cutoff, over } of passes) {
    for (const dim of WIDE_DIMS) {
      for (const { bucket, gran, host } of groupsOf.all(dim, cutoff, over)) {
        if (Date.now() - started > budgetMs) break outer;
        // Only named parameters a statement uses may be bound (better-sqlite3).
        const g = { bucket, gran, host, dim, topN };
        db.transaction(() => {
          const surplus = surplusOf.get(g);
          removed += drop.run(g).changes;
          if (surplus.requests || surplus.bytes || surplus.errors || surplus.dur_sum) {
            addOther.run({ bucket, gran, host, dim, ...surplus });
          }
        })();
        compacted += 1;
      }
    }
  }
  if (compacted) log.info('compacted dimension buckets', { groups: compacted, rows: removed });
  return compacted;
}

/** Delete data past its retention window. */
function prune(db) {
  const out = {};

  const rawCutoff = Date.now() - config.retention.rawHours * 3_600_000;
  // Only prune events that have already been aggregated, so a rollup backlog
  // can never cause silent data loss.
  out.events = db
    .prepare('DELETE FROM events WHERE ts < ? AND rolled = 1')
    .run(rawCutoff).changes;

  // Safety valve on row count, independent of age.
  const count = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  if (count > config.retention.rawMaxRows) {
    const excess = count - config.retention.rawMaxRows;
    out.eventsOverflow = db
      .prepare(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events WHERE rolled = 1 ORDER BY id LIMIT ?
         )`
      )
      .run(excess).changes;
  }

  // Their original log lines. Both deletions above take the oldest rows, and
  // ids only grow, so everything below the oldest remaining id is unneeded.
  out.eventsRaw = db
    .prepare('DELETE FROM events_raw WHERE id < (SELECT COALESCE(MIN(id), 9e18) FROM events)')
    .run().changes;

  const dailyCutoff = nowSec() - config.retention.days * DAY;
  out.rollup = db.prepare('DELETE FROM rollup WHERE bucket < ?').run(dailyCutoff).changes;
  out.dims = db.prepare('DELETE FROM dims WHERE bucket < ?').run(dailyCutoff).changes;

  // Hosts with no remaining data disappear from the domains list.
  out.hosts = db
    .prepare('DELETE FROM hosts WHERE host NOT IN (SELECT DISTINCT host FROM rollup)')
    .run().changes;

  // Visit state. A closed visit can no longer grow, but its row also answers
  // "has this visitor been here today?", so it stays a day. One still open
  // after a week means closing is stuck; it is not kept forever either.
  out.visits = db
    .prepare('DELETE FROM visits WHERE touched < ? AND (closed = 1 OR touched < ?)')
    .run(Date.now() - 26 * 3_600_000, Date.now() - 7 * 86_400_000).changes;

  // Visitor salts, once no stored request from that day can still need one.
  // Afterwards that day's visitor ids cannot be recomputed from an address.
  const keepDays = Math.ceil(config.retention.rawHours / 24) + 2;
  const oldestDay = Math.floor(Date.now() / 86_400_000) - keepDays;
  const dropSalt = db.prepare('DELETE FROM meta WHERE key = ?');
  out.salts = 0;
  for (const { key } of db.prepare('SELECT key FROM meta WHERE key LIKE ?').all(`${SALT_PREFIX}%`)) {
    if (Number(key.slice(SALT_PREFIX.length)) < oldestDay) out.salts += dropSalt.run(key).changes;
  }
  if (out.salts) forgetSalts();

  out.sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
  out.logins = db
    .prepare('DELETE FROM login_attempts WHERE ts < ?')
    .run(Date.now() - 7 * 86_400_000).changes;
  out.ipInfo = db
    .prepare('DELETE FROM ip_info WHERE updated_at < ?')
    .run(Date.now() - Math.max(config.enrich.ttlDays * 4, 90) * 86_400_000).changes;
  out.ingestStats = db
    .prepare('DELETE FROM ingest_stats WHERE day < ?')
    .run(nowSec() - 90 * DAY).changes;

  return out;
}

export function runMaintenance() {
  const db = getDb();
  try {
    const pruned = prune(db);
    foldHourlyToDaily(db);
    compactDims(db);
    db.pragma('wal_checkpoint(PASSIVE)');
    db.prepare('PRAGMA optimize').run();
    log.info('maintenance complete', pruned);
  } catch (err) {
    log.error('maintenance failed', { err: String(err), stack: err?.stack });
  }
}

/** Between full runs, keep exploding dimensions trimmed (see compactDims). */
function runEarlyCompaction() {
  try {
    compactDims(getDb(), { late: false });
  } catch (err) {
    log.error('compaction failed', { err: String(err) });
  }
}

let earlyTimer = null;

export function startMaintenance() {
  if (timer) return;
  // Stagger the first run so it does not collide with ingest warm-up.
  setTimeout(runMaintenance, 60_000);
  timer = setInterval(runMaintenance, 3600_000);
  earlyTimer = setInterval(runEarlyCompaction, 10 * 60_000);
}

export function stopMaintenance() {
  clearInterval(timer);
  clearInterval(earlyTimer);
  timer = null;
  earlyTimer = null;
}
