// Live log stream.
//
// One poller serves every connected client: it reads new event rows once per
// tick and fans them out, so twenty open browser tabs cost the database the
// same as one. Each subscriber applies its own filters in memory.

import { eventsAfter, maxEventId, LATENCY_RANGES } from '../queries.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('stream');

class StreamHub {
  constructor() {
    this.subs = new Set();
    this.timer = null;
    this.cursor = 0;
  }

  subscribe(sub) {
    if (!this.subs.size) {
      this.cursor = maxEventId();
      this.timer = setInterval(() => this.tick(), config.stream.pollMs);
    }
    this.subs.add(sub);
    return () => this.unsubscribe(sub);
  }

  unsubscribe(sub) {
    this.subs.delete(sub);
    if (!this.subs.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick() {
    if (!this.subs.size) return;
    let rows;
    try {
      rows = eventsAfter(this.cursor, {}, config.stream.maxPerTick);
    } catch (err) {
      log.error('stream poll failed', { err: String(err) });
      return;
    }
    if (!rows.length) {
      // Comment frame doubles as a keep-alive through proxies.
      for (const sub of this.subs) sub.ping();
      return;
    }

    // If a tick fills the page, the server is producing requests faster than
    // the stream can carry them. Skip forward to the newest row rather than
    // falling further behind every tick, and tell clients they missed some —
    // a live tail should show *now*, and the aggregates remain complete.
    let skipped = 0;
    if (rows.length >= config.stream.maxPerTick) {
      const newest = maxEventId();
      skipped = Math.max(0, newest - rows[rows.length - 1].id);
      this.cursor = newest;
    } else {
      this.cursor = rows[rows.length - 1].id;
    }

    for (const sub of this.subs) {
      try {
        sub.push(rows, skipped);
      } catch {
        this.unsubscribe(sub);
      }
    }
  }

  get size() {
    return this.subs.size;
  }
}

export const hub = new StreamHub();

/**
 * Filters the live stream cannot apply: it carries requests from now on, so
 * a time range is the stored-request search's alone.
 */
export const SEARCH_ONLY_FILTERS = ['from', 'to'];

const lower = (v) => (v === null || v === undefined ? '' : String(v).toLowerCase());

/**
 * The live stream's filter: every request-search filter except a time range,
 * applied in memory to each request as it arrives. Mirrors eventFilters() in
 * queries.js clause by clause, so a filter keeps its meaning when the page
 * goes from live to a search and back. (SQL LIKE ignores ASCII case, hence
 * the lowercased substring matches.)
 */
export function makeFilter(q) {
  const tests = [];
  const add = (fn) => tests.push(fn);
  const has = (k) => q[k] !== undefined && q[k] !== null && q[k] !== '';

  const exact = (key, column = key, norm = (v) => String(v)) => {
    if (!has(key)) return;
    const want = norm(q[key]);
    add((e) => e[column] !== null && e[column] !== undefined && String(e[column]) === want);
  };
  exact('host', 'host', (v) => String(v).toLowerCase());
  exact('ip');
  exact('method', 'method', (v) => String(v).toUpperCase());
  for (const k of ['browser', 'os', 'device', 'proto', 'path', 'ua', 'channel', 'lang',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) exact(k);

  // Sentinel values the aggregates use for "no value recorded".
  if (has('tls')) {
    const v = String(q.tls);
    add((e) => (v === '(none)' ? !e.tls_version : e.tls_version === v));
  }
  if (has('cipher')) {
    const v = String(q.cipher);
    add((e) => (v === '(none)' ? !e.tls_cipher : e.tls_cipher === v));
  }
  if (has('country')) {
    const v = String(q.country).toUpperCase();
    add((e) => (v === 'XX' ? !e.country : e.country === v));
  }
  if (has('asn')) {
    const n = parseInt(q.asn, 10);
    if (Number.isFinite(n)) add((e) => (n === 0 ? !e.asn : e.asn === n));
  }
  if (has('referer')) {
    const v = String(q.referer);
    add((e) =>
      v === '(direct)'
        ? !e.referer
        : e.referer_host === v || (!e.referer_host && lower(e.referer).includes(`//${lower(v)}`))
    );
  }
  if (has('ext')) {
    const v = lower(q.ext);
    add((e) => {
      const path = e.path ?? '';
      return v === '(none)' ? !path.includes('.') || path.endsWith('/') : lower(path).endsWith(`.${v}`);
    });
  }
  if (has('status')) {
    const s = String(q.status);
    if (/^[1-5]xx$/i.test(s)) {
      const lo = parseInt(s[0], 10) * 100;
      add((e) => e.status >= lo && e.status < lo + 100);
    } else if (/^\d{3}$/.test(s)) {
      add((e) => String(e.status) === s);
    }
  }
  if (has('lat') && LATENCY_RANGES[q.lat]) {
    const [lo, hi] = LATENCY_RANGES[q.lat];
    add((e) => e.dur_ms >= lo && (hi === null || e.dur_ms < hi));
  }
  if (has('minDur')) {
    const n = Number(q.minDur);
    if (Number.isFinite(n)) add((e) => e.dur_ms >= n);
  }
  if (q.bots === 'only') add((e) => Boolean(e.bot));
  if (q.bots === 'exclude') add((e) => !e.bot);
  if (q.pageview === '1') {
    add((e) => e.nav === 1 && ((e.status >= 200 && e.status < 300) || e.status === 304));
  }
  if (has('q')) {
    const needle = lower(q.q);
    add((e) =>
      [e.path, e.ua, e.referer, e.ip, e.host, e.query].some((v) => lower(v).includes(needle))
    );
  }
  if (has('uaq')) {
    const needle = lower(q.uaq);
    add((e) => lower(e.ua).includes(needle));
  }
  if (has('pathq')) {
    const needle = lower(q.pathq);
    add((e) => lower(e.path).includes(needle));
  }

  return (e) => tests.every((t) => t(e));
}
