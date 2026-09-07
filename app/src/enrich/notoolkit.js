// notoolkit.com adapter — IP to BGP prefix + ASN, and ASN to registrant detail.
//
//   GET https://notoolkit.com/?ip=8.8.8.8
//     -> { query, prefix, prefix_last_updated, asn, asn_name, org_name,
//          country, description, rir, whois_raw, cache_hit }
//
//   GET https://notoolkit.com/?asn=15169
//     -> { query, asn, asn_name, org_name, country, description, rir,
//          whois_raw, prefix_count: { ipv4, ipv6 }, cache_hit }
//
// `country` in both responses is the country of the AS *registrant*. It is not
// where the request came from — visitor country comes from MaxMind. Keeping
// the two apart matters: a US-registered CDN serves traffic from everywhere.
//
// Error semantics that the rest of the pipeline depends on:
//   400 / 404  the provider answered definitively — no data for this input.
//              Cached as "resolved, nothing found". Not a health problem, and
//              never retried in a loop.
//   503 / 5xx / network / timeout
//              transient. Throws a retryable error, marks the provider
//              unhealthy (which surfaces a banner in the UI), and leaves the
//              address queued for backoff retry.

import { config } from '../config.js';
import { logger } from '../util/log.js';
import { recordProviderResult } from './health.js';

const log = logger('notoolkit');

export const NOTOOLKIT = 'notoolkit';

/** Transport or 5xx failure — worth retrying, and worth telling the user. */
export class ProviderUnavailable extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderUnavailable';
    this.status = status;
    this.retryable = true;
  }
}

/** Simple token bucket so we never exceed the configured request rate. */
class RateLimiter {
  constructor(perSec) {
    this.capacity = Math.max(1, perSec);
    this.tokens = this.capacity;
    this.perMs = this.capacity / 1000;
    this.last = Date.now();
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.perMs);
      await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
    }
  }
}

const limiter = new RateLimiter(config.notoolkit.ratePerSec);

/**
 * One request against the API. `params` becomes the query string.
 * @returns {Promise<object|null>} the parsed body, or null when the provider
 *   answered but has no data (400/404).
 */
/**
 * Build the URL and headers for a lookup, without performing it. Exported so
 * the connectivity probe tests exactly what the enricher would send.
 */
export function describeRequest(params) {
  const url = new URL(config.notoolkit.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const headers = { Accept: 'application/json', 'User-Agent': 'caddy-log-interface/1.0' };
  // Talking to an origin by address while still naming the virtual host.
  if (config.notoolkit.hostHeader) headers.Host = config.notoolkit.hostHeader;
  // The public API needs no authentication. The header is only sent if a key
  // is configured, so this keeps working if that ever changes.
  if (config.notoolkit.key && config.notoolkit.authHeader) {
    headers[config.notoolkit.authHeader] = config.notoolkit.authScheme
      ? `${config.notoolkit.authScheme} ${config.notoolkit.key}`
      : config.notoolkit.key;
  }
  return { url, headers };
}

async function call(params) {
  await limiter.take();

  const { url, headers } = describeRequest(params);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.notoolkit.timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });

    // A definitive "nothing here" is a successful call, not an outage.
    if (res.status === 404 || res.status === 400) {
      recordProviderResult(NOTOOLKIT, true, null);
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderUnavailable(
        `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ''}`,
        res.status
      );
    }

    const body = await res.json();
    recordProviderResult(NOTOOLKIT, true, null);
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    const message =
      err?.name === 'AbortError'
        ? `timed out after ${config.notoolkit.timeoutMs}ms`
        : String(err?.message ?? err);
    recordProviderResult(NOTOOLKIT, false, message);
    log.debug('lookup failed', { params, err: message });
    if (err instanceof ProviderUnavailable) throw err;
    throw new ProviderUnavailable(message);
  } finally {
    clearTimeout(timer);
  }
}

const str = (v, max) =>
  v === null || v === undefined || v === '' ? null : String(v).slice(0, max);

function toAsnNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === null || v === undefined) return null;
  const m = String(v).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * IP -> prefix and originating ASN.
 * @returns {Promise<object|null>} null when no BGP prefix covers the address
 *   (unrouted space, bogons, some anycast edge cases).
 */
export async function lookupIp(ip) {
  if (!config.notoolkit.enabled) return null;
  const body = await call({ ip });
  if (!body) return null;

  const asn = toAsnNumber(body.asn);
  if (asn === null && !body.org_name && !body.asn_name) return null;

  return {
    asn,
    as_name: str(body.asn_name, 128),
    as_org: str(body.org_name, 200),
    as_country: str(body.country, 8),
    as_rir: str(body.rir, 16),
    as_prefix: str(body.prefix, 64),
    description: str(body.description, 500),
    prefix_last_updated: str(body.prefix_last_updated, 40),
  };
}

/**
 * ASN -> full registrant detail. Called once per distinct ASN rather than per
 * request, so the WHOIS text and prefix counts cost one lookup each.
 */
export async function lookupAsnDetail(asn) {
  if (!config.notoolkit.enabled) return null;
  const body = await call({ asn: String(asn) });
  if (!body) return null;

  const counts = body.prefix_count ?? {};
  return {
    asn: toAsnNumber(body.asn) ?? asn,
    as_name: str(body.asn_name, 128),
    org: str(body.org_name, 200),
    country: str(body.country, 8),
    rir: str(body.rir, 16),
    description: str(body.description, 500),
    // The documented cap is 4 KB; store it as given for the ASN drill-down.
    whois_raw: str(body.whois_raw, 4096),
    prefix_v4: Number.isFinite(counts.ipv4) ? counts.ipv4 : null,
    prefix_v6: Number.isFinite(counts.ipv6) ? counts.ipv6 : null,
  };
}

