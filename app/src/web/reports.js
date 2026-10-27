// The API's read-only reports: everything a page asks for that can take a
// while on a busy database. Each takes the request's query string (and path
// parameters) and returns the JSON body. They run in worker threads (pool.js),
// so a slow one never holds up the web server itself — sign-in, the live
// stream, other pages.

import * as Q from '../queries.js';
import { config } from '../config.js';
import { retentionInfo } from '../settings.js';

const DAY = 86_400_000;

/** Dimensions the API is willing to expose, so `dim` can never reach SQL raw. */
export const DIMS = new Set([
  'status', 'method', 'path', 'ip', 'ua', 'browser', 'os', 'device',
  'country', 'asn', 'referer', 'proto', 'tls', 'cipher', 'ext', 'lat', 'kind',
  'page', 'entry', 'exit', 'channel', 'refsite', 'lang', 'broken',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]);

const PRESETS = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '365d': 365 * DAY,
};

/** Resolve `range` / `from` / `to` query params into a millisecond window. */
export function windowOf(q) {
  const now = Date.now();
  if (q.from || q.to) {
    const from = Number(q.from);
    const to = Number(q.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      // Clamp to the retention period so a hand-crafted request cannot ask for
      // an unbounded scan.
      const floor = now - config.retention.days * DAY;
      return { from: Math.max(from, floor), to: Math.min(to, now + 3_600_000) };
    }
  }
  const span = PRESETS[q.range] ?? DAY;
  return { from: now - span, to: now };
}

export const intParam = (v, d, max = 1000) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(0, n));
};

