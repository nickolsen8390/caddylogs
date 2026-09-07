// Turning any aggregate value back into the requests that produced it.
//
// Every "top N" list, chart category and chip in the UI routes through here,
// so a new dimension only has to be added in one place to become clickable.

import { qs } from './api.js';

/** Aggregate dimension name -> the request-search parameter it maps to. */
const DIM_TO_PARAM = {
  path: 'path',
  ip: 'ip',
  ua: 'ua',
  browser: 'browser',
  os: 'os',
  device: 'device',
  country: 'country',
  asn: 'asn',
  referer: 'referer',
  proto: 'proto',
  tls: 'tls',
  cipher: 'cipher',
  ext: 'ext',
  status: 'status',
  method: 'method',
  lat: 'lat',
};

/** Dimensions that cannot be resolved back to individual requests. */
const NOT_DRILLABLE = new Set(['(other)']);

/**
 * Link to the requests behind one dimension value.
 * @param {string} dim  aggregate dimension, e.g. 'ip' or 'browser'
 * @param {string|number} value
 * @param {{host?:string, range?:string}} [context]
 * @returns {string|null} a route, or null when the value is not drillable
 */
export function drillTo(dim, value, context = {}) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value);
  if (NOT_DRILLABLE.has(v)) return null;

  // A source address gets its own page: enrichment, behaviour, and requests.
  if (dim === 'ip') {
    return `/ip/${encodeURIComponent(v)}${qs({ host: context.host, range: context.range })}`;
  }

  // Bot vs human is stored as a flag rather than a value.
  if (dim === 'kind') {
    return `/requests${qs({
      bots: v === 'bot' ? 'only' : 'exclude',
      host: context.host,
      range: context.range,
    })}`;
  }

  // The unresolved-ASN bucket is a real filter (asn=0), the label is not.
  if (dim === 'asn' && (v === '0' || v.toLowerCase() === 'unresolved')) {
    return `/requests${qs({ asn: '0', host: context.host, range: context.range })}`;
  }

  const param = DIM_TO_PARAM[dim];
  if (!param) return null;
  return `/requests${qs({ [param]: v, host: context.host, range: context.range })}`;
}

/** Human-readable name for a filter chip. */
export const FILTER_LABELS = {
  host: 'Domain',
  ip: 'Source IP',
  asn: 'ASN',
  country: 'Country',
  status: 'Status',
  method: 'Method',
  path: 'URL',
  ua: 'User agent',
  browser: 'Browser',
  os: 'OS',
  device: 'Device',
  referer: 'Referrer',
  proto: 'Protocol',
  tls: 'TLS',
  cipher: 'Cipher',
  ext: 'File type',
  lat: 'Latency',
  bots: 'Traffic',
  q: 'Search',
  minDur: 'Slower than',
  from: 'From',
  to: 'To',
};

export const FILTER_KEYS = Object.keys(FILTER_LABELS);

/** Display form for a filter value (some are stored as codes). */
export function filterValueLabel(key, value) {
  if (key === 'bots') return value === 'only' ? 'bots only' : 'humans only';
  if (key === 'asn' && String(value) === '0') return 'unresolved';
  if (key === 'minDur') return `${value} ms`;
  if (key === 'from' || key === 'to') return new Date(Number(value)).toLocaleString();
  return String(value);
}
