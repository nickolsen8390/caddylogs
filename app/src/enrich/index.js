// IP enrichment: country from MaxMind (local, instant), BGP prefix + ASN from
// notoolkit (remote, rate-limited, cached).
//
// Ingest calls resolveMany() with a short inline timeout before writing a
// batch. Anything not resolved in time is written with whatever is known
// locally and pushed onto ip_queue, which the background worker drains; the
// cache is then warm for every subsequent request from that address.
//
// Separately, each distinct ASN gets ONE asn/{number} lookup for registrant detail
// (RIR, description, WHOIS, prefix counts). That set is bounded by the number
// of networks that talk to the server, not by request volume.
//
// Addresses share lookups by block: no route more specific than an IPv4 /24
// or an IPv6 /48 is carried on the internet, so every address in one block
// has the same covering prefix and origin AS. One answer serves the block —
// which matters for IPv6, where clients use a fresh address for almost every
// connection. It is shared only when the prefix it names covers the whole
// block; an answer naming a longer prefix is kept to its own address.

import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { blockOf, isPrivateIp, prefixCoversBlock } from '../util/net.js';
import { lookupCountry, lookupAsn as maxmindAsn, maxmindStatus } from './maxmind.js';
import { lookupIp, lookupAsnDetail, NOTOOLKIT } from './notoolkit.js';

const log = logger('enrich');

const EMPTY = Object.freeze({
  country: null,
  country_name: null,
  asn: null,
  as_name: null,
  as_org: null,
  as_prefix: null,
  as_country: null,
  as_rir: null,
  source: null,
});

const mem = new Map(); // ip -> record (bounded)
const MEM_MAX = 100_000;
const inFlight = new Map(); // ip -> Promise
const blockAnswers = new Map(); // block -> { nt, at } (bounded)
const blockInFlight = new Map(); // block -> Promise of a notoolkit answer

// Throughput, for the periodic log line while there is a backlog.
const stats = { resolved: 0, lookups: 0, shared: 0, failed: 0 };

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    get: db.prepare('SELECT * FROM ip_info WHERE ip = ?'),
    upsert: db.prepare(
      `INSERT INTO ip_info (ip, country, country_name, asn, as_name, as_org, as_prefix,
                            as_country, as_rir, source, updated_at, error)
         VALUES (@ip, @country, @country_name, @asn, @as_name, @as_org, @as_prefix,
                 @as_country, @as_rir, @source, @updated_at, @error)
       ON CONFLICT(ip) DO UPDATE SET
         country = excluded.country, country_name = excluded.country_name,
         asn = excluded.asn, as_name = excluded.as_name, as_org = excluded.as_org,
         as_prefix = excluded.as_prefix, as_country = excluded.as_country,
         as_rir = excluded.as_rir, source = excluded.source,
         updated_at = excluded.updated_at, error = excluded.error`
    ),
    enqueue: db.prepare(
      `INSERT INTO ip_queue (ip, attempts, next_try) VALUES (?, 0, ?)
         ON CONFLICT(ip) DO NOTHING`
    ),
    dequeue: db.prepare('SELECT * FROM ip_queue WHERE next_try <= ? ORDER BY next_try LIMIT ?'),
    retry: db.prepare('UPDATE ip_queue SET attempts = ?, next_try = ?, last_error = ? WHERE ip = ?'),
    drop: db.prepare('DELETE FROM ip_queue WHERE ip = ?'),
    queueDepth: db.prepare('SELECT COUNT(*) AS n FROM ip_queue'),

    // ASN detail
    seedAsn: db.prepare(
      `INSERT INTO asn_names (asn, as_name, org, country, rir, description, updated_at)
         VALUES (@asn, @as_name, @org, @country, @rir, @description, @now)
       ON CONFLICT(asn) DO UPDATE SET
         as_name     = COALESCE(excluded.as_name, asn_names.as_name),
         org         = COALESCE(excluded.org, asn_names.org),
         country     = COALESCE(excluded.country, asn_names.country),
         rir         = COALESCE(excluded.rir, asn_names.rir),
         description = COALESCE(excluded.description, asn_names.description),
         updated_at  = excluded.updated_at`
    ),
    asnNeedingDetail: db.prepare(
      `SELECT asn FROM asn_names
        WHERE asn > 0 AND (detail_at IS NULL OR detail_at < ?)
        ORDER BY detail_at IS NOT NULL, asn
        LIMIT ?`
    ),
    saveAsnDetail: db.prepare(
      `UPDATE asn_names SET
         as_name = COALESCE(@as_name, as_name),
         org = COALESCE(@org, org),
         country = COALESCE(@country, country),
         rir = COALESCE(@rir, rir),
         description = COALESCE(@description, description),
         whois_raw = COALESCE(@whois_raw, whois_raw),
         prefix_v4 = @prefix_v4,
         prefix_v6 = @prefix_v6,
         detail_at = @now,
         detail_error = NULL
       WHERE asn = @asn`
    ),
    asnDetailFailed: db.prepare(
      // Stamp detail_at so a permanently unknown ASN is not retried every tick;
      // the TTL sweep will pick it up again later.
      'UPDATE asn_names SET detail_at = ?, detail_error = ? WHERE asn = ?'
    ),
  };
  return stmts;
}

