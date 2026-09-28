import path from 'node:path';

const bool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env;

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
    trustProxy: bool(env.TRUST_PROXY, true),
    trustedProxies: list(env.TRUSTED_PROXIES).length
      ? list(env.TRUSTED_PROXIES)
      : ['127.0.0.1', '::1', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16'],
    cookieSecure: bool(env.COOKIE_SECURE, true),
    maxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 8),
    windowMinutes: int(env.LOGIN_WINDOW_MINUTES, 15),
    apiRateLimit: int(env.API_RATE_LIMIT, 600),
  },

  retention: {
    days: int(env.RETENTION_DAYS, 365),
    hourlyDays: int(env.HOURLY_RETENTION_DAYS, 45),
    rawHours: int(env.RAW_RETENTION_HOURS, 48),
    rawMaxRows: int(env.RAW_MAX_ROWS, 5_000_000),
    dimTopN: int(env.DIM_TOP_N, 250),
    dimCompactAfterDays: int(env.DIM_COMPACT_AFTER_DAYS, 7),
  },

  notoolkit: {
    enabled: bool(env.NOTOOLKIT_ENABLED, true),
    // Lookups are query parameters on the root: /?ip=… and /?asn=…
    url: (env.NOTOOLKIT_API_URL || 'https://notoolkit.com/').replace(/\/+$/, '') + '/',
    // The public API needs no authentication; these exist only so a key can be
    // supplied without a code change if that ever becomes necessary.
    key: env.NOTOOLKIT_API_KEY || '',
    // Lets NOTOOLKIT_API_URL point straight at an origin server by address
    // while still presenting the virtual host it expects. Needed when the
    // public name cannot be reached from inside the container (NAT hairpin).
    hostHeader: env.NOTOOLKIT_HOST_HEADER || '',
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
