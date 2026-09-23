// The Caddyfile on disk, and the history of versions applied through the UI.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../util/log.js';

const log = logger('caddy');

export const MAX_CADDYFILE_BYTES = 1024 * 1024;

export const hashText = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** @returns {{text:string, hash:string, mtime:number, size:number}} */
export function readCaddyfile() {
  const file = config.caddy.caddyfile;
  const text = fs.readFileSync(file, 'utf8');
  const st = fs.statSync(file);
  return { text, hash: hashText(text), mtime: st.mtimeMs, size: st.size };
}

/** What the Caddy pages need to know before they can offer to edit anything. */
export function fileStatus() {
  const file = config.caddy.caddyfile;
  const dir = path.dirname(file);
  const out = { path: file, exists: false, readable: false, writable: false, dirWritable: false, error: null };
  try {
    fs.accessSync(file, fs.constants.F_OK);
    out.exists = true;
    fs.accessSync(file, fs.constants.R_OK);
    out.readable = true;
    fs.accessSync(file, fs.constants.W_OK);
    out.writable = true;
  } catch (err) {
    out.error = err.code;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    out.dirWritable = true;
  } catch {
    /* reported as false */
  }
  return out;
}

/**
 * Replace the Caddyfile. Written to a temp file and renamed over the original
 * so Caddy can never read half a file. If the Caddyfile is a single-file bind
 * mount the rename is refused (EBUSY), and it falls back to rewriting in
 * place — the directory mount in docker-compose.yml avoids that case.
 */
export function writeCaddyfile(text) {
  const file = config.caddy.caddyfile;
  const dir = path.dirname(file);
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    if (!['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err;
    log.warn('atomic save unavailable, rewriting the Caddyfile in place', { code: err.code });
  }
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    insert: db.prepare(
      `INSERT INTO caddy_history (ts, username, action, message, hash, size, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    latest: db.prepare('SELECT id, hash FROM caddy_history ORDER BY id DESC LIMIT 1'),
    list: db.prepare(
      `SELECT id, ts, username, action, message, hash, size
         FROM caddy_history ORDER BY id DESC LIMIT ?`
    ),
    get: db.prepare('SELECT * FROM caddy_history WHERE id = ?'),
    prune: db.prepare(
      `DELETE FROM caddy_history WHERE id NOT IN
         (SELECT id FROM caddy_history ORDER BY id DESC LIMIT ?)`
    ),
  };
  return stmts;
}

/**
 * Before the first change made through the UI — or after the file was edited
 * by hand — keep the version that is about to be replaced, so the history
 * always contains something to go back to.
 */
export function recordBaseline(text, username) {
  const hash = hashText(text);
  const last = prep().latest.get();
  if (last?.hash === hash) return;
  prep().insert.run(
    Date.now(), username ?? null, 'baseline',
    last ? 'Changed outside this interface' : 'Version on disk before the first change made here',
    hash, Buffer.byteLength(text), text
  );
}

export function recordVersion({ text, username, action, message }) {
  prep().insert.run(
    Date.now(), username ?? null, action, message ? String(message).slice(0, 500) : null,
    hashText(text), Buffer.byteLength(text), text
  );
  prep().prune.run(config.caddy.historyKeep);
}

export function listHistory(limit = 100) {
  return prep().list.all(Math.min(500, Math.max(1, limit)));
}

export function getVersion(id) {
  return prep().get.get(id) ?? null;
}
