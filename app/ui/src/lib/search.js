// Turns what people type into the request-explorer search box into filters.
//
//   host:example.com ua:curl status:4xx url:/wp-login "exact phrase" leftovers
//
// Recognised `key:value` terms become structured filters; everything else is
// free text, matched anywhere (URL, agent, referrer, address, host, query).
// A value with spaces can be quoted: ua:"Mozilla/5.0 (X11".

/** Term name as typed -> request-search filter it sets. */
const KEY_ALIASES = {
  host: 'host', domain: 'host', site: 'host',
  ip: 'ip', addr: 'ip', src: 'ip', source: 'ip',
  status: 'status', code: 'status',
  method: 'method',
  ua: 'uaq', agent: 'uaq', useragent: 'uaq',
  url: 'pathq', path: 'pathq', uri: 'pathq',
  country: 'country', cc: 'country',
  asn: 'asn', as: 'asn',
  ref: 'referer', referer: 'referer', referrer: 'referer',
  browser: 'browser', os: 'os', device: 'device',
  proto: 'proto', tls: 'tls', ext: 'ext',
  bot: 'bots', bots: 'bots',
};

/**
 * Clean a filter value into the form the API matches on. Shared by the typed
 * terms and the form fields, so both behave the same.
 */
export function normalizeFilterValue(key, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  switch (key) {
    case 'host':
      // Accept a pasted URL: drop the scheme, path and port.
      if (v.startsWith('[')) return v.toLowerCase();
      return v.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/:?#].*$/, '');
    case 'method':
    case 'country':
      return v.toUpperCase();
    case 'asn':
      return v.replace(/^as/i, '');
    case 'status':
      return v.toLowerCase();
    case 'bots':
      if (v === 'only' || v === 'exclude') return v;
      return /^(no|false|0|exclude|human|humans)$/i.test(v) ? 'exclude' : 'only';
    default:
      return v;
  }
}

/**
 * @param {string} text
 * @returns {{structured: Record<string,string>, q: string}}
 */
export function parseSearch(text) {
  const structured = {};
  const free = [];
  // key:"quoted", key:bare, "quoted phrase", or a bare word — in that order.
  const re = /([A-Za-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    if (m[1] !== undefined) {
      const key = KEY_ALIASES[m[1].toLowerCase()];
      const value = normalizeFilterValue(key, m[2] ?? m[3] ?? '');
      if (key && value) structured[key] = value;
      // Not a term we know — e.g. the "https" in a pasted URL — so keep the
      // whole token as literal text rather than silently dropping it.
      else free.push(m[0]);
    } else {
      free.push(m[4] ?? m[5]);
    }
  }
  return { structured, q: free.join(' ').trim() };
}
