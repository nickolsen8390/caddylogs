// JSON API. Every handler below runs behind the session check in server.js.

import * as Q from '../queries.js';
import { config } from '../config.js';
import { enrichmentStatus } from '../enrich/index.js';
import { readProviderHealth } from '../enrich/health.js';
import { releaseInfo } from '../release.js';
import { hub, makeFilter } from './stream.js';
import { logger } from '../util/log.js';
import { usedBytes, fileBytes } from '../db.js';
import { requestRestore, restoreStatus } from '../ingest/restore.js';
import {
  getSettings, defaultSettings, saveSettings, settingsHistory, retentionInfo, MIN_DB_SIZE_MB,
} from '../settings.js';

/**
 * Who may change configuration — the Caddyfile and the Settings page alike.
 * CADDY_EDITORS lists them; empty means every signed-in user.
 */
const canConfigure = (req) =>
  !config.caddy.editors.length || config.caddy.editors.includes(req.session?.username);

const log = logger('api');

const DAY = 86_400_000;

/** Longest a live stream goes without an event the page can see. */
const STREAM_BEAT_MS = 10_000;
/** Unsent output after which a live stream's reader is taken to be gone. */
const STREAM_MAX_BUFFERED = 1024 * 1024;

/** Dimensions the API is willing to expose, so `dim` can never reach SQL raw. */
const DIMS = new Set([
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
function windowOf(q) {
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

const intParam = (v, d, max = 1000) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(0, n));
};

export async function registerApi(app) {
  const rl = { config: { rateLimit: { max: config.auth.apiRateLimit, timeWindow: '1 minute' } } };

  // --- dashboard -----------------------------------------------------------

  app.get('/api/overview', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    const host = req.query.host || null;
    const prev = { from: from - (to - from), to: from };
    const totals = Q.totals(from, to, host);
    const previous = Q.totals(prev.from, prev.to, host);
    const series = Q.series(from, to, host, intParam(req.query.step, null, 604800) || null);
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
  });

  // Visitor analytics. `pages` and `broken` count page views; everything
  // else counts visits, credited to the page each visit started on.
  app.get('/api/traffic', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    const host = req.query.host || null;
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
  });

  app.get('/api/series', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return Q.series(from, to, req.query.host || null, intParam(req.query.step, null, 604800) || null);
  });

  app.get('/api/top/:dim', rl, async (req, reply) => {
    const dim = req.params.dim;
    if (!DIMS.has(dim)) return reply.code(400).send({ error: 'unknown_dimension' });
    const { from, to } = windowOf(req.query);
    if (dim === 'asn') {
      return { rows: Q.topAsns(from, to, { host: req.query.host || null, limit: intParam(req.query.limit, 50) }) };
    }
    return Q.topDim(dim, from, to, {
      host: req.query.host || null,
      limit: intParam(req.query.limit, 50),
      offset: intParam(req.query.offset, 0, 100000),
      sort: req.query.sort,
      search: req.query.search,
    });
  });

  app.get('/api/countries', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return { rows: Q.countries(from, to, req.query.host || null) };
  });

  app.get('/api/latency', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return Q.latency(from, to, req.query.host || null);
  });

  // --- domains -------------------------------------------------------------

  app.get('/api/domains', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return {
      window: { from, to },
      rows: Q.domains(from, to, { sort: req.query.sort, search: req.query.search }),
    };
  });

  // --- clients -------------------------------------------------------------

  app.get('/api/clients', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return {
      window: { from, to },
      ...Q.clients(from, to, {
        host: req.query.host || null,
        sort: req.query.sort,
        dir: req.query.dir,
        search: req.query.search,
        limit: intParam(req.query.limit, 100),
        offset: intParam(req.query.offset, 0, 10_000_000),
      }),
    };
  });

  app.get('/api/domains/:host', rl, async (req, reply) => {
    const host = String(req.params.host).toLowerCase();
    const { from, to } = windowOf(req.query);
    if (!Q.hostExists(host)) return reply.code(404).send({ error: 'unknown_host' });
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
  });

  // --- raw events / stream -------------------------------------------------

  // NOTE ON NAMING: these are deliberately /api/request(s), not /api/events.
  // Content blockers ship rules that match analytics endpoints by path, and
  // "/api/events" is one of the patterns they match — requests to it were
  // being dropped by the browser before reaching the server, which surfaced as
  // an unexplained "Failed to fetch" with nothing in the access log. Do not
  // rename these back.

  // Paginated drill-down: every dimension in the aggregates can be resolved
  // back to the individual requests that produced it.
  app.get('/api/requests', rl, async (req) => {
    const limit = intParam(req.query.limit, 100, 500);
    const result = Q.searchEvents(req.query, { limit, before: req.query.before });
    const active = {};
    for (const key of Q.EVENT_FILTER_KEYS) {
      if (req.query[key] !== undefined && req.query[key] !== '') active[key] = req.query[key];
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
      total: req.query.count === '1' && !result.windowed ? Q.countEvents(req.query) : null,
    };
  });

  app.get('/api/request/:id', rl, async (req, reply) => {
    const result = Q.eventById(req.params.id);
    if (!result.found) {
      // 404 with a reason, so the client stops guessing why.
      return reply.code(404).send({ error: 'not_found', ...result });
    }
    return result;
  });

  app.get('/api/ip/:ip', rl, async (req) => {
    const { from, to } = windowOf(req.query);
    return Q.ipDetail(String(req.params.ip), from, to, req.query.host || null);
  });

  app.get('/api/asn/:asn', rl, async (req, reply) => {
    const asn = parseInt(String(req.params.asn).replace(/^as/i, ''), 10);
    if (!Number.isFinite(asn) || asn <= 0) return reply.code(400).send({ error: 'bad_asn' });
    const { from, to } = windowOf(req.query);
    return Q.asnDetail(asn, from, to, req.query.host || null);
  });

  // Server-sent events. Fastify's reply is hijacked so the socket stays open.
  app.get('/api/stream', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (req, reply) => {
    if (hub.size >= 32) {
      return reply.code(503).send({ error: 'too_many_streams' });
    }
    const filter = makeFilter(req.query);
    const res = reply.raw;
    reply.hijack();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Tell nginx-style proxies not to buffer. Caddy does not buffer SSE.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ pollMs: config.stream.pollMs })}\n\n`);

    let closed = false;
    const safeWrite = (chunk) => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        cleanup();
        return;
      }
      // Nobody is reading: a phone that went away without closing the
      // connection. Writes pile up until the OS gives up on it, which can take
      // many minutes, holding one of the 32 places meanwhile.
      if (res.writableLength > STREAM_MAX_BUFFERED) cleanup();
    };

    // The page cannot see comments, so when there is nothing to send it gets
    // an event at least every STREAM_BEAT_MS, and can tell a quiet stream from
    // a dead one (Requests.jsx). Comments between keep proxies from timing it out.
    let lastEvent = Date.now();
    const sendEvent = (chunk) => {
      lastEvent = Date.now();
      safeWrite(chunk);
    };
    const idle = () => {
      if (Date.now() - lastEvent >= STREAM_BEAT_MS) sendEvent('event: ping\ndata: {}\n\n');
      else safeWrite(': keep-alive\n\n');
    };

    const sub = {
      push(rows, skipped) {
        if (skipped > 0) {
          sendEvent(`event: skipped\ndata: ${JSON.stringify({ count: skipped })}\n\n`);
        }
        const keep = rows.filter(filter);
        if (!keep.length) return idle();
        sendEvent(`event: events\ndata: ${JSON.stringify(keep)}\n\n`);
      },
      ping: idle,
    };

    const unsubscribe = hub.subscribe(sub);
    function cleanup() {
      if (closed) return;
      closed = true;
      unsubscribe();
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // --- meta ----------------------------------------------------------------

  app.get('/api/meta', rl, async () => {
    const enrichment = enrichmentStatus();
    const providers = readProviderHealth();
    return {
      range: Q.dataRange(),
      retention: {
        days: config.retention.days,
        hourlyDays: config.retention.hourlyDays,
        // null when requests are kept until the size limit (untilFull).
        rawHours: retentionInfo().hours,
        untilFull: retentionInfo().untilFull,
        maxDbSizeMb: retentionInfo().maxDbSizeMb,
        rawFrom: Q.oldestRetainedEvent(),
      },
      enrichment,
      providers,
      warnings: buildWarnings(enrichment, providers),
      streamPollMs: config.stream.pollMs,
    };
  });

  // --- settings ------------------------------------------------------------

  app.get('/api/settings', rl, async (req) => {
    const events = Q.ingestStats().counts.events;
    const oldest = Q.oldestRetainedEvent();
    const used = usedBytes();
    const spanHours = oldest ? Math.max(1, (Date.now() - oldest) / 3_600_000) : null;
    return {
      settings: getSettings(),
      defaults: defaultSettings(),
      history: settingsHistory(),
      canEdit: canConfigure(req),
      limits: { minDbSizeMb: MIN_DB_SIZE_MB },
      restore: restoreStatus(),
      logDir: config.logDir,
      usage: {
        usedBytes: used,
        fileBytes: fileBytes(),
        storedRequests: events,
        oldestRequest: oldest,
        // Rough guide for choosing a size: all data held divided by the
        // requests stored, at the current request rate. Overstates it a
        // little (statistics are counted in), and a lot while requests from
        // before 1.2.3 still carry their uncompressed log line.
        requestsPerHour: spanHours ? Math.round(events / spanHours) : null,
        bytesPerRequest: events ? Math.round(used / events) : null,
      },
    };
  });

  // Put back stored requests from the log files still on disk (restore.js);
  // the ingest process does the work and reports progress through
  // restore_status, returned with /api/settings.
  app.post('/api/settings/restore', rl, async (req, reply) => {
    if (!canConfigure(req)) return reply.code(403).send({ error: 'forbidden' });
    if (!requestRestore(req.session?.username)) return reply.code(409).send({ error: 'already_running' });
    log.info('restore from log files requested', { username: req.session?.username });
    return { status: restoreStatus() };
  });

  app.post('/api/settings', rl, async (req, reply) => {
    if (!canConfigure(req)) return reply.code(403).send({ error: 'forbidden' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const changes = {};
    for (const key of ['rawRetentionHours', 'maxDbSizeMb']) {
      if (body[key] !== undefined) changes[key] = Number(body[key]);
    }
    const result = saveSettings(changes, req.session?.username);
    if (!result.ok) return reply.code(400).send({ error: 'invalid', problems: result.problems });
    log.info('settings changed', { username: req.session?.username, ...result.settings });
    return { settings: result.settings };
  });

  app.get('/api/health', rl, async () => {
    const enrichment = enrichmentStatus();
    const providers = readProviderHealth();
    return {
      ingest: Q.ingestStats(),
      enrichment,
      providers,
      warnings: buildWarnings(enrichment, providers),
    };
  });

  // The running version and the release notes behind it. Fixed for the life
  // of the process, so read once.
  app.get('/api/about', rl, async () => releaseInfo());

  log.info('api routes registered');
}

/** Surfaced as banners in the UI so a silent enrichment outage is visible. */
function buildWarnings(enrichment, providers) {
  const out = [];
  if (config.notoolkit.enabled) {
    const nt = providers.find((p) => p.provider === 'notoolkit');
    if (nt && !nt.ok) {
      out.push({
        level: 'error',
        source: 'notoolkit',
        message: `notoolkit.com lookups are failing: ${nt.last_error ?? 'unknown error'}. ASN data will be stale or missing until this clears.`,
        since: nt.last_error_at,
      });
    }
  }
  if (enrichment.maxmind?.error) {
    out.push({ level: 'warn', source: 'maxmind', message: enrichment.maxmind.error });
  } else if (config.maxmind.enabled && !enrichment.maxmind?.countryDb) {
    out.push({
      level: 'warn',
      source: 'maxmind',
      message: 'GeoLite2 country database not loaded — country data is unavailable.',
    });
  }
  // The queue only exists to retry notoolkit lookups; with them switched off
  // it is emptied at startup and never refilled, so there is nothing to report.
  if (config.notoolkit.enabled && enrichment.queueDepth > 5000) {
    out.push({
      level: 'warn',
      source: 'enrichment',
      message: `${enrichment.queueDepth} IPs are waiting for ASN resolution.`,
    });
  }
  return out;
}
