// Retention, downsampling, compaction and the size limit.
//
//   raw request retention  Settings page (RAW_RETENTION_HOURS in .env to start)
//                          — individual requests: live view, drill-downs
//   database size limit    Settings page (MAX_DB_SIZE) — overrides the rest
//   HOURLY_RETENTION_DAYS  hourly aggregates, folded into daily rows when older
//   RETENTION_DAYS         daily aggregates — the long-term history
//
// Because aggregates live in SQLite and are checkpointed independently of the
// log files, rotating or deleting a Caddy log never loses statistics.

import { getDb, usedBytes } from './db.js';
import { config } from './config.js';
import { logger } from './util/log.js';
import { DAY, oldestOpenVisitHour } from './ingest/rollup.js';
import { SALT_PREFIX, VISIT_KEEP_MS, forgetSalts } from './ingest/visits.js';
import { rawRetentionMs, maxDbBytes } from './settings.js';

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

/**
 * Original log lines whose request is gone. Requests are pruned oldest first
 * and ids only grow, so that is everything below the oldest remaining id.
 */
function dropOrphanedRaw(db) {
  return db
    .prepare('DELETE FROM events_raw WHERE id < (SELECT COALESCE(MIN(id), 9e18) FROM events)')
    .run().changes;
}

/**
 * Stored requests past the retention time (none, when they are kept until
 * the size limit). Only requests already aggregated are pruned, so a rollup
 * backlog can never cause silent data loss.
 */
function pruneRequests(db) {
  const keepMs = rawRetentionMs();
  const events = Number.isFinite(keepMs)
    ? db.prepare('DELETE FROM events WHERE ts < ? AND rolled = 1').run(Date.now() - keepMs).changes
    : 0;
  return { events, eventsRaw: dropOrphanedRaw(db) };
}

const SIZE_CHUNK = 20_000; // stored requests deleted per step
const KEEP_REQUESTS_MS = 3_600_000; // never below the last hour of requests
const KEEP_AGGREGATES_DAYS = 7; // nor the last week of statistics
let warnedTooSmall = 0;
let warnedBehind = 0;

/**
 * Hold the database under the size limit from the Settings page, whatever
 * the retention settings say: the oldest stored requests go first, then —
 * only if those are down to their last hour — the oldest days of statistics.
 * Trims to 95% of the limit so it is not hit again within minutes.
 *
 * The limit is on the data held, not the file: SQLite reuses freed space but
 * does not shrink the file, so the file settles at about the limit and stays
 * there (src/tools/vacuum.js gives space back after a limit is lowered).
 */
export function enforceSizeLimit(db, { budgetMs = 30_000 } = {}) {
  const limit = maxDbBytes();
  if (!limit) return null;
  let used = usedBytes(db);
  if (used <= limit) return null;

  const started = Date.now();
  const before = used;
  const target = limit * 0.95;
  const out = { requests: 0, statDays: 0 };
  const oldestRequests = db.prepare(
    `DELETE FROM events WHERE id IN (
       SELECT id FROM events WHERE rolled = 1 AND ts < ? ORDER BY id LIMIT ${SIZE_CHUNK})`
  );
  const rollupBehind = db.prepare('SELECT 1 FROM events WHERE rolled = 0 AND ts < ? LIMIT 1');

  while (used > target && Date.now() - started < budgetMs) {
    const n = oldestRequests.run(Date.now() - KEEP_REQUESTS_MS).changes;
    if (n) {
      out.requests += n;
      dropOrphanedRaw(db);
    } else if (rollupBehind.get(Date.now() - KEEP_REQUESTS_MS)) {
      // Older requests are there, but not counted yet: they go once they
      // are. Taking days of statistics instead would lose them for nothing.
      if (Date.now() - warnedBehind > 3_600_000) {
        warnedBehind = Date.now();
        log.warn('over the database size limit, but the oldest requests are not counted into the statistics yet', {
          limitMb: Math.round(limit / 1_048_576),
          usedMb: Math.round(used / 1_048_576),
        });
      }
      break;
    } else {
      // Requests are down to their last hour: the oldest day of statistics.
      const oldest = db.prepare('SELECT MIN(bucket) AS b FROM rollup').get().b;
      const floor = nowSec() - KEEP_AGGREGATES_DAYS * DAY;
      if (oldest === null || oldest >= floor) {
        if (Date.now() - warnedTooSmall > 6 * 3_600_000) {
          warnedTooSmall = Date.now();
          log.warn('database size limit is too small to keep the last hour of requests and the last week of statistics', {
            limitMb: Math.round(limit / 1_048_576),
            usedMb: Math.round(used / 1_048_576),
          });
        }
        break;
      }
      const end = Math.floor(oldest / DAY) * DAY + DAY;
      db.transaction(() => {
        for (const table of ['rollup', 'dims', 'visitor_seen']) {
          db.prepare(`DELETE FROM ${table} WHERE bucket < ?`).run(end);
        }
      })();
      out.statDays += 1;
    }
    used = usedBytes(db);
  }

  db.pragma('wal_checkpoint(PASSIVE)');
  log.info('pruned to the database size limit', {
    limitMb: Math.round(limit / 1_048_576),
    beforeMb: Math.round(before / 1_048_576),
    afterMb: Math.round(used / 1_048_576),
    ...out,
    done: used <= target,
  });
  return out;
}

