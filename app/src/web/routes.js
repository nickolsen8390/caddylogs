// JSON API. Every handler below runs behind the session check in server.js.

import * as Q from '../queries.js';
import { ReportPool } from './pool.js';
import { ReportError } from './reports.js';
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

/** Longest a live stream goes without an event the page can see. */
const STREAM_BEAT_MS = 10_000;
/** Unsent output after which a live stream's reader is taken to be gone. */
const STREAM_MAX_BUFFERED = 1024 * 1024;

export async function registerApi(app) {
  const rl = { config: { rateLimit: { max: config.auth.apiRateLimit, timeWindow: '1 minute' } } };

  // The reports (reports.js), in worker threads (pool.js). A report can
  // answer with another status by throwing a ReportError.
  const pool = new ReportPool();
  app.addHook('onClose', () => pool.stop());
  const report = (name, params = () => ({})) => async (req, reply) => {
    try {
      return await pool.run(name, req.query, params(req));
    } catch (err) {
      if (err instanceof ReportError) return reply.code(err.statusCode).send(err.body);
      throw err;
    }
  };

  // --- dashboard, traffic, domains, clients ----------------------------------

  app.get('/api/overview', rl, report('overview'));
  app.get('/api/traffic', rl, report('traffic'));
  app.get('/api/series', rl, report('series'));
  app.get('/api/top/:dim', rl, report('top', (req) => ({ dim: req.params.dim })));
  app.get('/api/countries', rl, report('countries'));
  app.get('/api/latency', rl, report('latency'));
  app.get('/api/domains', rl, report('domains'));
  app.get('/api/clients', rl, report('clients'));
  app.get('/api/domains/:host', rl, report('domain', (req) => ({ host: req.params.host })));

  // --- raw events / stream -------------------------------------------------

  // NOTE ON NAMING: these are deliberately /api/request(s), not /api/events.
  // Content blockers ship rules that match analytics endpoints by path, and
  // "/api/events" is one of the patterns they match — requests to it were
  // being dropped by the browser before reaching the server, which surfaced as
  // an unexplained "Failed to fetch" with nothing in the access log. Do not
  // rename these back.

  app.get('/api/requests', rl, report('requests'));

  app.get('/api/request/:id', rl, async (req, reply) => {
    const result = Q.eventById(req.params.id);
    if (!result.found) {
      // 404 with a reason, so the client stops guessing why.
      return reply.code(404).send({ error: 'not_found', ...result });
    }
    return result;
  });

  app.get('/api/ip/:ip', rl, report('ip', (req) => ({ ip: req.params.ip })));
  app.get('/api/asn/:asn', rl, report('asn', (req) => ({ asn: req.params.asn })));

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
    const events = (await pool.run('ingest')).counts.events;
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
    for (const key of ['rawRetentionHours', 'maxDbSizeMb', 'rawLineHours']) {
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
      ingest: (await pool.run('ingest')),
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
