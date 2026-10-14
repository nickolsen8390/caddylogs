// Shrink the database file to the data it holds.
//
// SQLite reuses the space of deleted rows but never gives it back to the
// disk on its own. After upgrading to 1.2.3, requests stop storing their
// original log line inline, so once the old ones age out (RAW_RETENTION_HOURS)
// most of the file is unused space. This rewrites the file without it.
//
// The interface must be stopped first: the file is replaced at the end, and
// anything written to the old one meanwhile would be lost. Needs free disk
// space of about the size the file will shrink to.
//
//   docker compose stop app
//   docker compose run --rm --no-deps app node src/tools/vacuum.js --yes
//   docker compose start app

import fs from 'node:fs';
import { config } from '../config.js';
import { getDb, closeDb } from '../db.js';

const mb = (b) => `${Math.round(b / 1_048_576).toLocaleString()} MB`;
const size = () => {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += fs.statSync(config.dbPath + suffix).size;
    } catch {
      /* no WAL file */
    }
  }
  return total;
};

if (!process.argv.includes('--yes')) {
  console.log('This rewrites the database file to drop unused space. Stop the interface');
  console.log('first (docker compose stop app), then run again with --yes.');
  process.exit(1);
}

const db = getDb();
const pageSize = db.pragma('page_size', { simple: true });
const free = db.pragma('freelist_count', { simple: true }) * pageSize;
const before = size();
console.log(`Database ${mb(before)}, of which ${mb(free)} is unused.`);
if (free < 64 * 1_048_576) {
  console.log('Not worth rewriting; nothing to do.');
  closeDb();
  process.exit(0);
}

// VACUUM INTO writes the compact copy straight to the data directory. A plain
// VACUUM would build it as a temporary database — in memory with this app's
// settings, or under /tmp, which the container caps at 64 MB.
const copy = `${config.dbPath}.vacuum`;
fs.rmSync(copy, { force: true });
console.log('Writing a compact copy... (several minutes for a multi-gigabyte file)');
const started = Date.now();
db.prepare('VACUUM INTO ?').run(copy);
closeDb(); // checkpoints the WAL into the old file, which is replaced next

fs.renameSync(copy, config.dbPath);
for (const suffix of ['-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${mb(before)} -> ${mb(size())}.`);