/** Delete data past its retention window. */
function prune(db) {
  const out = {};

  Object.assign(out, pruneRequests(db));

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
    .run(Date.now() - VISIT_KEEP_MS, Date.now() - 7 * 86_400_000).changes;

  // Visitor salts, once no stored request from that day can still need one
  // (re-reading a stored request can derive its visitor again). Afterwards
  // that day's visitor ids cannot be recomputed from an address.
  const oldestStored = db.prepare('SELECT MIN(ts) AS ts FROM events').get().ts ?? Date.now();
  const oldestDay = Math.min(Math.floor(oldestStored / 86_400_000), Math.floor(Date.now() / 86_400_000) - 2);
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
    enforceSizeLimit(db);
    db.pragma('wal_checkpoint(PASSIVE)');
    db.prepare('PRAGMA optimize').run();
    log.info('maintenance complete', pruned);
  } catch (err) {
    log.error('maintenance failed', { err: String(err), stack: err?.stack });
  }
}

/**
 * Between full runs: keep exploding dimensions trimmed (see compactDims), and
 * apply the retention time — a change on the Settings page should not wait
 * for the next full run.
 */
function runFrequent() {
  try {
    const db = getDb();
    compactDims(db, { late: false });
    pruneRequests(db);
  } catch (err) {
    log.error('frequent maintenance failed', { err: String(err) });
  }
}

/**
 * The size limit, every minute: a busy server writes gigabytes an hour, and
 * checking costs next to nothing while under the limit. Over it, each run
 * prunes for at most 15 s, so ingest keeps most of every minute.
 */
function runSizeLimit() {
  try {
    enforceSizeLimit(getDb(), { budgetMs: 15_000 });
  } catch (err) {
    log.error('size limit check failed', { err: String(err) });
  }
}

let frequentTimer = null;
let sizeTimer = null;

export function startMaintenance() {
  if (timer) return;
  if (config.retention.legacyMaxRows !== null) {
    log.warn('RAW_MAX_ROWS is no longer used; limit the database by size on the Settings page (or MAX_DB_SIZE in .env)', {
      RAW_MAX_ROWS: config.retention.legacyMaxRows,
    });
  }
  // Stagger the first run so it does not collide with ingest warm-up.
  setTimeout(runMaintenance, 60_000);
  timer = setInterval(runMaintenance, 3600_000);
  frequentTimer = setInterval(runFrequent, 10 * 60_000);
  sizeTimer = setInterval(runSizeLimit, 60_000);
}

export function stopMaintenance() {
  clearInterval(timer);
  clearInterval(frequentTimer);
  clearInterval(sizeTimer);
  timer = null;
  frequentTimer = null;
  sizeTimer = null;
}
