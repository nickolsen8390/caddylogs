// Restoring stored requests from the log files still on disk.
//
// Individual requests are pruned when they pass the retention time (or the
// size limit), but Caddy's log files usually still hold them. After the
// retention is raised, this reads those files again and puts back the
// requests older than the oldest one stored — within the new retention and
// below the size limit.
//
// Restored requests are stored as already aggregated (rolled = 1): their
// statistics were counted when they first arrived, and counting them again
// would double every number. They are given ids below the existing ones, in
// time order, because everything else assumes a lower id is an older request
// — pruning removes the lowest ids first, and searches walk ids newest first.
// Ids may go below zero; SQLite allows it, and nothing here depends on them
// being positive.
//
// Asked for from the Settings page (web process); run here, in the ingest
// process, which reads the log directory and owns writing requests.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { getDb, usedBytes } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { cidrMatcher } from '../util/net.js';
import { packRaw } from '../util/rawlog.js';
import { parseLine, VISIT_COLUMNS } from './parser.js';
import { globMatcher } from './tailer.js';
import { rawRetentionMs, maxDbBytes } from '../settings.js';

const log = logger('restore');

const REQUEST_KEY = 'restore_request';
const STATUS_KEY = 'restore_status';
const BATCH = 1000;

const readMeta = (key) => {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
};
const writeMeta = (key, value) =>
  getDb()
    .prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value));

/** The last restore's progress or result, or null if there has been none. */
export function restoreStatus() {
  return readMeta(STATUS_KEY);
}

/**
 * Ask the ingest process to restore (web process). Refused while one is
 * queued or running.
 * @returns {boolean} whether it was queued
 */
export function requestRestore(username) {
  const current = restoreStatus();
  if (current && (current.state === 'queued' || current.state === 'running')) return false;
  writeMeta(REQUEST_KEY, { at: Date.now(), by: username ?? null });
  writeMeta(STATUS_KEY, { state: 'queued', by: username ?? null, requested: Date.now() });
  return true;
}

let running = false;
let timer = null;

/** Watch for restore requests (ingest process). */
export function startRestoreWatcher() {
  if (timer) return;
  // A restore interrupted by a restart is reported, not silently forgotten.
  const status = restoreStatus();
  if (status?.state === 'running') {
    writeMeta(STATUS_KEY, { ...status, state: 'failed', message: 'interrupted by a restart', finished: Date.now() });
  }
  timer = setInterval(() => {
    if (running) return;
    const req = readMeta(REQUEST_KEY);
    if (!req) return;
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(REQUEST_KEY);
    running = true;
    restore(req.by)
      .catch((err) => log.error('restore failed', { err: String(err) }))
      .finally(() => {
        running = false;
      });
  }, 5000);
}

export function stopRestoreWatcher() {
  clearInterval(timer);
  timer = null;
}

/** Every line of a file, read as a stream (files can be gigabytes). */
async function* linesOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line) yield line;
  } finally {
    rl.close();
  }
}

