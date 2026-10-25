import path from 'node:path';

const bool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
/** A size such as 500MB, 20GB or 1.5TB, or a bare number of megabytes, in MB. */
export function sizeMb(v, d) {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(m|mb|mib|g|gb|gib|t|tb|tib)?$/i);
  if (!m) return d;
  const unit = (m[2] || 'mb')[0].toLowerCase();
  const mb = parseFloat(m[1]) * (unit === 't' ? 1024 * 1024 : unit === 'g' ? 1024 : 1);
  return Math.max(0, Math.round(mb));
}
const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env;

/**
 * EMBED_ORIGINS: the origins (scheme://host[:port]) allowed to show this app
 * in a frame. Each is normalised by URL — scheme and host lowercased, the
 * trailing slash and a default port dropped. Anything that is not exactly an
 * http(s) origin (a path, a query, credentials, a wildcard) is left out and
 * reported in `invalid`, which the web process logs at startup.
 * @returns {{origins: string[], invalid: string[]}}
 */
export function parseOrigins(raw) {
  const origins = [];
  const invalid = [];
  for (const entry of list(raw)) {
    let u = null;
    try {
      u = new URL(entry);
    } catch {
      /* not a URL at all */
    }
    const ok =
      u &&
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !entry.includes('*') &&
      (u.pathname === '/' || u.pathname === '') &&
      !u.search && !u.hash && !u.username && !u.password;
    if (!ok) invalid.push(entry);
    else if (!origins.includes(u.origin)) origins.push(u.origin);
  }
  return { origins, invalid };
}

export const NOTOOLKIT_DEFAULT_URL = 'https://api.notoolkit.com/v1/';
const RETIRED_HOSTS = new Set(['notoolkit.com', 'www.notoolkit.com']);

/**
 * The notoolkit API base URL and Host header to use. The API used to answer
 * query strings on the site root (https://notoolkit.com/?ip=…); that address
 * was retired with HTTP 410 in favour of https://api.notoolkit.com/v1/.
 * `.env.example` spelled the old URL out up to 1.2.1, so most .env files
 * still carry it: a root path gains /v1/, and the old hostname — in the URL
 * or in NOTOOLKIT_HOST_HEADER — becomes api.notoolkit.com. `migrated` says so.
 *
 * @returns {{url:string, hostHeader:string, configuredUrl:string, migrated:boolean}}
 */
