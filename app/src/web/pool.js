// Worker threads for the reports (reports.js). The web server answers every
// request on one thread, and SQLite queries block it while they run: a
// dashboard over a busy day of millions of requests used to stall sign-in,
// the live stream and every other page with it. The reports run here
// instead, QUERY_WORKERS at a time (0 runs them on the web thread, as
// before). Identical requests at the same time share one answer, and an
// answer is reused for CACHE_MS — pages refresh every 30 seconds, often in
// several tabs.

import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { REPORTS, ReportError } from './reports.js';

const log = logger('reports');

const CACHE_MS = 10_000;
const CACHE_MAX = 200;
/** Reports whose answer may be up to CACHE_MS old. */
const CACHEABLE = new Set(['overview', 'traffic', 'series', 'top', 'countries', 'latency', 'domains', 'clients', 'domain']);

export class ReportPool {
  constructor(size = config.web.queryWorkers) {
    this.size = size;
    this.slots = [];
    this.queue = [];
    this.inFlight = new Map(); // key -> Promise
    this.cache = new Map(); // key -> { body, at }
    this.stopping = false;
    for (let i = 0; i < size; i++) this.spawn();
  }

  spawn() {
    const slot = { worker: new Worker(new URL('./worker.js', import.meta.url)), job: null };
    slot.worker.on('message', (msg) => {
      const job = slot.job;
      slot.job = null;
      if (job) {
        if (msg.status) job.reject(new ReportError(msg.status.statusCode, msg.status.body));
        else if (msg.error) job.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack }));
        else job.resolve(msg.body);
      }
      this.dispatch();
    });
    slot.worker.on('error', (err) => log.error('report worker failed', { err: String(err), stack: err?.stack }));
    slot.worker.on('exit', (code) => {
      this.slots = this.slots.filter((s) => s !== slot);
      slot.job?.reject(new Error(`report worker exited (${code})`));
      if (!this.stopping) {
        log.warn('report worker exited; starting another', { code });
        this.spawn();
        this.dispatch();
      }
    });
    this.slots.push(slot);
  }

  dispatch() {
    for (const slot of this.slots) {
      if (slot.job || !this.queue.length) continue;
      slot.job = this.queue.shift();
      slot.worker.postMessage({ name: slot.job.name, query: slot.job.query, params: slot.job.params });
    }
  }

  /** The body of report `name` for a request's query string and path parameters. */
  run(name, query = {}, params = {}) {
    if (!this.size) return Promise.resolve().then(() => REPORTS[name](query, params));
    const key = `${name}\n${JSON.stringify(query)}\n${JSON.stringify(params)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.body);
    const running = this.inFlight.get(key);
    if (running) return running;

    const p = new Promise((resolve, reject) => {
      this.queue.push({ name, query: { ...query }, params, resolve, reject });
      this.dispatch();
    });
    this.inFlight.set(key, p);
    p.then(
      (body) => {
        if (!CACHEABLE.has(name)) return;
        if (this.cache.size >= CACHE_MAX) {
          const now = Date.now();
          for (const [k, v] of this.cache) if (now - v.at >= CACHE_MS) this.cache.delete(k);
          if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, { body, at: Date.now() });
      },
      () => {}
    ).finally(() => this.inFlight.delete(key));
    return p;
  }

  async stop() {
    this.stopping = true;
    for (const job of this.queue) job.reject(new Error('shutting down'));
    this.queue = [];
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}
