// Ingest process: follow Caddy's logs, parse, enrich, store.

import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { cidrMatcher } from '../util/net.js';
import { packRaw } from '../util/rawlog.js';
import { Tailer, logDirExists } from './tailer.js';
import { parseLine } from './parser.js';
import { startRollupLoop, stopRollupLoop } from './rollup.js';
import { initMaxmind } from '../enrich/maxmind.js';
import { resolveMany, startEnrichWorker, stopEnrichWorker } from '../enrich/index.js';
import { startMaintenance, stopMaintenance } from '../maintenance.js';
import { startRestoreWatcher, stopRestoreWatcher } from './restore.js';

const log = logger('ingest');

let stmts = null;
function prep() {
  const db = getDb();
  if (stmts) return stmts;
  stmts = {
    insert: db.prepare(
      `INSERT INTO events (ts, host, method, path, query, status, bytes_out, bytes_in,
                           dur_ms, ip, ua, referer, proto, tls_version, tls_cipher,
                           browser, os, device, bot, country, asn, as_org, referer_host, rolled,
                           nav, channel, lang, utm_source, utm_medium, utm_campaign, utm_term,
                           utm_content)
       VALUES (@ts, @host, @method, @path, @query, @status, @bytes_out, @bytes_in,
               @dur_ms, @ip, @ua, @referer, @proto, @tls_version, @tls_cipher,
               @browser, @os, @device, @bot, @country, @asn, @as_org, @referer_host, 0,
               @nav, @channel, @lang, @utm_source, @utm_medium, @utm_campaign, @utm_term,
               @utm_content)`
    ),
    insertRaw: db.prepare('INSERT INTO events_raw (id, raw) VALUES (?, ?)'),
    stats: db.prepare(
      `INSERT INTO ingest_stats (day, lines, parsed, skipped, malformed)
         VALUES (@day, @lines, @parsed, @skipped, @malformed)
       ON CONFLICT(day) DO UPDATE SET
         lines     = ingest_stats.lines     + excluded.lines,
         parsed    = ingest_stats.parsed    + excluded.parsed,
         skipped   = ingest_stats.skipped   + excluded.skipped,
         malformed = ingest_stats.malformed + excluded.malformed`
    ),
  };
  return stmts;
}

/** Attempts at writing a batch before it is given up on. */
const FLUSH_ATTEMPTS = 3;

const noCounts = () => ({ lines: 0, parsed: 0, skipped: 0, malformed: 0 });

export class Ingestor {
  constructor() {
    this.buffer = [];
    this.counters = noCounts();
    // Read positions reached by the lines in `buffer`, by inode. They are
    // saved in the transaction that stores those lines, never before: a
    // position saved ahead of its lines would let a crash skip them for good.
    this.positions = new Map();
    this.ignoreCidr = cidrMatcher(config.ignoreCidrs);
    this.flushing = null; // the flush under way
    this.failures = 0;
    this.tailer = null;
    this.flushTimer = null;
  }

  handleCheckpoint = (cp) => {
    this.positions.set(cp.inode, cp);
  };

  handleLines = async (lines) => {
    for (const line of lines) {
      this.counters.lines += 1;
      const res = parseLine(line);
      if (!res.ok) {
        if (res.reason === 'json') this.counters.malformed += 1;
        else this.counters.skipped += 1;
        continue;
      }
      const ev = res.event;
      if (config.ignoreHosts.has(ev.host) || (ev.ip && this.ignoreCidr(ev.ip))) {
        this.counters.skipped += 1;
        continue;
      }
      this.counters.parsed += 1;
      this.buffer.push(ev);
    }
    if (this.buffer.length >= config.ingest.batchSize) await this.flush();
  };

  flush() {
    if (this.flushing || (!this.buffer.length && !this.positions.size)) return this.flushing ?? Promise.resolve();
    this.flushing = this.write().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async write() {
    // Taken together, so the positions saved are the ones these lines reach.
    // Lines read while this runs collect for the next flush.
    const batch = this.buffer;
    const positions = this.positions;
    const counters = this.counters;
    this.buffer = [];
    this.positions = new Map();
    this.counters = noCounts();
    try {
      if (batch.length) {
        const ips = new Set();
        for (const ev of batch) if (ev.ip) ips.add(ev.ip);

        // Bounded wait: whatever has not resolved gets written with the local
        // answer and is repaired by the rollup pass once the worker catches up.
        let info = new Map();
        try {
          info = await resolveMany(ips, config.enrich.inlineTimeoutMs);
        } catch (err) {
          log.warn('enrichment batch failed; writing without ASN data', { err: String(err) });
        }

        for (const ev of batch) {
          const rec = ev.ip ? info.get(ev.ip) : null;
          ev.country = rec?.country ?? null;
          ev.asn = rec?.asn ?? null;
          ev.as_org = rec?.as_org ?? rec?.as_name ?? null;
        }
      }

      const db = getDb();
      const s = prep();
      const write = db.transaction((rows) => {
        for (const { raw, ...ev } of rows) {
          const id = s.insert.run(ev).lastInsertRowid;
          s.insertRaw.run(id, packRaw(raw));
        }
        if (counters.lines) {
          const day = Math.floor(Date.now() / 86_400_000) * 86400;
          s.stats.run({ day, ...counters });
        }
        for (const cp of positions.values()) this.tailer.saveCheckpoint(cp);
      });
      write(batch);
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      if (this.failures < FLUSH_ATTEMPTS) {
        // Back in front of whatever was read meanwhile, for the next flush.
        // Its positions go back too, unless a later one has arrived.
        log.warn('flush failed; will retry', { err: String(err), size: batch.length, attempt: this.failures });
        this.buffer = batch.concat(this.buffer);
        for (const [inode, cp] of positions) if (!this.positions.has(inode)) this.positions.set(inode, cp);
        for (const k of Object.keys(counters)) this.counters[k] += counters[k];
        return;
      }
      this.failures = 0;
      log.error('flush failed; batch dropped', { err: String(err), size: batch.length });
      // Still move the read positions past it, or a restart would read the
      // same lines and fail on them again.
      try {
        getDb().transaction(() => {
          for (const cp of positions.values()) this.tailer.saveCheckpoint(cp);
        })();
      } catch (err2) {
        log.error('saving read positions failed', { err: String(err2) });
      }
    }
  }

  async start() {
    if (!logDirExists(config.logDir)) {
      log.error('log directory is not readable — check the bind mount', { dir: config.logDir });
    }
    await initMaxmind();
    startEnrichWorker();
    startRollupLoop();
    startMaintenance();
    startRestoreWatcher();

    this.tailer = new Tailer({
      dir: config.logDir,
      glob: config.logGlob,
      onLines: this.handleLines,
      onCheckpoint: this.handleCheckpoint,
      backfill: process.env.INGEST_BACKFILL !== 'false',
      backfillMaxDays: parseInt(process.env.INGEST_BACKFILL_MAX_DAYS || '0', 10),
    });
    await this.tailer.start();

    this.flushTimer = setInterval(() => void this.flush(), config.ingest.flushMs);
    log.info('ingest started', { dir: config.logDir, glob: config.logGlob });
  }

  async stop() {
    this.tailer?.stop();
    clearInterval(this.flushTimer);
    stopRollupLoop();
    stopEnrichWorker();
    stopMaintenance();
    stopRestoreWatcher();
    // One may be under way, holding only the lines it took; then the rest.
    await this.flushing;
    await this.flush();
  }
}
