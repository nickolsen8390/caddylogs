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

/**
 * Visitor-analytics dimensions resolve to the page loads carrying that value:
 * [request-search parameter, extra filters]. For the visit dimensions
 * (channel, referrer, campaign, language, entry page) those are mostly the
 * page views that started each visit.
 */
const PAGEVIEW_DIMS = {
  page: ['path', { pageview: 1 }],
  entry: ['path', { pageview: 1 }],
  exit: ['path', { pageview: 1 }],
  refsite: ['referer', { pageview: 1 }],
  channel: ['channel', { pageview: 1 }],
  lang: ['lang', { pageview: 1 }],
  utm_source: ['utm_source', { pageview: 1 }],
  utm_medium: ['utm_medium', { pageview: 1 }],
  utm_campaign: ['utm_campaign', { pageview: 1 }],
  utm_term: ['utm_term', { pageview: 1 }],
  utm_content: ['utm_content', { pageview: 1 }],
  broken: ['path', { status: '404' }],
};

/** Dimensions that cannot be resolved back to individual requests. */
const NOT_DRILLABLE = new Set(['(other)']);

/** The time ranges a page can show, in milliseconds. */
export const RANGE_MS = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  '365d': 365 * 86_400_000,
};

/**
 * The period a drill-down searches: the page's time range as a start time,
 * so the request search begins at the right end of it instead of walking
 * back to it from the newest request. Pages pass `range`; a caller that
 * already has a start passes `from`.
 */
function since(context) {
  if (context.from) return { from: context.from };
  const span = RANGE_MS[context.range];
  return span ? { from: Date.now() - span } : {};
}

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
      ...since(context),
    })}`;
  }

  // The unresolved-ASN bucket is a real filter (asn=0), the label is not.
  if (dim === 'asn' && (v === '0' || v.toLowerCase() === 'unresolved')) {
    return `/requests${qs({ asn: '0', host: context.host, ...since(context) })}`;
  }

  if (PAGEVIEW_DIMS[dim]) {
    const [key, extra] = PAGEVIEW_DIMS[dim];
    return `/requests${qs({ [key]: v, ...extra, host: context.host, ...since(context) })}`;
  }

  const param = DIM_TO_PARAM[dim];
  if (!param) return null;
  return `/requests${qs({ [param]: v, host: context.host, ...since(context) })}`;
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
  pageview: 'Page views',
  channel: 'Channel',
  lang: 'Language',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  utm_term: 'UTM term',
  utm_content: 'UTM content',
  q: 'Search',
  uaq: 'Agent contains',
  pathq: 'URL contains',
  minDur: 'Slower than',
  from: 'From',
  to: 'To',
};

export const FILTER_KEYS = Object.keys(FILTER_LABELS);

/** Display form for a filter value (some are stored as codes). */
export function filterValueLabel(key, value) {
  if (key === 'bots') return value === 'only' ? 'bots only' : 'humans only';
  if (key === 'pageview') return 'only';
  if (key === 'asn' && String(value) === '0') return 'unresolved';
  if (key === 'minDur') return `${value} ms`;
  if (key === 'from' || key === 'to') return new Date(Number(value)).toLocaleString();
  return String(value);
}