async function restore(by) {
  const db = getDb();
  const status = {
    state: 'running', by, started: Date.now(), files: 0, filesDone: 0, restored: 0, oldest: null, message: null,
  };
  writeMeta(STATUS_KEY, status);
  log.info('restoring stored requests from log files', { dir: config.logDir, by });

  try {
    // Original log lines left behind by pruned requests would collide with
    // the ids handed out below.
    db.prepare('DELETE FROM events_raw WHERE id < (SELECT COALESCE(MIN(id), 9e18) FROM events)').run();

    const edge = db.prepare('SELECT MIN(id) AS id, MIN(ts) AS ts FROM events').get();
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0;
    // Ids are handed out downwards from just below the oldest stored request.
    let below = edge.id ?? seq + 1;
    // Requests from this time on are already stored.
    const storedFrom = edge.ts ?? Infinity;
    const keepMs = rawRetentionMs();
    const notBefore = Number.isFinite(keepMs) ? Date.now() - keepMs : 0;
    const limit = maxDbBytes();

    const ignoredIp = cidrMatcher(config.ignoreCidrs);
    const parseWanted = (line) => {
      const res = parseLine(line);
      if (!res.ok) return null;
      const ev = res.event;
      if (ev.ts < notBefore || ev.ts >= storedFrom) return null;
      if (config.ignoreHosts.has(ev.host) || (ev.ip && ignoredIp(ev.ip))) return null;
      return ev;
    };

    // Newest file first, so each file's block of ids sits below the one
    // after it in time.
    const matches = globMatcher(config.logGlob);
    const files = [];
    for (const name of await fsp.readdir(config.logDir)) {
      if (!matches(name)) continue;
      const full = path.join(config.logDir, name);
      try {
        const st = await fsp.stat(full);
        if (st.isFile()) files.push({ full, mtime: st.mtimeMs });
      } catch {
        /* gone already */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    status.files = files.length;
    writeMeta(STATUS_KEY, status);

    const insert = db.prepare(
      `INSERT INTO events (id, ts, host, method, path, query, status, bytes_out, bytes_in,
                           dur_ms, ip, ua, referer, proto, tls_version, tls_cipher,
                           browser, os, device, bot, country, asn, as_org, referer_host, rolled,
                           ${VISIT_COLUMNS.join(', ')})
       VALUES (@id, @ts, @host, @method, @path, @query, @status, @bytes_out, @bytes_in,
               @dur_ms, @ip, @ua, @referer, @proto, @tls_version, @tls_cipher,
               @browser, @os, @device, @bot, @country, @asn, @as_org, @referer_host, 1,
               ${VISIT_COLUMNS.map((c) => `@${c}`).join(', ')})`
    );
    const insertRaw = db.prepare('INSERT OR REPLACE INTO events_raw (id, raw) VALUES (?, ?)');
    const ipInfo = db.prepare('SELECT country, asn, as_org FROM ip_info WHERE ip = ?');
    const known = new Map();
    const enrich = (ev) => {
      if (!ev.ip) return { country: null, asn: null, as_org: null };
      let info = known.get(ev.ip);
      if (info === undefined) {
        info = ipInfo.get(ev.ip) ?? null;
        if (known.size > 50_000) known.clear();
        known.set(ev.ip, info);
      }
      return { country: info?.country ?? null, asn: info?.asn ?? null, as_org: info?.as_org ?? null };
    };
    const write = db.transaction((rows) => {
      for (const { raw, ...ev } of rows) {
        insert.run({ ...ev, ...enrich(ev) });
        insertRaw.run(ev.id, packRaw(raw));
      }
    });

    for (const file of files) {
      if (limit && usedBytes(db) > limit * 0.9) {
        status.message = 'stopped near the database size limit';
        break;
      }
      try {
        // Two passes: count, then insert. Counting first lets this file's
        // requests take a block of ids in their own (time) order without
        // holding a whole log file in memory.
        let count = 0;
        for await (const line of linesOf(file.full)) if (parseWanted(line)) count += 1;
        if (count) {
          let id = below - count;
          below -= count;
          const last = id + count; // exclusive: never into the next block
          let batch = [];
          for await (const line of linesOf(file.full)) {
            if (id >= last) break;
            const ev = parseWanted(line);
            if (!ev) continue;
            ev.id = id++;
            batch.push(ev);
            if (batch.length >= BATCH) {
              write(batch);
              status.restored += batch.length;
              batch = [];
              // Let the live tail and the rollup run between batches.
              await new Promise((r) => setImmediate(r));
            }
            if (status.oldest === null || ev.ts < status.oldest) status.oldest = ev.ts;
          }
          if (batch.length) {
            write(batch);
            status.restored += batch.length;
          }
        }
      } catch (err) {
        // A file rotated away or unreadable: carry on with the rest.
        log.warn('could not restore from a log file', { file: file.full, err: String(err) });
      }
      status.filesDone += 1;
      writeMeta(STATUS_KEY, status);
    }

    status.state = 'done';
  } catch (err) {
    status.state = 'failed';
    status.message = String(err?.message ?? err);
  }
  status.finished = Date.now();
  writeMeta(STATUS_KEY, status);
  log.info('restore finished', status);
}
