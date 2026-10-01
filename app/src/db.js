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
