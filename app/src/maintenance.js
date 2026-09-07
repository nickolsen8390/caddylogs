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
import { DAY } from './ingest/rollup.js';

const log = logger('maintain');

let timer = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Fold hourly rows older than the hourly window into daily rows. */
function foldHourlyToDaily(db) {
  const cutoff = nowSec() - config.retention.hourlyDays * DAY;
  const boundary = Math.floor(cutoff / DAY) * DAY;

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM rollup WHERE gran = 'h' AND bucket < ?`)
    .get(boundary).n;
  if (!pending) return 0;

  const fold = db.transaction(() => {
    db.prepare(
      `INSERT INTO rollup (bucket, gran, host, requests, bytes_out, bytes_in, dur_sum,
                           dur_max, c1xx, c2xx, c3xx, c4xx, c5xx, bots)
       SELECT CAST(bucket / ${DAY} AS INTEGER) * ${DAY}, 'd', host,
              SUM(requests), SUM(bytes_out), SUM(bytes_in), SUM(dur_sum),
              MAX(dur_max), SUM(c1xx), SUM(c2xx), SUM(c3xx), SUM(c4xx), SUM(c5xx), SUM(bots)
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
         bots = rollup.bots + excluded.bots`
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
  });

  fold();
  log.info('folded hourly rows into daily', { boundary, rows: pending });
  return pending;
}

/**
 * Trim high-cardinality dimensions on older buckets to the top N values,
 * folding everything else into a single "(other)" row so totals stay exact.
 */
function compactDims(db) {
  const cutoff = nowSec() - config.retention.dimCompactAfterDays * DAY;
  const topN = config.retention.dimTopN;
  const wide = ['path', 'ip', 'ua', 'referer'];
  let compacted = 0;

  for (const dim of wide) {
    const groups = db
      .prepare(
        `SELECT bucket, gran, host, COUNT(*) AS n
           FROM dims
          WHERE dim = ? AND bucket < ? AND value <> '(other)'
          GROUP BY bucket, gran, host
         HAVING n > ?
          LIMIT 500`
      )
      .all(dim, cutoff, topN);

    for (const { bucket, gran, host } of groups) {
      // Only the three key columns may be bound: better-sqlite3 rejects an
      // object carrying a name the statement does not use (the COUNT alias).
      const g = { bucket, gran, host };
      const run = db.transaction(() => {
        const surplus = db
          .prepare(
            `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes),0) AS bytes,
                    COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(dur_sum),0) AS dur_sum
               FROM (SELECT requests, bytes, errors, dur_sum FROM dims
                      WHERE bucket = @bucket AND gran = @gran AND host = @host
                        AND dim = @dim AND value <> '(other)'
                      ORDER BY requests DESC
                      LIMIT -1 OFFSET @topN)`
          )
          .get({ ...g, dim, topN });

        db.prepare(
          `DELETE FROM dims
            WHERE bucket = @bucket AND gran = @gran AND host = @host AND dim = @dim
              AND value IN (SELECT value FROM dims
                             WHERE bucket = @bucket AND gran = @gran AND host = @host
                               AND dim = @dim AND value <> '(other)'
                             ORDER BY requests DESC
                             LIMIT -1 OFFSET @topN)`
        ).run({ ...g, dim, topN });

        if (surplus.requests > 0) {
          db.prepare(
            `INSERT INTO dims (bucket, gran, host, dim, value, requests, bytes, errors, dur_sum)
               VALUES (@bucket, @gran, @host, @dim, '(other)', @requests, @bytes, @errors, @dur_sum)
             ON CONFLICT(bucket, gran, host, dim, value) DO UPDATE SET
               requests = dims.requests + excluded.requests,
               bytes    = dims.bytes    + excluded.bytes,
               errors   = dims.errors   + excluded.errors,
               dur_sum  = dims.dur_sum  + excluded.dur_sum`
          ).run({ ...g, dim, ...surplus });
        }
      });
      run();
      compacted += 1;
    }
  }
  if (compacted) log.info('compacted dimension buckets', { groups: compacted });
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

  const dailyCutoff = nowSec() - config.retention.days * DAY;
  out.rollup = db.prepare('DELETE FROM rollup WHERE bucket < ?').run(dailyCutoff).changes;
  out.dims = db.prepare('DELETE FROM dims WHERE bucket < ?').run(dailyCutoff).changes;

  // Hosts with no remaining data disappear from the domains list.
  out.hosts = db
    .prepare('DELETE FROM hosts WHERE host NOT IN (SELECT DISTINCT host FROM rollup)')
    .run().changes;

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

export function startMaintenance() {
  if (timer) return;
  // Stagger the first run so it does not collide with ingest warm-up.
  setTimeout(runMaintenance, 60_000);
  timer = setInterval(runMaintenance, 3600_000);
}

export function stopMaintenance() {
  clearInterval(timer);
  timer = null;
}
