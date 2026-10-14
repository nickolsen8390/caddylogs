import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './util/log.js';

const log = logger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;

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
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // ~64 MiB page cache
  db.pragma('mmap_size = 268435456');

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
