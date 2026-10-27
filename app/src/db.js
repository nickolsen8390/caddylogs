import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './util/log.js';

const log = logger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;

const BUSY_TIMEOUT_MS = 10_000;
/** The write-ahead log is emptied once it passes this, and cut back to it. */
const WAL_LIMIT = 64 * 1_048_576;

/**
 * Bind mounts keep the host's ownership, so a mismatch between the container
 * UID and the directory owner is the most likely first-run failure. Check it
 * up front and say exactly how to fix it, rather than letting SQLite fail with
 * a bare SQLITE_CANTOPEN several frames later.
 */
function assertWritableDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fatalDataDir(dir, `cannot create it: ${err.message}`);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    fatalDataDir(dir, 'it exists but is not writable by this container');
  }
}

function fatalDataDir(dir, why) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  const gid = typeof process.getgid === 'function' ? process.getgid() : '?';
  console.error(
    [
      `[db] FATAL: the data directory ${dir} is unusable — ${why}.`,
      `[db] This container runs as UID ${uid}:${gid}, and bind mounts keep the`,
      `[db] host directory's ownership. On the host, run:`,
      `[db]`,
      `[db]     mkdir -p <DATA_PATH> && sudo chown -R ${uid}:${gid} <DATA_PATH>`,
      `[db]`,
      `[db] where <DATA_PATH> is the value set in .env (default ./data).`,
      `[db] Alternatively set PUID/PGID in .env to the owner of that directory.`,
    ].join('\n')
  );
  process.exit(1);
}

export function getDb() {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  assertWritableDataDir(dir);
  db = new Database(config.dbPath);

  // WAL lets the ingest writer and the web reader run concurrently.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // ~64 MiB page cache
  db.pragma('mmap_size = 268435456');
  // After a checkpoint resets the log, cut the file back to this size: without
  // it the WAL file stays as large as it ever grew.
  db.pragma(`journal_size_limit = ${WAL_LIMIT}`);

  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  migrate(db);

  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version','2')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();

  log.info('database ready', { path: config.dbPath });
  return db;
}

/**
 * Additive migrations. `CREATE TABLE IF NOT EXISTS` never alters an existing
 * table, so any column added after the first release has to be applied here or
 * upgrades silently keep the old shape.
 */
function migrate(db) {
  const columns = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

  const events = columns('events');
  if (!events.has('referer_host')) {
    // Stored alongside the full referer so drilling into "who links here" is an
    // indexed equality match rather than a LIKE across every row.
    db.exec('ALTER TABLE events ADD COLUMN referer_host TEXT');
    log.info('migration: added events.referer_host');
  }

  if (!events.has('nav')) {
    // Visitor analytics (1.2.0). Rows already stored are worked out from their
    // raw log line, and grouped into visits, by the rollup loop
    // (backfillVisits), so the Traffic page starts with the raw window's worth
    // of history instead of empty.
    for (const col of ['nav INTEGER', 'channel TEXT', 'lang TEXT', 'utm_source TEXT',
      'utm_medium TEXT', 'utm_campaign TEXT', 'utm_term TEXT', 'utm_content TEXT']) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col}`);
    }
    const r = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM events').get();
    if (r.hi) {
      db.prepare(
        `INSERT INTO meta(key, value) VALUES('backfill_visits', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(JSON.stringify({ next: r.lo, last: r.hi }));
    }
    log.info('migration: added visitor-analytics columns to events');
  }

  if (!columns('events').has('visitor')) {
    db.exec('ALTER TABLE events ADD COLUMN visitor TEXT');
    log.info('migration: added events.visitor');
  }

  if (!columns('visits').has('closed')) {
    // 1.2.1 counts a visit's exit page when it closes; 1.2.0 already counted
    // the exit pages of the visits it has, so those are treated as closed.
    // It also left exit-page rows that netted to nothing.
    db.exec('ALTER TABLE visits ADD COLUMN closed INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE visits SET closed = 1');
    // Visitor counts now come from visitor_seen; seed it from those visits so
    // the hours 1.2.0 recorded keep their visitors (each in its start hour).
    db.exec(
      `INSERT OR IGNORE INTO visitor_seen (bucket, host, visitor)
       SELECT (start_ts / 3600000) * 3600, host, visitor FROM visits`
    );
    db.exec(
      `DELETE FROM dims WHERE dim = 'exit'
          AND requests = 0 AND bytes = 0 AND errors = 0 AND dur_sum = 0`
    );
    log.info('migration: added visits.closed');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_visits_open ON visits(end_ts) WHERE closed = 0');
  // Visits started in part of an hour, for totals over a window that does
  // not start or end on the hour (queries.js, edgeTotals).
  db.exec('CREATE INDEX IF NOT EXISTS idx_visits_start ON visits(start_ts)');

  const rollup = columns('rollup');
  for (const col of ['pageviews', 'visits', 'visitors', 'bounces', 'visit_ms']) {
    if (!rollup.has(col)) {
      db.exec(`ALTER TABLE rollup ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      log.info(`migration: added rollup.${col}`);
    }
  }

  if (!columns('sessions').has('persistent')) {
    // "Keep me signed in". Existing sessions keep the idle timeout they were
    // created under.
    db.exec('ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0');
    log.info('migration: added sessions.persistent');
  }

  // Indexes for the request explorer's filters. Created here rather than in
  // schema.sql so they also land on databases that predate them.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_asn      ON events(asn);
    CREATE INDEX IF NOT EXISTS idx_events_country  ON events(country);
    CREATE INDEX IF NOT EXISTS idx_events_refhost  ON events(referer_host);
    CREATE INDEX IF NOT EXISTS idx_events_id_desc  ON events(id DESC);
  `);
}

/**
 * Open the database read-only, without migrations or any write, and make
 * getDb() return that connection. For diagnostic tools run beside the live
 * app. Uses the app's cache settings so timings match what the app sees.
 */
export function openReadOnly() {
  if (db) return db;
  db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  return db;
}

/**
 * Bytes of data the database holds, not counting space freed by deletions
 * and awaiting reuse — which SQLite keeps inside the file, so the file can be
 * larger than this.
 */
export function usedBytes(handle = getDb()) {
  const pageSize = handle.pragma('page_size', { simple: true });
  const pages = handle.pragma('page_count', { simple: true });
  const free = handle.pragma('freelist_count', { simple: true });
  return (pages - free) * pageSize;
}

/** Size of the database file and its write-ahead log, in bytes. */
export function fileBytes() {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += fs.statSync(config.dbPath + suffix).size;
    } catch {
      /* no WAL file yet */
    }
  }
  return total;
}