export function notoolkitEndpoint(rawUrl, rawHostHeader) {
  const configuredUrl = (rawUrl || '').trim() || NOTOOLKIT_DEFAULT_URL;
  let hostHeader = (rawHostHeader || '').trim();
  let migrated = false;

  let u;
  try {
    u = new URL(configuredUrl);
  } catch {
    // Unparseable: keep it, so the lookup fails with a message naming it.
    return { url: configuredUrl, hostHeader, configuredUrl, migrated };
  }
  if (RETIRED_HOSTS.has(u.hostname.toLowerCase())) {
    u.hostname = 'api.notoolkit.com';
    migrated = true;
  }
  if (RETIRED_HOSTS.has(hostHeader.toLowerCase())) {
    hostHeader = 'api.notoolkit.com';
    migrated = true;
  }
  if (u.pathname === '/' || u.pathname === '') {
    u.pathname = '/v1/';
    migrated = true;
  }
  u.search = '';
  u.hash = '';
  const url = u.toString().replace(/\/*$/, '/');
  return { url, hostHeader, configuredUrl, migrated };
}

export const config = {
  mode: (env.APP_MODE || 'all').toLowerCase(), // web | ingest | all
  tz: env.TZ || 'UTC',
  logLevel: env.LOG_LEVEL || 'info',

  port: int(env.INTERNAL_PORT, 8899),
  host: '0.0.0.0', // inside the container; host exposure is set by compose
  publicPort: int(env.APP_PORT, 8899),

  dbPath: env.DB_PATH || path.resolve('./data/stats.db'),
  publicDir: env.PUBLIC_DIR || path.resolve('./public'),

  logDir: env.LOG_DIR || '/logs',
  logGlob: env.CADDY_LOG_GLOB || '*.log',
  ignoreHosts: new Set(list(env.IGNORE_HOSTS).map((h) => h.toLowerCase())),
  ignoreCidrs: list(env.IGNORE_CIDRS),

  auth: {
    users: env.AUTH_USERS || '',
    ttlHours: int(env.SESSION_TTL_HOURS, 12),
    idleMinutes: int(env.SESSION_IDLE_MINUTES, 120),
    // "Keep me signed in": such a session has no idle timeout and lasts this
    // many days. 0 removes the option from the sign-in page.
    rememberDays: Math.max(0, int(env.SESSION_REMEMBER_DAYS, 30)),
    trustProxy: bool(env.TRUST_PROXY, true),
    trustedProxies: list(env.TRUSTED_PROXIES).length
      ? list(env.TRUSTED_PROXIES)
      : ['127.0.0.1', '::1', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16'],
    cookieSecure: bool(env.COOKIE_SECURE, true),
    // Pages allowed to show this app in a frame (see parseOrigins, and the
    // embedding protocol in ui/src/lib/embed.js). Empty: framing is refused.
    embed: parseOrigins(env.EMBED_ORIGINS),
    maxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 8),
    windowMinutes: int(env.LOGIN_WINDOW_MINUTES, 15),
    apiRateLimit: int(env.API_RATE_LIMIT, 600),
  },

  retention: {
    days: int(env.RETENTION_DAYS, 365),
    hourlyDays: int(env.HOURLY_RETENTION_DAYS, 45),
    // Starting values for the Settings page, which overrides both (settings.js).
    // 0 hours = keep stored requests until the database reaches its size limit.
    rawHours: Math.max(0, int(env.RAW_RETENTION_HOURS, 48)),
    // 0 = no limit. Accepts 500MB, 20GB, 1.5TB, or a number of megabytes.
    maxDbSizeMb: sizeMb(env.MAX_DB_SIZE, 0),
    // Replaced by MAX_DB_SIZE in 1.3.0; kept only to warn that it is ignored.
    legacyMaxRows: env.RAW_MAX_ROWS ?? null,
    dimTopN: int(env.DIM_TOP_N, 250),
    dimCompactAfterDays: int(env.DIM_COMPACT_AFTER_DAYS, 7),
    // A dimension with more values than this in one hour (an API whose every
    // lookup is a new URL) is trimmed this many hours after, not after days.
    dimHourlyMax: Math.max(1, int(env.DIM_HOURLY_MAX, 2000)),
    dimCompactAfterHours: Math.max(1, int(env.DIM_COMPACT_AFTER_HOURS, 1)),
  },

  notoolkit: {
    enabled: bool(env.NOTOOLKIT_ENABLED, true),
    // The versioned API base; lookups are paths under it: ip/{address} and
    // asn/{number}. A setting written for the retired API is translated.
    ...notoolkitEndpoint(env.NOTOOLKIT_API_URL, env.NOTOOLKIT_HOST_HEADER),
    // The public API needs no authentication; these exist only so a key can be
    // supplied without a code change if that ever becomes necessary.
    key: env.NOTOOLKIT_API_KEY || '',
    // hostHeader (from notoolkitEndpoint): lets NOTOOLKIT_API_URL point
    // straight at an origin server by address while still presenting the
    // virtual host it expects. Needed when the public name cannot be reached
    // from inside the container (NAT hairpin).
    authHeader: env.NOTOOLKIT_AUTH_HEADER || 'Authorization',
    authScheme: env.NOTOOLKIT_AUTH_SCHEME === undefined ? 'Bearer' : env.NOTOOLKIT_AUTH_SCHEME,
    ratePerSec: int(env.NOTOOLKIT_RATE_PER_SEC, 10),
    timeoutMs: int(env.NOTOOLKIT_TIMEOUT_MS, 4000),
    concurrency: int(env.NOTOOLKIT_CONCURRENCY, 4),
    maxRetries: int(env.NOTOOLKIT_MAX_RETRIES, 5),
  },

  maxmind: {
    enabled: bool(env.MAXMIND_ENABLED, true),
    countryDb: env.MAXMIND_COUNTRY_DB || '/geoip/GeoLite2-Country.mmdb',
    asnDb: env.MAXMIND_ASN_DB || '/geoip/GeoLite2-ASN.mmdb',
  },

  enrich: {
    ttlDays: int(env.ENRICH_TTL_DAYS, 30),
    // Registrant detail changes rarely, and it is one lookup per distinct ASN.
    asnTtlDays: int(env.ENRICH_ASN_TTL_DAYS, 90),
    inlineTimeoutMs: int(env.ENRICH_INLINE_TIMEOUT_MS, 2000),
  },

  bots: {
    // Count a "Chrome" that sends none of Chrome's Sec-Fetch / client-hint
    // headers as a bot. Switch off if a log filter removes those headers.
    headerCheck: bool(env.BOT_HEADER_CHECK, true),
  },

  ingest: {
    batchSize: int(env.INGEST_BATCH_SIZE, 2000),
    flushMs: int(env.INGEST_FLUSH_MS, 1000),
    rollupLagMs: int(env.ROLLUP_LAG_MS, 15000),
  },

  stream: {
    pollMs: Math.max(100, int(env.STREAM_POLL_MS, 400)),
    maxPerTick: int(env.STREAM_MAX_EVENTS_PER_TICK, 300),
  },

  caddy: {
    // Master switch for the Caddy configuration pages.
    enabled: bool(env.CADDY_MANAGE, true),
    // The Caddyfile as seen inside this container. Its DIRECTORY is the mount,
    // so saves can be atomic (write a temp file, rename over the original).
    caddyfile: env.CADDYFILE_PATH || '/caddy/Caddyfile',
    // Caddy's admin endpoint. A unix socket shared through a bind mount keeps
    // the admin API off the network entirely. Same syntax Caddy uses:
    //   unix//run/caddy/admin.sock     or     http://127.0.0.1:2019
    admin: env.CADDY_ADMIN_ADDRESS || 'unix//run/caddy/admin.sock',
    timeoutMs: int(env.CADDY_ADMIN_TIMEOUT_MS, 15000),
    // Usernames allowed to change the configuration. Empty = every user.
    editors: list(env.CADDY_EDITORS),
    // Past versions of the Caddyfile kept for restore.
    historyKeep: Math.max(5, int(env.CADDY_HISTORY_KEEP, 100)),
  },
};

/** Fatal-check configuration that the process cannot run without. */
export function validateConfig({ needsAuth }) {
  const problems = [];
  if (needsAuth) {
    if (!config.auth.users.trim()) {
      problems.push('AUTH_USERS is empty. Set at least one user, e.g. AUTH_USERS=admin:s0me-long-password');
    }
    if (/(^|,)\s*admin\s*:\s*change-me-immediately\s*(,|$)/i.test(config.auth.users)) {
      problems.push('AUTH_USERS still contains the example password. Change it before starting.');
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[config] FATAL: ${p}`);
    process.exit(1);
  }
}