/** An answer other than 200, thrown by a report and sent by the route. */
export class ReportError extends Error {
  constructor(statusCode, body) {
    super(body.error);
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Requests per second in a window: the mean, over the part of the window the
 * totals cover (all of it, unless it starts before the stored requests; see
 * Q.totals), and the busiest step of the series. Time before the first data
 * is not counted, so a new install is not averaged against hours it was off.
 */
function requestRate(from, to, totals, previous, series) {
  // The first hour's aggregates start on the hour; while the stored requests
  // still reach back that far, they say when the first one really came.
  const { events: ev, aggregates: ag } = Q.dataRange();
  const firstData = (ev.from && (!ag.from || ev.from - ag.from < 3_600_000) ? ev.from : ag.from) ?? from;
  const start = Math.max(totals.covered_from ?? from, firstData);
  const count = totals.requests;
  const end = Math.min(to, Date.now());
  const secs = (end - start) / 1000;
  // Each step over the time it really spans: the one under way, and the
  // first after the data begins, are partly empty. Under half a step is too
  // little to call a rate.
  let peak = null;
  for (const p of series.points) {
    const covered = (Math.min((p.bucket + series.step) * 1000, end) - Math.max(p.bucket * 1000, firstData, from)) / 1000;
    if (covered >= series.step / 2) peak = Math.max(peak ?? 0, p.requests / covered);
  }
  return {
    mean: secs > 0 ? count / secs : 0,
    previous: previous.requests / ((to - from) / 1000),
    peak,
    step: series.step,
  };
}

export const REPORTS = {
  overview(q) {
    const { from, to } = windowOf(q);
    const host = q.host || null;
    const prev = { from: from - (to - from), to: from };
    const totals = Q.totals(from, to, host);
    const previous = Q.totals(prev.from, prev.to, host);
    const series = Q.series(from, to, host, intParam(q.step, null, 604800) || null);
    return {
      window: { from, to },
      totals,
      previous,
      rate: requestRate(from, to, totals, previous, series),
      series,
      status: Q.topDim('status', from, to, { host, limit: 15, totals: false }).rows,
      topPaths: Q.topDim('path', from, to, { host, limit: 10, totals: false }).rows,
      topIps: Q.topDim('ip', from, to, { host, limit: 10, totals: false }).rows,
      topReferers: Q.topDim('referer', from, to, { host, limit: 10, totals: false }).rows,
      topBrowsers: Q.topDim('browser', from, to, { host, limit: 8, totals: false }).rows,
      countries: Q.countries(from, to, host),
      topAsns: Q.topAsns(from, to, { host, limit: 8 }),
      topDomains: Q.domains(from, to).slice(0, 10),
      latency: Q.latency(from, to, host),
      kind: Q.topDim('kind', from, to, { host, limit: 4, totals: false }).rows,
    };
  },

  // Visitor analytics. `pages` and `broken` count page views; everything
  // else counts visits, credited to the page each visit started on.
  traffic(q) {
    const { from, to } = windowOf(q);
    const host = q.host || null;
    const prev = { from: from - (to - from), to: from };
    // Only the page count and the referred-visit total are shown, so the
    // other lists skip topDim's second, totals query.
    const top = (dim, limit = 10, totals = false) => Q.topDim(dim, from, to, { host, limit, totals });
    return {
      window: { from, to },
      active: Q.activeVisitors(host),
      totals: Q.totals(from, to, host),
      previous: Q.totals(prev.from, prev.to, host),
      series: Q.series(from, to, host),
      pages: top('page', 10, true),
      entries: top('entry'),
      exits: top('exit'),
      channels: top('channel', 12),
      referrers: top('refsite', 10, true),
      languages: top('lang'),
      broken: top('broken'),
      utm: Object.fromEntries(
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((d) => [d, top(d)])
      ),
    };
  },

  series(q) {
    const { from, to } = windowOf(q);
    return Q.series(from, to, q.host || null, intParam(q.step, null, 604800) || null);
  },

  top(q, { dim }) {
    if (!DIMS.has(dim)) throw new ReportError(400, { error: 'unknown_dimension' });
    const { from, to } = windowOf(q);
    if (dim === 'asn') {
      return { rows: Q.topAsns(from, to, { host: q.host || null, limit: intParam(q.limit, 50) }) };
    }
    return Q.topDim(dim, from, to, {
      host: q.host || null,
      limit: intParam(q.limit, 50),
      offset: intParam(q.offset, 0, 100000),
      sort: q.sort,
      search: q.search,
    });
  },

  countries(q) {
    const { from, to } = windowOf(q);
    return { rows: Q.countries(from, to, q.host || null) };
  },

  latency(q) {
    const { from, to } = windowOf(q);
    return Q.latency(from, to, q.host || null);
  },

  domains(q) {
    const { from, to } = windowOf(q);
    return { window: { from, to }, rows: Q.domains(from, to, { sort: q.sort, search: q.search }) };
  },

  clients(q) {
    const { from, to } = windowOf(q);
    return {
      window: { from, to },
      ...Q.clients(from, to, {
        host: q.host || null,
        sort: q.sort,
        dir: q.dir,
        search: q.search,
        limit: intParam(q.limit, 100),
        offset: intParam(q.offset, 0, 10_000_000),
      }),
    };
  },

  domain(q, { host: rawHost }) {
    const host = String(rawHost).toLowerCase();
    const { from, to } = windowOf(q);
    if (!Q.hostExists(host)) throw new ReportError(404, { error: 'unknown_host' });
    const prev = { from: from - (to - from), to: from };
    return {
      host,
      window: { from, to },
      totals: Q.totals(from, to, host),
      previous: Q.totals(prev.from, prev.to, host),
      series: Q.series(from, to, host),
      latency: Q.latency(from, to, host),
      countries: Q.countries(from, to, host),
      asns: Q.topAsns(from, to, { host, limit: 25 }),
      dims: Object.fromEntries(
        ['status', 'method', 'path', 'ip', 'ua', 'browser', 'os', 'device',
         'referer', 'proto', 'tls', 'cipher', 'ext', 'kind'].map((d) => [
          d,
          Q.topDim(d, from, to, { host, limit: 25, totals: false }).rows,
        ])
      ),
      errorPaths: Q.errorPaths(from, to, host),
    };
  },

  // Paginated drill-down: every dimension in the aggregates can be resolved
  // back to the individual requests that produced it.
  requests(q) {
    const limit = intParam(q.limit, 100, 500);
    const result = Q.searchEvents(q, { limit, before: q.before });
    const active = {};
    for (const key of Q.EVENT_FILTER_KEYS) {
      if (q[key] !== undefined && q[key] !== '') active[key] = q[key];
    }
    return {
      ...result,
      filters: active,
      // Requests are only retained for the raw window, so the UI can say
      // "nothing in the last N hours" instead of implying "never happened".
      retentionHours: retentionInfo().hours,
      maxDbSizeMb: retentionInfo().maxDbSizeMb,
      // A count cannot stop early, so it is only taken when the query is
      // selective enough to be cheap. Broad searches report it as unknown
      // rather than blocking the server to find out.
      total: q.count === '1' && !result.windowed ? Q.countEvents(q) : null,
    };
  },

  ip(q, { ip }) {
    const { from, to } = windowOf(q);
    return Q.ipDetail(String(ip), from, to, q.host || null);
  },

  asn(q, { asn: raw }) {
    const asn = parseInt(String(raw).replace(/^as/i, ''), 10);
    if (!Number.isFinite(asn) || asn <= 0) throw new ReportError(400, { error: 'bad_asn' });
    const { from, to } = windowOf(q);
    return Q.asnDetail(asn, from, to, q.host || null);
  },

  ingest() {
    return Q.ingestStats();
  },
};
