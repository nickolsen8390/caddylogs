// Live log stream.
//
// One poller serves every connected client: it reads new event rows once per
// tick and fans them out, so twenty open browser tabs cost the database the
// same as one. Each subscriber applies its own filters in memory.

import { eventsAfter, maxEventId } from '../queries.js';
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

/** Client-side filter, mirroring the SQL filters used by /api/events. */
export function makeFilter(q) {
  const host = q.host || null;
  const ip = q.ip || null;
  const method = q.method ? String(q.method).toUpperCase() : null;
  const status = q.status ? String(q.status) : null;
  const bots = q.bots || null;
  const needle = q.q ? String(q.q).toLowerCase() : null;

  return (e) => {
    if (host && e.host !== host) return false;
    if (ip && e.ip !== ip) return false;
    if (method && e.method !== method) return false;
    if (status) {
      if (/^[1-5]xx$/i.test(status)) {
        const lo = parseInt(status[0], 10) * 100;
        if (!(e.status >= lo && e.status < lo + 100)) return false;
      } else if (String(e.status) !== status) return false;
    }
    if (bots === 'only' && !e.bot) return false;
    if (bots === 'exclude' && e.bot) return false;
    if (needle) {
      const hay = `${e.host} ${e.path} ${e.ip ?? ''} ${e.ua ?? ''} ${e.referer ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };
}
