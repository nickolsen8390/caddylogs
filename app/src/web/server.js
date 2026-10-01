// Fastify server: JSON API + the built React UI.

import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { config } from '../config.js';
import { logger } from '../util/log.js';
import { getDb } from '../db.js';
import {
  COOKIE_NAME, loadUsers, verifyCredentials, createSession, readSession,
  destroySession, recordLoginAttempt, isLockedOut, cookieOptions, clientIp, secureContextDiagnosis,
} from './auth.js';
import { registerApi } from './routes.js';
import { registerCaddyApi } from './caddy.js';
import { initMaxmind } from '../enrich/maxmind.js';

const log = logger('web');

/** Optional parts of the interface, so the UI can leave out what is switched off. */
const features = () => ({ caddy: config.caddy.enabled, notoolkit: config.notoolkit.enabled });

/** What the sign-in page offers (0 days: no "keep me signed in"). Public. */
const loginOptions = () => ({ rememberDays: config.auth.rememberDays });

/** Operator-facing next step for each way the secure-context check can fail. */
const INSECURE_HINTS = {
  forwarded_proto_not_https:
    'Your reverse proxy reports the browser connected over plain HTTP. Load the ' +
    'site as https://, and make sure the proxy actually serves TLS for this ' +
    'hostname (for an internal-only name, Caddy needs `tls internal` since ACME ' +
    'cannot validate it).',
  no_forwarded_proto:
    'No X-Forwarded-Proto header arrived. Caddy sets it automatically on ' +
    'reverse_proxy, so this usually means the browser reached the app directly ' +
    'rather than through the proxy.',
  untrusted_proxy:
    'X-Forwarded-Proto arrived but the peer address is not in TRUSTED_PROXIES, ' +
    'so it was ignored. Add the proxy address to TRUSTED_PROXIES in .env.',
  trust_proxy_disabled:
    'TRUST_PROXY is false, so proxy headers are ignored entirely. Set ' +
    'TRUST_PROXY=true when running behind a reverse proxy.',
  default:
    'Serve the UI over HTTPS, or set COOKIE_SECURE=false in .env for plain-HTTP access.',
};

export async function buildServer() {
  getDb();
  await loadUsers();
  // The web process does no enrichment, but it reports on it. Opening the
  // GeoLite2 files here (read-only, memory-mapped) is what lets the Health
  // page tell the truth about whether they loaded.
  await initMaxmind();

  const app = Fastify({
    // No Fastify logger at all: this app logs through src/util/log.js, so
    // there is nothing to disable. (`disableRequestLogging` is deprecated in
    // Fastify 5 and only meaningful when a logger is configured.)
    logger: false,
    trustProxy: false, // client IP is resolved explicitly in auth.clientIp
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        // The UI is a self-contained bundle: no CDNs, no inline scripts.
        scriptSrc: ["'self'"],
        // React and Recharts set style attributes on elements at runtime.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.auth.cookieSecure
      ? { maxAge: 15552000, includeSubDomains: true }
      : false,
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // No cookie signing secret: the session cookie is 32 random bytes that the
  // server looks up (stored hashed), so there is nothing to sign — a forged
  // or altered cookie simply matches no session.
  await app.register(cookie, { parseOptions: {} });

  await app.register(rateLimit, {
    global: false,
    max: config.auth.apiRateLimit,
    timeWindow: '1 minute',
    keyGenerator: (req) => clientIp(req.raw) ?? 'unknown',
  });

  // -------------------------------------------------------------------------
  //  Authentication
  // -------------------------------------------------------------------------

  const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/me', '/healthz']);

  app.decorateRequest('session', null);

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') && req.url !== '/healthz') return; // static assets
    const url = req.url.split('?')[0];

    const token = req.cookies?.[COOKIE_NAME];
    req.session = token ? readSession(token) : null;

    if (PUBLIC_PATHS.has(url)) return;
    if (!req.session) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Double-submit CSRF check on every state-changing request. The token is
    // handed out with the session and is never in a cookie by itself, so a
    // cross-site form post cannot supply it.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const sent = req.headers['x-csrf-token'];
      if (!sent || sent !== req.session.csrf) {
        return reply.code(403).send({ error: 'csrf' });
      }
    }
  });

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 1, maxLength: 512 },
            remember: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const ip = clientIp(req.raw);
      if (isLockedOut(ip)) {
        log.warn('login blocked by throttle', { ip });
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const { username, password } = req.body;
      const ok = await verifyCredentials(username, password);
      recordLoginAttempt(ip, username, ok);
      if (!ok) {
        log.warn('failed login', { ip, username: String(username).slice(0, 60) });
        // Deliberately vague: never reveal whether the user exists.
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      // Refuse rather than hand out a cookie the browser is guaranteed to
      // throw away: a `Secure` cookie on an http:// origin is dropped
      // silently, which would show up as an unexplained flash back to this
      // page. The diagnosis says which condition failed, because "not secure"
      // alone leaves three very different fixes to guess between.
      if (config.auth.cookieSecure) {
        const ctx = secureContextDiagnosis(req.raw);
        if (!ctx.secure) {
          log.error('sign-in blocked: session cookie could not be set', {
            reason: ctx.reason,
            peer: ctx.peer,
            peerTrusted: ctx.trusted,
            forwardedProto: ctx.forwardedProto,
            hint: INSECURE_HINTS[ctx.reason] ?? INSECURE_HINTS.default,
          });
          // Safe to be specific: the password already verified, so this is
          // deployment information the operator is entitled to.
          return reply.code(400).send({
            error: 'insecure_context',
            reason: ctx.reason,
            observed: {
              peer: ctx.peer,
              peerTrusted: ctx.trusted,
              forwardedProto: ctx.forwardedProto,
            },
          });
        }
      }

      const { token, csrf, persistent } = createSession(
        username,
        ip,
        req.headers['user-agent'],
        req.body.remember === true
      );
      reply.setCookie(COOKIE_NAME, token, cookieOptions(persistent));
      log.info('login', { ip, username, remember: persistent });
      return { username, csrf, features: features(), login: loginOptions() };
    }
  );

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req.cookies?.[COOKIE_NAME]);
    reply.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.session) return { authenticated: false, login: loginOptions() };
    return {
      authenticated: true,
      username: req.session.username,
      csrf: req.session.csrf,
      features: features(),
      login: loginOptions(),
    };
  });

  // -------------------------------------------------------------------------
  //  API + static UI
  // -------------------------------------------------------------------------

  await registerApi(app);
  await registerCaddyApi(app);

  app.get('/healthz', async () => ({ ok: true }));

  await app.register(fastifyStatic, {
    root: config.publicDir,
    index: ['index.html'],
    // Hashed asset filenames may be cached hard; index.html must not be.
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });

  // SPA fallback: any non-API path renders the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'bad_request' });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (err.statusCode === 413) return reply.code(413).send({ error: 'too_large' });
    log.error('request failed', { url: req.url, err: String(err.message), stack: err.stack });
    // Never leak internals to the client.
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

export async function startWeb() {
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info('listening', { port: config.port, publicDir: config.publicDir });
  return app;
}

export const PUBLIC_DIR = path.resolve(config.publicDir);