/** Size of the write-ahead log, in bytes. */
export function walBytes() {
  try {
    return fs.statSync(`${config.dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Write the whole write-ahead log into the database and empty it, waiting up
 * to `waitMs` for the ingester's current write and for other readers. Returns
 * false when that wait ran out, and nothing was emptied.
 */
export function checkpointWal({ waitMs }) {
  const handle = getDb();
  handle.pragma(`busy_timeout = ${waitMs}`);
  try {
    return handle.pragma('wal_checkpoint(TRUNCATE)')[0].busy === 0;
  } finally {
    handle.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

let walTimer = null;
let walWarned = 0;

/**
 * Keep the write-ahead log small. For the web process.
 *
 * SQLite folds the log back into the database as it goes, but can only start
 * it again from the beginning at a moment when no reader still uses an older
 * snapshot. With the ingester committing every second and the web side
 * running query after query, that moment never comes on a busy server: the
 * log grows without limit (14 GB in a day has been seen), and every read gets
 * slower the longer it is. The web process is the one holding those
 * snapshots, so it empties the log itself, between requests, when it is
 * holding none.
 */
export function startWalGuard() {
  if (walTimer) return;
  walTimer = setInterval(() => {
    const before = walBytes();
    if (before <= WAL_LIMIT) return;
    const started = Date.now();
    let done = false;
    try {
      done = checkpointWal({ waitMs: 2000 });
    } catch (err) {
      log.warn('could not empty the write-ahead log', { err: String(err) });
    }
    if (done) {
      log.debug('emptied the write-ahead log', { mb: Math.round(before / 1_048_576), ms: Date.now() - started });
    } else if (before > 16 * WAL_LIMIT && Date.now() - walWarned > 600_000) {
      walWarned = Date.now();
      log.warn('the write-ahead log keeps growing: the ingester holds the database for seconds at a time', {
        mb: Math.round(before / 1_048_576),
      });
    }
  }, 5_000);
  walTimer.unref();
}

/**
 * At startup, before anything else uses the database: fold in a log left
 * large by an earlier version. Takes minutes for a log of many gigabytes.
 */
export function foldLargeWal() {
  const before = walBytes();
  if (before <= WAL_LIMIT) return;
  log.info('writing a large write-ahead log into the database', { mb: Math.round(before / 1_048_576) });
  const started = Date.now();
  try {
    const done = checkpointWal({ waitMs: 10_000 });
    log.info(done ? 'write-ahead log emptied' : 'write-ahead log still in use; it is emptied later', {
      mb: Math.round(walBytes() / 1_048_576),
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (err) {
    // A full disk, most likely: the log is kept, and nothing in it is lost.
    log.error('could not write the write-ahead log into the database', { err: String(err) });
  }
}

/** Wrap a function in an IMMEDIATE transaction (write lock taken up front). */
export function tx(fn) {
  return getDb().transaction(fn);
}

export function closeDb() {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }
    db.close();
    db = null;
  }
}
