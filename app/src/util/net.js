// Minimal IP helpers: normalisation, CIDR matching, and privacy classification.

export function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  // Strip brackets and a trailing port, but never mistake an IPv6 colon
  // for a port separator.
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  // An IPv4 address in IPv6 form (::ffff:10.0.0.1) has dots and colons too,
  // so it must be unwrapped before the address:port split below, which
  // would otherwise cut it down to nothing.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/i);
  if (mapped) return mapped[1];
  if (ip.includes('.') && ip.includes(':')) ip = ip.split(':')[0];
  return ip.toLowerCase() || null;
}

export function isIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function v6ToBigInt(ip) {
  if (!ip.includes(':')) return null;
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : null;
  let groups;
  if (t === null) {
    groups = h;
  } else {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    groups = [...h, ...Array(fill).fill('0'), ...t];
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n)) return null;
    out = (out << 16n) | BigInt(n);
  }
  return out;
}

/** Compile a list of CIDRs / bare IPs into a matcher function. */
export function cidrMatcher(cidrs) {
  const v4 = [];
  const v6 = [];
  for (const entry of cidrs) {
    const [addrRaw, bitsRaw] = String(entry).trim().split('/');
    const addr = normalizeIp(addrRaw);
    if (!addr) continue;
    if (isIPv4(addr)) {
      const base = v4ToInt(addr);
      if (base === null) continue;
      const bits = bitsRaw === undefined ? 32 : parseInt(bitsRaw, 10);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      // `&` evaluates as int32, so any network whose address has the high bit
      // set (172.16/12, 192.168/16, anything >= 128.0.0.0) comes out negative.
      // The match below normalises with `>>> 0`, so the stored base must be
      // normalised the same way or the two can never compare equal.
      v4.push([(base & mask) >>> 0, mask]);
    } else {
      const base = v6ToBigInt(addr);
      if (base === null) continue;
      const bits = bitsRaw === undefined ? 128 : parseInt(bitsRaw, 10);
      const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
      v6.push([base & mask, mask]);
    }
  }
  return (ip) => {
    if (!ip) return false;
    if (isIPv4(ip)) {
      const n = v4ToInt(ip);
      if (n === null) return false;
      return v4.some(([b, m]) => ((n & m) >>> 0) === b);
    }
    const n = v6ToBigInt(ip);
    if (n === null) return false;
    return v6.some(([b, m]) => (n & m) === b);
  };
}

const PRIVATE = cidrMatcher([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]);

/** True for addresses that will never resolve to a public ASN. */
export function isPrivateIp(ip) {
  return PRIVATE(ip);
}

/**
 * Longest prefix carried on the internet: networks filter out anything more
 * specific, so every address in one such block has the same route and origin.
 */
const BLOCK_BITS = { v4: 24, v6: 48 };

/** The IPv4 /24 or IPv6 /48 an address is in, as a key; null if not an address. */
export function blockOf(ip) {
  if (!ip) return null;
  if (isIPv4(ip)) {
    const n = v4ToInt(ip);
    return n === null ? null : `${(n >>> 8).toString(16)}/24`;
  }
  // An IPv4 tail in IPv6 form is left alone rather than parsed wrongly.
  if (ip.includes('.')) return null;
  const n = v6ToBigInt(ip);
  return n === null ? null : `${(n >> 80n).toString(16)}::/48`;
}

/** Whether `prefix` ("2001:db8::/32") is no longer than the block `ip` is in. */
export function prefixCoversBlock(prefix, ip) {
  const len = Number(String(prefix ?? '').split('/')[1]);
  if (!Number.isInteger(len) || len < 0 || !ip) return false;
  return len <= (isIPv4(ip) ? BLOCK_BITS.v4 : BLOCK_BITS.v6);
}
