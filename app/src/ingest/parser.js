// Parse one line of Caddy's JSON access log into a normalised event.
//
// Caddy's `json` encoder emits, per handled request:
//   { level, ts, logger:"http.log.access.*", msg:"handled request",
//     request:{ remote_ip, client_ip, proto, method, host, uri,
//               headers:{ "User-Agent":[..], "Referer":[..] },
//               tls:{ version, cipher_suite, proto, server_name } },
//     bytes_read, duration, size, status, resp_headers }
//
// Field names have shifted slightly across Caddy 2.x releases, so every lookup
// below tolerates the known variants rather than assuming one shape.

import { parseUserAgent } from './useragent.js';
import { normalizeIp } from '../util/net.js';

const TLS_VERSIONS = {
  768: 'SSL 3.0',
  769: 'TLS 1.0',
  770: 'TLS 1.1',
  771: 'TLS 1.2',
  772: 'TLS 1.3',
};

const TLS_CIPHERS = {
  4865: 'TLS_AES_128_GCM_SHA256',
  4866: 'TLS_AES_256_GCM_SHA384',
  4867: 'TLS_CHACHA20_POLY1305_SHA256',
  49195: 'ECDHE_ECDSA_AES_128_GCM_SHA256',
  49196: 'ECDHE_ECDSA_AES_256_GCM_SHA384',
  49199: 'ECDHE_RSA_AES_128_GCM_SHA256',
  49200: 'ECDHE_RSA_AES_256_GCM_SHA384',
  52392: 'ECDHE_RSA_CHACHA20_POLY1305',
  52393: 'ECDHE_ECDSA_CHACHA20_POLY1305',
  49171: 'ECDHE_RSA_AES_128_CBC_SHA',
  49172: 'ECDHE_RSA_AES_256_CBC_SHA',
  47: 'RSA_AES_128_CBC_SHA',
  53: 'RSA_AES_256_CBC_SHA',
};

/** Header lookup that ignores case and unwraps Caddy's array-valued headers. */
function header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const direct = headers[name];
  const v = direct !== undefined ? direct : findCaseInsensitive(headers, name);
  if (v === undefined || v === null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length ? s : null;
}

function findCaseInsensitive(obj, name) {
  const want = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k];
  return undefined;
}

/** Caddy writes ts as a float epoch by default, RFC3339 when configured. */
function parseTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Seconds-with-fraction (default) vs already-milliseconds.
    return ts > 1e12 ? Math.round(ts) : Math.round(ts * 1000);
  }
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (Number.isFinite(n) && ts.trim() !== '') {
      return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
    }
    const d = Date.parse(ts);
    if (Number.isFinite(d)) return d;
  }
  return null;
}

/** Duration is seconds-as-float in Caddy; some setups emit a Go duration string. */
function parseDuration(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d * 1000;
  if (typeof d === 'string') {
    const m = d.match(/^([\d.]+)(ns|us|µs|ms|s|m)$/);
    if (m) {
      const n = parseFloat(m[1]);
      switch (m[2]) {
        case 'ns':
          return n / 1e6;
        case 'us':
        case 'µs':
          return n / 1e3;
        case 'ms':
          return n;
        case 's':
          return n * 1000;
        case 'm':
          return n * 60000;
      }
    }
    const n = parseFloat(d);
    if (Number.isFinite(n)) return n * 1000;
  }
  return null;
}

function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(0, end + 1); // bare IPv6 literal, keep brackets
  } else if (h.includes(':')) {
    // Only strip a port if what follows the last colon is numeric.
    const idx = h.lastIndexOf(':');
    if (/^\d+$/.test(h.slice(idx + 1))) h = h.slice(0, idx);
  }
  h = h.replace(/\.$/, '');
  return h || null;
}

function splitUri(uri) {
  if (typeof uri !== 'string' || !uri.length) return { path: '/', query: null };
  const q = uri.indexOf('?');
  if (q < 0) return { path: uri.slice(0, 2048), query: null };
  return {
    path: uri.slice(0, q).slice(0, 2048) || '/',
    query: uri.slice(q + 1, q + 2049) || null,
  };
}