/** Cheap eviction: drop the oldest tenth rather than tracking access order. */
function makeRoom(map) {
  if (map.size < MEM_MAX) return;
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i > MEM_MAX / 10) break;
  }
}

function remember(ip, rec) {
  makeRoom(mem);
  mem.set(ip, rec);
  return rec;
}

/** Whether an answer can stand for every address in the block of `ip`. */
const coversBlock = (nt, ip) => Boolean(nt) && prefixCoversBlock(nt.as_prefix, ip);

/**
 * notoolkit's answer for `ip`, from another address in its block when one is
 * known or being looked up, otherwise from the API.
 */
async function lookupShared(ip, urgent) {
  const block = blockOf(ip);
  if (!block) return lookupIp(ip, urgent);

  const known = blockAnswers.get(block);
  if (known && Date.now() - known.at < config.enrich.ttlDays * 86_400_000) {
    stats.shared += 1;
    return known.nt;
  }
  const running = blockInFlight.get(block);
  if (running) {
    const nt = await running.catch(() => null);
    if (nt && coversBlock(nt, ip)) {
      stats.shared += 1;
      return nt;
    }
    stats.lookups += 1;
    return lookupIp(ip, urgent);
  }

  stats.lookups += 1;
  const p = lookupIp(ip, urgent);
  blockInFlight.set(block, p);
  try {
    const nt = await p;
    if (nt && coversBlock(nt, ip)) {
      makeRoom(blockAnswers);
      blockAnswers.set(block, { nt, at: Date.now() });
    }
    return nt;
  } finally {
    blockInFlight.delete(block);
  }
}

function isFresh(row) {
  if (!row) return false;
  const ttl = config.enrich.ttlDays * 86_400_000;
  // A clean result is good until TTL. A row that errored is retried much
  // sooner so a provider outage does not poison the cache for a month.
  const window = row.error ? Math.min(ttl, 3_600_000) : ttl;
  return Date.now() - row.updated_at < window;
}

function persist(ip, rec, error) {
  prep().upsert.run({
    ip,
    country: rec.country ?? null,
    country_name: rec.country_name ?? null,
    asn: rec.asn ?? null,
    as_name: rec.as_name ?? null,
    as_org: rec.as_org ?? null,
    as_prefix: rec.as_prefix ?? null,
    as_country: rec.as_country ?? null,
    as_rir: rec.as_rir ?? null,
    source: rec.source ?? null,
    updated_at: Date.now(),
    error: error ? String(error).slice(0, 300) : null,
  });
}

/** Local-only enrichment: always available, never blocks. */
function localOnly(ip) {
  const { country, country_name } = lookupCountry(ip);
  const { asn, as_org } = maxmindAsn(ip);
  return {
    ...EMPTY,
    country,
    country_name,
    asn,
    as_org,
    source: asn ? 'maxmind' : country ? 'maxmind' : null,
  };
}

