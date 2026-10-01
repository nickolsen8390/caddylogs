// Authentication: users defined in .env, scrypt password verification,
// server-side sessions, CSRF tokens and login throttling.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { cidrMatcher, normalizeIp } from '../util/net.js';

const log = logger('auth');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const COOKIE_NAME = 'cli_session';

// ---------------------------------------------------------------------------
//  User table from AUTH_USERS
// ---------------------------------------------------------------------------

/** @type {Map<string,{salt:Buffer, hash:Buffer}>} */
const users = new Map();

export async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash };
}

export function encodeHash({ salt, hash }) {
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function loadUsers() {
  users.clear();
  // Entries are separated by commas or newlines; the username is everything
  // before the FIRST colon, so passwords may contain colons (but not commas —
  // use the pre-hashed `scrypt$...` form if you need one that does).
  const entries = config.auth.users
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const idx = entry.indexOf(':');
    if (idx <= 0) {
      log.warn('ignoring malformed AUTH_USERS entry (expected user:password)');
      continue;
    }
    const username = entry.slice(0, idx).trim();
    const secret = entry.slice(idx + 1).trim();
    if (!username || !secret) continue;

    if (secret.startsWith('scrypt$')) {
      const [, saltHex, hashHex] = secret.split('$');
      if (!saltHex || !hashHex) {
        log.warn('ignoring malformed scrypt hash', { username });
        continue;
      }
      users.set(username, {
        salt: Buffer.from(saltHex, 'hex'),
        hash: Buffer.from(hashHex, 'hex'),
      });
    } else {
      // Plaintext in .env is hashed here and never stored anywhere else.
      users.set(username, await hashPassword(secret));
    }
  }
  if (!users.size) {
    log.error('no usable users in AUTH_USERS — nobody can log in');
  } else {
    log.info('loaded users', { count: users.size });
  }
}

// A fixed decoy so a request for an unknown username costs the same as a
// request for a real one, and cannot be used to enumerate accounts.
const decoy = { salt: crypto.randomBytes(16), hash: crypto.randomBytes(SCRYPT.keylen) };

export async function verifyCredentials(username, password) {
  const rec = users.get(username) ?? decoy;
  let derived;
  try {
    derived = await scrypt(password, rec.salt, SCRYPT.keylen, SCRYPT);
  } catch {
    return false;
  }
  const ok = derived.length === rec.hash.length && crypto.timingSafeEqual(derived, rec.hash);
  return ok && users.has(username);
}

// ---------------------------------------------------------------------------
//  Client IP
// ---------------------------------------------------------------------------

let proxyMatcher = null;

/**
 * The socket peer is authoritative unless it is a configured trusted proxy, in
 * which case the last hop in X-Forwarded-For is used. This prevents a client
 * from spoofing its address (and so evading login throttling) by sending its
 * own X-Forwarded-For header.
 */
export function clientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress ?? req.ip);
  if (!config.auth.trustProxy) return peer;
  proxyMatcher ??= cidrMatcher(config.auth.trustedProxies);
  if (!peer || !proxyMatcher(peer)) return peer;

  const xff = req.headers['x-forwarded-for'];
  if (!xff) return peer;
  const parts = String(xff).split(',').map((s) => normalizeIp(s));
  // Walk right-to-left past our own trusted proxies to the first address we
  // did not put there ourselves.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && !proxyMatcher(parts[i])) return parts[i];
  }
  return parts[0] ?? peer;
}

/**
 * Whether the browser reached us over HTTPS, and — when it did not — precisely
 * which condition failed. A `Secure` cookie is silently discarded on an
 * insecure origin, and "your login vanished" is the least debuggable failure
 * this app has, so the caller gets enough detail to name the actual fix.
 *
 * @returns {{secure:boolean, reason:string, peer:string|null,
 *            trusted:boolean, forwardedProto:string|null}}
 */