export function extensionOf(p) {
  if (!p) return '(none)';
  const last = p.slice(p.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '(none)';
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '(none)';
}

export function refererHost(ref) {
  if (!ref) return '(direct)';
  try {
    const u = new URL(ref);
    return u.hostname.toLowerCase() || '(unknown)';
  } catch {
    return '(unknown)';
  }
}

export const LATENCY_BUCKETS = [
  [1, '0-1 ms'],
  [5, '1-5 ms'],
  [10, '5-10 ms'],
  [25, '10-25 ms'],
  [50, '25-50 ms'],
  [100, '50-100 ms'],
  [250, '100-250 ms'],
  [500, '250-500 ms'],
  [1000, '0.5-1 s'],
  [2500, '1-2.5 s'],
  [5000, '2.5-5 s'],
  [10000, '5-10 s'],
  [Infinity, '10 s+'],
];

export function latencyBucket(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown';
  for (const [ceil, label] of LATENCY_BUCKETS) if (ms < ceil) return label;
  return '10 s+';
}

/**
 * @param {string} line one raw JSON line
 * @returns {{ok:boolean, event?:object, reason?:string}}
 */
export function parseLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'json' };

  const req = o.request;
  // Access-log entries always carry a `request` object. Anything else
  // (startup messages, TLS handshake errors, admin logs) is skipped.
  if (!req || typeof req !== 'object') return { ok: false, reason: 'not-access' };

  const host = normalizeHost(req.host ?? req.server_name ?? o.host);
  if (!host) return { ok: false, reason: 'no-host' };

  const ts = parseTs(o.ts) ?? Date.now();
  const { path, query } = splitUri(req.uri ?? req.URI ?? '/');
  const headers = req.headers;
  const ua = header(headers, 'User-Agent');
  const referer = header(headers, 'Referer') ?? header(headers, 'Referrer');

  const tls = req.tls && typeof req.tls === 'object' ? req.tls : null;
  const tlsVersion = tls
    ? (TLS_VERSIONS[tls.version] ??
      (tls.version != null ? `0x${Number(tls.version).toString(16)}` : null))
    : null;
  const tlsCipher = tls
    ? (TLS_CIPHERS[tls.cipher_suite] ??
      (tls.cipher_suite != null ? `0x${Number(tls.cipher_suite).toString(16)}` : null))
    : null;

  const status = Number.isFinite(o.status) ? o.status : parseInt(o.status, 10) || 0;
  const bytesOut = Number.isFinite(o.size) ? o.size : Number(o.size) || 0;
  const bytesIn = Number.isFinite(o.bytes_read) ? o.bytes_read : Number(o.bytes_read) || 0;
  const durMs = parseDuration(o.duration);

  // client_ip is the header-resolved address when Caddy is configured with
  // `trusted_proxies`; remote_ip is the raw socket peer.
  const ip = normalizeIp(req.client_ip ?? req.remote_ip ?? req.remote_addr);
  const uaInfo = parseUserAgent(ua);

  return {
    ok: true,
    event: {
      ts,
      host,
      method: String(req.method || 'GET').toUpperCase().slice(0, 16),
      path,
      query,
      status,
      bytes_out: bytesOut,
      bytes_in: bytesIn,
      dur_ms: durMs,
      ip,
      ua: ua ? ua.slice(0, 512) : null,
      referer: referer ? referer.slice(0, 1024) : null,
      // Stored separately so "who links here" drill-downs are an indexed
      // equality match instead of a LIKE over the full URL.
      referer_host: referer ? refererHost(referer) : null,
      proto: String(tls?.proto || req.proto || '').slice(0, 16) || null,
      tls_version: tlsVersion,
      tls_cipher: tlsCipher,
      browser: uaInfo.browser,
      os: uaInfo.os,
      device: uaInfo.device,
      bot: uaInfo.bot,
      raw: line.length > 16384 ? line.slice(0, 16384) : line,
    },
  };
}