/** Full resolution for one IP, including the remote call. */
async function resolveOne(ip, urgent = false) {
  const existing = inFlight.get(ip);
  if (existing) return existing;

  const p = (async () => {
    const base = localOnly(ip);
    const s = prep();

    if (!config.notoolkit.enabled) {
      persist(ip, base, null);
      s.drop.run(ip);
      return remember(ip, base);
    }

    try {
      const nt = await lookupShared(ip, urgent);
      const rec = nt
        ? {
            ...base,
            asn: nt.asn ?? base.asn,
            as_name: nt.as_name,
            as_org: nt.as_org ?? base.as_org,
            as_prefix: nt.as_prefix,
            as_country: nt.as_country,
            as_rir: nt.as_rir,
            source: 'notoolkit',
          }
        : // The provider answered and has no BGP prefix for this address.
          // Cache that as a resolved state so we stop asking.
          { ...base, source: base.asn ? 'maxmind' : 'notoolkit-none' };

      persist(ip, rec, null);
      if (nt?.asn) {
        s.seedAsn.run({
          asn: nt.asn,
          as_name: nt.as_name,
          org: nt.as_org,
          country: nt.as_country,
          rir: nt.as_rir,
          description: nt.description,
          now: Date.now(),
        });
      }
      s.drop.run(ip);
      stats.resolved += 1;
      return remember(ip, rec);
    } catch (err) {
      // Transient failure. Keep whatever MaxMind gave us, record the error,
      // and leave the IP queued so the worker retries with backoff.
      stats.failed += 1;
      const rec = { ...base, source: base.asn ? 'maxmind-fallback' : null };
      persist(ip, rec, err?.message ?? err);
      s.enqueue.run(ip, Date.now() + 60_000);
      throw err;
    }
  })();

  inFlight.set(ip, p);
  // Deliberately propagates a transient failure: the queue worker needs to see
  // it to apply backoff. Callers that only want a best-effort record catch it.
  try {
    return await p;
  } finally {
    inFlight.delete(ip);
  }
}

/**
 * Resolve a set of IPs, waiting at most `timeoutMs` in total.
 * @returns {Promise<Map<string, object>>}
 */
export async function resolveMany(ips, timeoutMs = config.enrich.inlineTimeoutMs) {
  const out = new Map();
  const pending = [];

  for (const ip of ips) {
    if (!ip || out.has(ip)) continue;

    if (isPrivateIp(ip)) {
      out.set(
        ip,
        remember(ip, { ...EMPTY, country: 'ZZ', country_name: 'Private network', source: 'private' })
      );
      continue;
    }
    const cached = mem.get(ip);
    if (cached) {
      out.set(ip, cached);
      continue;
    }
    const row = prep().get.get(ip);
    if (isFresh(row)) {
      out.set(ip, remember(ip, row));
      continue;
    }
    // Not known: seed with the local answer so the row is never blank, then
    // try to upgrade it within the timeout.
    out.set(ip, localOnly(ip));
    pending.push(ip);
  }

  if (!pending.length) return out;

  const deadline = Date.now() + timeoutMs;
  const queue = [...pending];
  const workers = Array.from(
    { length: Math.min(config.notoolkit.concurrency, queue.length) },
    async () => {
      while (queue.length && Date.now() < deadline) {
        const ip = queue.shift();
        try {
          const rec = await resolveOne(ip, true);
          if (rec) out.set(ip, rec);
        } catch {
          // Already persisted with the local answer and re-queued by
          // resolveOne; the map keeps the MaxMind-only record seeded above.
        }
      }
    }
  );

  await Promise.race([Promise.all(workers), new Promise((r) => setTimeout(r, timeoutMs))]);

  // Anything still unresolved goes on the queue for the background worker.
  // Without notoolkit there is nothing to retry: the local answer seeded
  // above is all there will ever be, and the next sighting resolves it again.
  if (!config.notoolkit.enabled) return out;
  const s = prep();
  for (const ip of queue) s.enqueue.run(ip, Date.now());
  return out;
}

// ---------------------------------------------------------------------------
//  Background workers
// ---------------------------------------------------------------------------

let workerTimer = null;
let workerRunning = false;
/** Longest the queue is drained before ASN detail gets a turn. */
const DRAIN_SLICE_MS = 30_000;

/**
 * Works through the due part of the queue with NOTOOLKIT_CONCURRENCY lookups
 * in flight at all times, refilling from the table as they finish — so the
 * rate limiter (NOTOOLKIT_RATE_PER_SEC), not the polling, sets the pace.
 * @returns {number} addresses handled
 */
async function drainIpQueue(until) {
  const s = prep();
  const concurrency = Math.max(1, config.notoolkit.concurrency);
  const want = Math.max(50, concurrency * 4);
  const pending = [];
  // Rows being looked up are still in the table until they resolve; this
  // keeps a refill from handing them out twice.
  const claimed = new Set();
  let handled = 0;

  const refill = () => {
    if (!workerRunning || Date.now() >= until) return;
    for (const row of s.dequeue.all(Date.now(), want + claimed.size)) {
      if (claimed.has(row.ip)) continue;
      claimed.add(row.ip);
      pending.push(row);
    }
  };

  const runner = async () => {
    for (;;) {
      if (!pending.length) refill();
      const row = pending.shift();
      if (!row) return;
      try {
        await resolveOne(row.ip);
        // resolveOne removes the row on success.
      } catch (err) {
        const attempts = row.attempts + 1;
        if (attempts >= config.notoolkit.maxRetries) {
          s.drop.run(row.ip); // give up; the TTL sweep retries much later
        } else {
          const backoff = Math.min(3_600_000, 60_000 * 2 ** attempts);
          s.retry.run(
            attempts,
            Date.now() + backoff,
            String(err?.message ?? err).slice(0, 300),
            row.ip
          );
        }
      } finally {
        claimed.delete(row.ip);
        handled += 1;
      }
    }
  };

  refill();
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runner));
  return handled;
}