export function secureContextDiagnosis(req) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  const rawProto = req.headers['x-forwarded-proto'];
  // A proxy chain appends; the first entry is what the client actually used.
  const forwardedProto = rawProto ? String(rawProto).split(',')[0].trim().toLowerCase() : null;

  // TLS terminated on this socket: nothing to infer.
  if (req.socket?.encrypted) {
    return { secure: true, reason: 'direct_tls', peer, trusted: false, forwardedProto };
  }
  if (!config.auth.trustProxy) {
    return { secure: false, reason: 'trust_proxy_disabled', peer, trusted: false, forwardedProto };
  }

  proxyMatcher ??= cidrMatcher(config.auth.trustedProxies);
  const trusted = Boolean(peer && proxyMatcher(peer));

  if (!forwardedProto) {
    return { secure: false, reason: 'no_forwarded_proto', peer, trusted, forwardedProto };
  }
  // Only a proxy we trust may tell us the original scheme; otherwise a client
  // could simply claim https and defeat the check.
  if (!trusted) {
    return { secure: false, reason: 'untrusted_proxy', peer, trusted, forwardedProto };
  }
  if (forwardedProto !== 'https') {
    return { secure: false, reason: 'forwarded_proto_not_https', peer, trusted, forwardedProto };
  }
  return { secure: true, reason: 'forwarded_https', peer, trusted, forwardedProto };
}

export function isSecureRequest(req) {
  return secureContextDiagnosis(req).secure;
}

// ---------------------------------------------------------------------------
//  Sessions
// ---------------------------------------------------------------------------

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    create: db.prepare(
      `INSERT INTO sessions (id, username, csrf, created_at, last_seen, expires_at, ip, ua, persistent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
    destroy: db.prepare('DELETE FROM sessions WHERE id = ?'),
    destroyUser: db.prepare('DELETE FROM sessions WHERE username = ?'),
    attempt: db.prepare('INSERT INTO login_attempts (ip, ts, username, ok) VALUES (?, ?, ?, ?)'),
    recent: db.prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ? AND ok = 0'
    ),
    clearAttempts: db.prepare('DELETE FROM login_attempts WHERE ip = ?'),
  };
  return stmts;
}

// The session id is stored hashed, so a leaked database file does not hand
// over live sessions.
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Whether "keep me signed in" is offered (SESSION_REMEMBER_DAYS > 0). */
const rememberAllowed = () => config.auth.rememberDays > 0;

/**
 * Lifetime of a new session in seconds. A remembered session lasts
 * SESSION_REMEMBER_DAYS, but never less than an ordinary one.
 */
function lifetimeSeconds(remember) {
  const normal = config.auth.ttlHours * 3600;
  return remember ? Math.max(normal, config.auth.rememberDays * 86400) : normal;
}

/**
 * @param {boolean} [remember] "keep me signed in": no idle timeout, and the
 *   longer SESSION_REMEMBER_DAYS lifetime. Ignored when the option is off.
 */
export function createSession(username, ip, ua, remember = false) {
  const persistent = Boolean(remember) && rememberAllowed();
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  prep().create.run(
    hashToken(token),
    username,
    csrf,
    now,
    now,
    now + lifetimeSeconds(persistent) * 1000,
    ip ?? null,
    (ua ?? '').slice(0, 300),
    persistent ? 1 : 0
  );
  return { token, csrf, persistent };
}

export function readSession(token) {
  if (!token) return null;
  const row = prep().get.get(hashToken(token));
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    prep().destroy.run(row.id);
    return null;
  }
  if (
    config.auth.idleMinutes > 0 &&
    !row.persistent &&
    now - row.last_seen > config.auth.idleMinutes * 60_000
  ) {
    prep().destroy.run(row.id);
    return null;
  }
  // Throttle the write: touching on every request would serialise reads behind
  // the ingest writer for no benefit.
  if (now - row.last_seen > 60_000) prep().touch.run(now, row.id);
  return row;
}

export function destroySession(token) {
  if (token) prep().destroy.run(hashToken(token));
}

export function destroyUserSessions(username) {
  prep().destroyUser.run(username);
}

export function recordLoginAttempt(ip, username, ok) {
  prep().attempt.run(ip ?? 'unknown', Date.now(), (username ?? '').slice(0, 100), ok ? 1 : 0);
  if (ok) prep().clearAttempts.run(ip ?? 'unknown');
}

export function isLockedOut(ip) {
  const since = Date.now() - config.auth.windowMinutes * 60_000;
  const { n } = prep().recent.get(ip ?? 'unknown', since);
  return n >= config.auth.maxAttempts;
}

export function cookieOptions(persistent = false) {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: lifetimeSeconds(persistent),
  };
}
