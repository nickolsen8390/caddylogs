// Rotation-safe log follower.
//
// Files are tracked by inode, not by path. Caddy (via lumberjack) rotates by
// renaming the live file and creating a new one, so an inode-keyed checkpoint
// resumes the rotated file exactly where we left off and treats the new
// access.log as a fresh file at offset 0. A path-keyed checkpoint would either
// re-ingest the whole rotated file or silently skip the new one.
//
// Truncation in place (`copytruncate`-style rotation) is detected by the file
// shrinking below our stored offset, and restarts that inode from 0.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../db.js';
import { logger } from '../util/log.js';

const log = logger('tail');
const CHUNK = 1 << 20; // 1 MiB reads
const MAX_LINE = 8 << 20; // abandon a "line" larger than this

/** Translate a shell-style glob (`*`, `?`, `{a,b}`) into an anchored RegExp. */
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export class Tailer {
  /**
   * @param {object} opts
   * @param {string} opts.dir              directory to watch (read-only mount)
   * @param {string} opts.glob             comma-separated globs
   * @param {(lines:string[], meta:object)=>Promise<void>|void} opts.onLines
   * @param {boolean} [opts.backfill]      read pre-existing files from the start
   * @param {number}  [opts.backfillMaxDays] ignore files older than this
   */
  constructor({ dir, glob, onLines, backfill = true, backfillMaxDays = 0, pollMs = 250, scanMs = 3000 }) {
    this.dir = dir;
    this.patterns = String(glob)
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
      .map(globToRegExp);
    this.onLines = onLines;
    this.backfill = backfill;
    this.backfillMaxDays = backfillMaxDays;
    this.pollMs = pollMs;
    this.scanMs = scanMs;

    /** @type {Map<string,{path:string,offset:number,leftover:Buffer}>} */
    this.files = new Map(); // inode key -> runtime state
    this.stopped = false;
    this.busy = false;
    this.lastScan = 0;

    const db = getDb();
    this.qLoad = db.prepare('SELECT * FROM ingest_state WHERE inode = ?');
    this.qSave = db.prepare(
      `INSERT INTO ingest_state (inode, path, offset, size, first_seen, updated_at)
         VALUES (@inode, @path, @offset, @size, @now, @now)
       ON CONFLICT(inode) DO UPDATE SET
         path = excluded.path, offset = excluded.offset,
         size = excluded.size, updated_at = excluded.updated_at`
    );
    this.qPrune = db.prepare('DELETE FROM ingest_state WHERE updated_at < ?');
  }

  matches(name) {
    return this.patterns.some((re) => re.test(name));
  }

  async scan() {
    let entries;
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      log.error('cannot read log directory', { dir: this.dir, err: String(err) });
      return;
    }
    const seen = new Set();
    for (const ent of entries) {
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (!this.matches(ent.name)) continue;
      const full = path.join(this.dir, ent.name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      const key = `${st.dev}:${st.ino}`;
      seen.add(key);

      let state = this.files.get(key);
      if (!state) {
        const saved = this.qLoad.get(key);
        let offset;
        if (saved) {
          offset = saved.offset;
        } else if (this.backfill) {
          const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
          offset = this.backfillMaxDays > 0 && ageDays > this.backfillMaxDays ? st.size : 0;
        } else {
          offset = st.size; // tail-only: skip existing content
        }
        state = { path: full, offset, leftover: Buffer.alloc(0) };
        this.files.set(key, state);
        log.info('following file', { path: full, inode: key, from: offset, size: st.size });
      } else if (state.path !== full) {
        // Same inode, new name: this file was just rotated. Keep reading it.
        log.info('file rotated', { from: state.path, to: full, inode: key });
        state.path = full;
      }
    }

    // Files that vanished (deleted after rotation) stop being polled, but their
    // checkpoint row stays until pruned so a re-appearance is not re-ingested.
    for (const key of [...this.files.keys()]) {
      if (!seen.has(key)) this.files.delete(key);
    }
  }

  async readFile(key, state) {
    let st;
    try {
      st = await fsp.stat(state.path);
    } catch {
      return;
    }
    if (st.size < state.offset) {
      log.warn('file truncated, restarting from 0', { path: state.path });
      state.offset = 0;
      state.leftover = Buffer.alloc(0);
    }
    if (st.size === state.offset) return;

    let fh;
    try {
      fh = await fsp.open(state.path, 'r');
    } catch (err) {
      log.warn('cannot open file', { path: state.path, err: String(err) });
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      // `st.size` is the ceiling for this pass; anything appended while we read
      // is picked up on the next tick.
      while (state.offset < st.size && !this.stopped) {
        const want = Math.min(CHUNK, st.size - state.offset);
        const { bytesRead } = await fh.read(buf, 0, want, state.offset);
        if (bytesRead <= 0) break;

        const data = state.leftover.length
          ? Buffer.concat([state.leftover, buf.subarray(0, bytesRead)])
          : buf.subarray(0, bytesRead);

        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) {
          // No complete line yet. Hold it and do not advance past it.
          if (data.length > MAX_LINE) {
            // A file matching the glob that contains no newlines would grow
            // this buffer without limit. Abandon the fragment rather than the
            // process; real Caddy lines are far below this.
            log.warn('dropping oversized fragment with no line break', {
              path: state.path,
              bytes: data.length,
            });
            state.leftover = Buffer.alloc(0);
          } else {
            state.leftover = Buffer.from(data);
          }
          state.offset += bytesRead;
          continue;
        }

        const complete = data.subarray(0, lastNl).toString('utf8');
        state.leftover = Buffer.from(data.subarray(lastNl + 1));
        state.offset += bytesRead;

        const lines = complete.split('\n');
        const useful = [];
        for (const l of lines) {
          const s = l.endsWith('\r') ? l.slice(0, -1) : l;
          if (s.length) useful.push(s);
        }
        if (useful.length) {
          await this.onLines(useful, { path: state.path, inode: key });
        }
        this.checkpoint(key, state, st.size);
      }
      this.checkpoint(key, state, st.size);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  checkpoint(key, state, size) {
    // The offset we persist excludes any held-back partial line, so a crash
    // mid-line re-reads that line rather than losing or splitting it.
    const durable = state.offset - state.leftover.length;
    this.qSave.run({
      inode: key,
      path: state.path,
      offset: durable,
      size,
      now: Date.now(),
    });
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (Date.now() - this.lastScan > this.scanMs) {
        this.lastScan = Date.now();
        await this.scan();
      }
      for (const [key, state] of this.files) {
        if (this.stopped) break;
        await this.readFile(key, state);
      }
    } catch (err) {
      log.error('tail tick failed', { err: String(err), stack: err?.stack });
    } finally {
      this.busy = false;
    }
  }

  async start() {
    await this.scan();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Prune checkpoints for inodes not touched in 30 days.
    this.pruneTimer = setInterval(
      () => this.qPrune.run(Date.now() - 30 * 86_400_000),
      6 * 3600_000
    );
    void this.tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.pruneTimer);
  }
}

export function logDirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