let lastReport = Date.now();
/** A line a minute while there is a backlog, so its progress can be followed. */
function report() {
  const now = Date.now();
  if (now - lastReport < 60_000) return;
  const secs = (now - lastReport) / 1000;
  lastReport = now;
  const done = { ...stats };
  for (const k of Object.keys(stats)) stats[k] = 0;
  if (!done.resolved && !done.failed) return;
  let queued = 0;
  try {
    queued = prep().queueDepth.get().n;
  } catch {
    /* only for the log line */
  }
  log.info('enrichment progress', {
    resolvedPerSec: Math.round((done.resolved / secs) * 10) / 10,
    lookupsPerSec: Math.round((done.lookups / secs) * 10) / 10,
    sharedInBlock: done.shared,
    failed: done.failed,
    queued,
  });
}

async function fillAsnDetail() {
  if (!config.notoolkit.enabled) return;
  const s = prep();
  const ttl = Date.now() - config.enrich.asnTtlDays * 86_400_000;
  // A handful per tick: this is background polish, not a hot path.
  const rows = s.asnNeedingDetail.all(ttl, 5);
  for (const { asn } of rows) {
    try {
      const detail = await lookupAsnDetail(asn);
      if (!detail) {
        s.asnDetailFailed.run(Date.now(), 'no WHOIS or routing data', asn);
        continue;
      }
      s.saveAsnDetail.run({
        asn,
        as_name: detail.as_name,
        org: detail.org,
        country: detail.country,
        rir: detail.rir,
        description: detail.description,
        whois_raw: detail.whois_raw,
        prefix_v4: detail.prefix_v4,
        prefix_v6: detail.prefix_v6,
        now: Date.now(),
      });
    } catch (err) {
      // Transient: leave detail_at untouched so it is retried next tick.
      log.debug('asn detail lookup failed', { asn, err: String(err?.message ?? err) });
      return; // provider is unhappy; stop hammering it this tick
    }
  }
}

export function startEnrichWorker() {
  if (workerRunning) return;
  if (!config.notoolkit.enabled) {
    // Both jobs below are notoolkit retries and lookups. Drop whatever was
    // queued while it was switched on: without it those addresses can only
    // get the local (MaxMind) answer, which they already have.
    try {
      const { changes } = getDb().prepare('DELETE FROM ip_queue').run();
      if (changes) log.info('notoolkit disabled; cleared the enrichment queue', { dropped: changes });
    } catch (err) {
      log.error('could not clear the enrichment queue', { err: String(err) });
    }
    return;
  }
  // One pass at a time: straight on to the next while there is a backlog,
  // otherwise a look every 5 seconds.
  workerRunning = true;
  const tick = async () => {
    workerTimer = null;
    let handled = 0;
    try {
      handled = await drainIpQueue(Date.now() + DRAIN_SLICE_MS);
      await fillAsnDetail();
      report();
    } catch (err) {
      log.error('enrichment worker failed', { err: String(err) });
    }
    if (workerRunning) workerTimer = setTimeout(() => void tick(), handled ? 0 : 5000);
  };
  void tick();
}

export function stopEnrichWorker() {
  workerRunning = false;
  clearTimeout(workerTimer);
  workerTimer = null;
}

export function enrichmentStatus() {
  let queueDepth = 0;
  let asnPending = 0;
  try {
    const db = getDb();
    queueDepth = prep().queueDepth.get().n;
    asnPending = db
      .prepare('SELECT COUNT(*) AS n FROM asn_names WHERE detail_at IS NULL')
      .get().n;
  } catch {
    /* status must never throw */
  }
  return {
    queueDepth,
    asnPending,
    maxmind: { ...maxmindStatus },
    notoolkitEnabled: config.notoolkit.enabled,
  };
}

export { NOTOOLKIT };
