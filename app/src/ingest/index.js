// Ingest process: follow Caddy's logs, parse, enrich, store.

import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { cidrMatcher } from '../util/net.js';
import { Tailer, logDirExists } from './tailer.js';
import { parseLine } from './parser.js';
import { startRollupLoop, stopRollupLoop } from './rollup.js';
import { initMaxmind } from '../enrich/maxmind.js';
import { resolveMany, startEnrichWorker, stopEnrichWorker } from '../enrich/index.js';
import { startMaintenance, stopMaintenance } from '../maintenance.js';

const log = logger('ingest');

let stmts = null;
function prep() {
  const db = getDb();
  if (stmts) return stmts;
  stmts = {
    insert: db.prepare(
      `INSERT INTO events (ts, host, method, path, query, status, bytes_out, bytes_in,
                           dur_ms, ip, ua, referer, proto, tls_version, tls_cipher,
                           browser, os, device, bot, country, asn, as_org, referer_host, rolled, raw)
       VALUES (@ts, @host, @method, @path, @query, @status, @bytes_out, @bytes_in,
               @dur_ms, @ip, @ua, @referer, @proto, @tls_version, @tls_cipher,
               @browser, @os, @device, @bot, @country, @asn, @as_org, @referer_host, 0, @raw)`
    ),
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

export class Ingestor {
  constructor() {
    this.buffer = [];
    this.counters = { lines: 0, parsed: 0, skipped: 0, malformed: 0 };
    this.ignoreCidr = cidrMatcher(config.ignoreCidrs);
    this.flushing = false;
    this.tailer = null;
    this.flushTimer = null;
  }

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

  async flush() {
    if (this.flushing || !this.buffer.length) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
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

      const db = getDb();
      const s = prep();
      const write = db.transaction((rows) => {
        for (const ev of rows) s.insert.run(ev);
        const day = Math.floor(Date.now() / 86_400_000) * 86400;
        s.stats.run({ day, ...this.counters });
      });
      write(batch);
      this.counters = { lines: 0, parsed: 0, skipped: 0, malformed: 0 };
    } catch (err) {
      log.error('flush failed; batch dropped', { err: String(err), size: batch.length });
    } finally {
      this.flushing = false;
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

    this.tailer = new Tailer({
      dir: config.logDir,
      glob: config.logGlob,
      onLines: this.handleLines,
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
    await this.flush();
  }
}
