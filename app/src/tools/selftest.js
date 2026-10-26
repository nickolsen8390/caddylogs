// Self-contained checks for the pure logic that is easy to get subtly wrong
// and hard to notice: CIDR matching, IP normalisation, log parsing, visitor
// analytics and visits, and reading the changelog. Touches no database, no
// network, no log files.
//
//   docker compose run --rm --no-deps app node src/tools/selftest.js

import { blockOf, cidrMatcher, isPrivateIp, normalizeIp, isIPv4, prefixCoversBlock } from '../util/net.js';
import { parseLine, latencyBucket, extensionOf, refererHost } from '../ingest/parser.js';
import { parseUserAgent } from '../ingest/useragent.js';
import {
  isNavigation, isPageview, campaignOf, channelOf, isExternalReferer, languageOf, looksDisguised,
} from '../ingest/traffic.js';
import { Accumulator, hourBucket } from '../ingest/rollup.js';
import { visitorHash } from '../ingest/visits.js';
import { notoolkitEndpoint, parseOrigins, sizeMb } from '../config.js';
import { validateSettings } from '../settings.js';
import { makeFilter, SEARCH_ONLY_FILTERS } from '../web/stream.js';
import { describeRequest } from '../enrich/notoolkit.js';
import { packRaw, unpackRaw } from '../util/rawlog.js';
import { parseChangelog } from '../release.js';

let failures = 0;
let checks = 0;

function ok(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------

group('CIDR matching', () => {
  // Regression: `&` yields int32, so networks with the high bit set used to
  // store a negative base and never match. 172.16/12 and 192.168/16 are the
  // defaults for TRUSTED_PROXIES, so this broke reverse-proxy detection.
  const m = cidrMatcher(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1', '::1']);

  ok('docker bridge 172.19.0.1 is inside 172.16.0.0/12', m('172.19.0.1'), true);
  ok('172.16.0.0 (network address)', m('172.16.0.0'), true);
  ok('172.31.255.255 (last address)', m('172.31.255.255'), true);
  ok('172.15.255.255 is below the range', m('172.15.255.255'), false);
  ok('172.32.0.0 is above the range', m('172.32.0.0'), false);
  ok('192.168.1.50 is inside 192.168.0.0/16', m('192.168.1.50'), true);
  ok('192.169.1.50 is outside', m('192.169.1.50'), false);
  ok('10.30.1.101 is inside 10.0.0.0/8', m('10.30.1.101'), true);
  ok('11.0.0.1 is outside 10.0.0.0/8', m('11.0.0.1'), false);
  ok('bare host 127.0.0.1 matches itself', m('127.0.0.1'), true);
  ok('127.0.0.2 does not match a /32', m('127.0.0.2'), false);
  ok('8.8.8.8 matches nothing', m('8.8.8.8'), false);
  ok('::1 matches', m('::1'), true);

  const all = cidrMatcher(['0.0.0.0/0']);
  ok('0.0.0.0/0 matches a high-bit address', all('203.0.113.9'), true);
  ok('0.0.0.0/0 matches a low address', all('1.2.3.4'), true);

  const single = cidrMatcher(['203.0.113.9/32']);
  ok('/32 matches exactly', single('203.0.113.9'), true);
  ok('/32 rejects a neighbour', single('203.0.113.10'), false);
});

group('Private address detection', () => {
  ok('10.x is private', isPrivateIp('10.30.1.101'), true);
  ok('172.19.x is private', isPrivateIp('172.19.0.1'), true);
  ok('192.168.x is private', isPrivateIp('192.168.1.1'), true);
  ok('127.0.0.1 is private', isPrivateIp('127.0.0.1'), true);
  ok('169.254.x is link-local', isPrivateIp('169.254.1.1'), true);
  ok('100.64.x is CGNAT', isPrivateIp('100.64.0.1'), true);
  ok('8.8.8.8 is public', isPrivateIp('8.8.8.8'), false);
  ok('1.1.1.1 is public', isPrivateIp('1.1.1.1'), false);
  ok('2606:4700::1111 is public', isPrivateIp('2606:4700::1111'), false);
  ok('fd00::1 is ULA', isPrivateIp('fd00::1'), true);
});

group('IP normalisation', () => {
  ok('strips an IPv4 port', normalizeIp('10.0.0.1:54321'), '10.0.0.1');
  ok('keeps a bare IPv4', normalizeIp('10.0.0.1'), '10.0.0.1');
  ok('unwraps a bracketed IPv6', normalizeIp('[2606:4700::1111]:443'), '2606:4700::1111');
  ok('unmaps ::ffff: IPv4', normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
  ok('leaves a bare IPv6 alone', normalizeIp('2606:4700::1111'), '2606:4700::1111');
  ok('handles empty input', normalizeIp(''), null);
  ok('isIPv4 says yes', isIPv4('10.0.0.1'), true);
  ok('isIPv4 says no', isIPv4('2606:4700::1111'), false);
});

group('Network blocks (shared enrichment lookups)', () => {
  const b = (ip) => blockOf(ip);
  ok('IPv4 in one /24 share a block', b('203.0.113.7') === b('203.0.113.250'), true);
  ok('IPv4 in neighbouring /24s do not', b('203.0.113.7') === b('203.0.114.7'), false);
  ok('IPv4 above 128.0.0.0 has a block', b('198.51.100.1') !== null, true);
  ok('IPv6 in one /48 share a block', b('2001:db8:1234:1::1') === b('2001:db8:1234:ffff:abcd::9'), true);
  ok('IPv6 written short or long agree', b('2001:db8:0:1::1') === b('2001:0db8:0000:ffff:0:0:0:1'), true);
  ok('IPv6 in neighbouring /48s do not', b('2001:db8:1234::1') === b('2001:db8:1235::1'), false);
  ok('IPv6 with :: at the start', b('::1') !== null, true);
  ok('not an address', b('not-an-ip'), null);
  ok('a /32 covers a /48 block', prefixCoversBlock('2001:db8::/32', '2001:db8:1::1'), true);
  ok('a /48 covers its block', prefixCoversBlock('2001:db8:1::/48', '2001:db8:1::1'), true);
  ok('a /56 does not', prefixCoversBlock('2001:db8:1:100::/56', '2001:db8:1:100::1'), false);
  ok('a /24 covers an IPv4 block', prefixCoversBlock('203.0.113.0/24', '203.0.113.9'), true);
  ok('a /25 does not', prefixCoversBlock('203.0.113.0/25', '203.0.113.9'), false);
  ok('no prefix shares nothing', prefixCoversBlock(null, '203.0.113.9'), false);
});

group('Caddy JSON access log parsing', () => {
  const line = JSON.stringify({
    level: 'info',
    ts: 1757212800.123456,
    logger: 'http.log.access.log0',
    msg: 'handled request',
    request: {
      remote_ip: '203.0.113.9',
      remote_port: '54321',
      client_ip: '203.0.113.9',
      proto: 'HTTP/2.0',
      method: 'get',
      host: 'Example.COM:443',
      uri: '/blog/post.html?utm=x&y=2',
      headers: {
        'User-Agent': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'],
        Referer: ['https://news.ycombinator.com/item?id=1'],
        Accept: ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
        'Accept-Language': ['en-GB,en;q=0.9'],
        'Sec-Ch-Ua': ['"Chromium";v="131", "Not_A Brand";v="24"'],
        'Sec-Fetch-Dest': ['document'],
        'Sec-Fetch-Mode': ['navigate'],
        'Sec-Fetch-Site': ['cross-site'],
      },
      tls: { version: 772, cipher_suite: 4865, proto: 'h2', server_name: 'example.com' },
    },
    bytes_read: 12,
    duration: 0.0345,
    size: 4096,
    status: 200,
  });

  const res = parseLine(line);
  ok('parses', res.ok, true);
  const e = res.event ?? {};
  ok('epoch seconds become ms', e.ts, 1757212800123);
  ok('host lowercased, port stripped', e.host, 'example.com');
  ok('method uppercased', e.method, 'GET');
  ok('path split from query', e.path, '/blog/post.html');
  ok('query captured', e.query, 'utm=x&y=2');
  ok('status', e.status, 200);
  ok('bytes out', e.bytes_out, 4096);
  ok('bytes in', e.bytes_in, 12);
  ok('duration seconds become ms', e.dur_ms, 34.5);
  ok('client ip', e.ip, '203.0.113.9');
  ok('TLS version decoded', e.tls_version, 'TLS 1.3');
  ok('cipher decoded', e.tls_cipher, 'TLS_AES_128_GCM_SHA256');
  ok('protocol prefers ALPN', e.proto, 'h2');
  ok('browser detected', e.browser, 'Chrome 131');
  ok('os detected', e.os, 'Windows 10/11');
  ok('not a bot', e.bot, 0);
  ok('a navigation', e.nav, 1);
  ok('channel from the referrer', e.channel, 'Social');
  ok('language from Accept-Language', e.lang, 'en-GB');
  ok('a "utm" parameter is not a UTM tag', e.utm_source, null);

  ok('rejects malformed JSON', parseLine('not json').reason, 'json');
  ok('skips non-access entries', parseLine('{"level":"info","msg":"serving"}').reason, 'not-access');
  ok('skips entries with no host', parseLine('{"request":{"uri":"/"}}').reason, 'no-host');

  // RFC3339 timestamps, used when Caddy is configured with a time format.
  const rfc = parseLine(
    JSON.stringify({ ts: '2025-09-07T00:00:00Z', request: { host: 'a.example', uri: '/' }, status: 200 })
  );
  ok('parses RFC3339 ts', rfc.ok && rfc.event.ts, Date.parse('2025-09-07T00:00:00Z'));

  // Header lookup must be case-insensitive: some setups lowercase them.
  const lower = parseLine(
    JSON.stringify({
      ts: 1757212800,
      request: { host: 'a.example', uri: '/', headers: { 'user-agent': ['curl/8.5.0'] } },
      status: 200,
    })
  );
  ok('finds a lowercased User-Agent', lower.event.ua, 'curl/8.5.0');
  ok('flags curl as a bot', lower.event.bot, 1);
});

group('Derived fields', () => {
  ok('extension of a file', extensionOf('/assets/app.min.js'), 'js');
  ok('extension of a directory path', extensionOf('/blog/'), '(none)');
  ok('extension of a dotfile-ish path', extensionOf('/.well-known/x'), '(none)');
  ok('referer host', refererHost('https://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
  ok('missing referer', refererHost(null), '(direct)');
  ok('unparseable referer', refererHost('not a url'), '(unknown)');
  ok('latency bucket low', latencyBucket(3), '1-5 ms');
  ok('latency bucket high', latencyBucket(45000), '10 s+');
  ok('latency bucket unknown', latencyBucket(null), 'unknown');
  ok('googlebot is a bot', parseUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)').bot, 1);
  ok('firefox is not', parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0').bot, 0);
  ok('mobile device class', parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148').device, 'Mobile');
});

group('Visitor analytics', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36';
  const nav = (headers, extra = {}) =>
    isNavigation({ method: 'GET', bot: 0, headers, respHeaders: null, ...extra });

  ok('document load is a navigation', nav({ 'Sec-Fetch-Dest': ['document'] }), true);
  ok('script load is not', nav({ 'Sec-Fetch-Dest': ['script'] }), false);
  ok('fetch() is not', nav({ 'Sec-Fetch-Dest': ['empty'], Accept: ['text/html'] }), false);
  ok('iframe is not', nav({ 'Sec-Fetch-Dest': ['iframe'] }), false);
  ok('prefetch is not', nav({ 'Sec-Fetch-Dest': ['document'], 'Sec-Purpose': ['prefetch;prerender'] }), false);
  ok('POST is not', nav({ 'Sec-Fetch-Dest': ['document'] }, { method: 'POST' }), false);
  ok('bot is not', nav({ 'Sec-Fetch-Dest': ['document'] }, { bot: 1 }), false);
  ok('old browser asking for HTML is', nav({ Accept: ['text/html,*/*'] }), true);
  ok('old browser given a PDF is not',
    nav({ Accept: ['text/html,*/*'] }, { respHeaders: { 'Content-Type': ['application/pdf'] } }), false);
  ok('200 navigation is a page view', isPageview({ nav: 1, status: 200 }), true);
  ok('304 navigation is a page view', isPageview({ nav: 1, status: 304 }), true);
  ok('404 navigation is not', isPageview({ nav: 1, status: 404 }), false);
  ok('redirect is not', isPageview({ nav: 1, status: 301 }), false);

  ok('UTM tags read', campaignOf('utm_source=Newsletter&utm_medium=Email&utm_campaign=Launch%20Week'), {
    utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'Launch Week', utm_term: null, utm_content: null,
  });
  ok('ref stands in for utm_source', campaignOf('ref=producthunt').utm_source, 'producthunt');
  ok('gclid implies google / cpc', [campaignOf('gclid=abc').utm_source, campaignOf('gclid=abc').utm_medium], ['google', 'cpc']);
  ok('fbclid implies facebook, not paid', campaignOf('fbclid=abc').utm_medium, null);
  ok('explicit tags beat click IDs', campaignOf('utm_source=meta&fbclid=abc').utm_source, 'meta');
  ok('no query', campaignOf(null).utm_source, null);

  const ch = (refHost, query = null, host = 'example.com') => channelOf({ host, refHost, utm: campaignOf(query) });
  ok('no referrer is direct', ch(null), 'Direct');
  ok('own site is internal', ch('www.example.com'), 'Internal');
  ok('google is search', ch('www.google.co.uk'), 'Search');
  ok('android google app is search', ch('com.google.android.googlequicksearchbox'), 'Search');
  ok('gemini is an AI assistant, not search', ch('gemini.google.com'), 'AI assistant');
  ok('chatgpt utm_source is an AI assistant', ch(null, 'utm_source=chatgpt.com'), 'AI assistant');
  ok('t.co is social', ch('t.co'), 'Social');
  ok('l.facebook.com is social', ch('l.facebook.com'), 'Social');
  ok('webmail is email', ch('mail.google.com'), 'Email');
  ok('other sites are referrals', ch('blog.someone.dev'), 'Referral');
  ok('cpc is paid even from google', ch('www.google.com', 'gclid=1'), 'Paid');
  ok('newsletter medium is email', ch(null, 'utm_medium=newsletter'), 'Email');
  ok('unknown tagged link is a campaign', ch(null, 'utm_campaign=spring'), 'Campaign');
  ok('external referrer', isExternalReferer('example.com', 'other.org'), true);
  ok('www is not external', isExternalReferer('example.com', 'www.example.com'), false);
  ok('own subdomain is not external', isExternalReferer('app.example.com', 'docs.example.com'), false);
  ok('own subdomain is internal', ch('docs.example.com', null, 'app.example.com'), 'Internal');
  ok('another site under co.uk is external', isExternalReferer('shop.example.co.uk', 'other.co.uk'), true);
  ok('own site under co.uk is not', isExternalReferer('shop.example.co.uk', 'www.example.co.uk'), false);
  ok('google.co.uk is still search', ch('www.google.co.uk', null, 'example.co.uk'), 'Search');

  ok('language with region', languageOf('en-us,en;q=0.9'), 'en-US');
  ok('language with script', languageOf('zh-hant-tw'), 'zh-Hant');
  ok('bare language', languageOf('fr'), 'fr');
  ok('wildcard is no language', languageOf('*'), null);

  const tls = { version: 772 };
  const bare = { 'User-Agent': [chrome], Accept: ['*/*'], 'Accept-Encoding': ['gzip'] };
  ok('Chrome without Sec-Fetch or client hints is disguised', looksDisguised(chrome, bare, tls), true);
  ok('real Chrome is not', looksDisguised(chrome, { ...bare, 'Sec-Fetch-Mode': ['navigate'] }, tls), false);
  ok('not judged over plain HTTP', looksDisguised(chrome, bare, null), false);
  ok('not judged on a stripped log', looksDisguised(chrome, { 'User-Agent': [chrome] }, tls), false);
  ok('Chrome on iOS is not', looksDisguised('Mozilla/5.0 (iPhone) CriOS/131.0 Mobile', bare, tls), false);
  ok('Firefox is not', looksDisguised('Mozilla/5.0 (X11; rv:133.0) Gecko/20100101 Firefox/133.0', bare, tls), false);

  const disguised = parseLine(
    JSON.stringify({
      ts: 1757212800,
      request: { host: 'a.example', method: 'GET', uri: '/', headers: bare, tls },
      status: 200,
    })
  ).event;
  ok('disguised client counted as a bot', [disguised.bot, disguised.browser], [1, 'Disguised bot']);
  ok('and not as a page view', disguised.nav, 0);
});

group('Visits', () => {
  // The visit state the database would hold, in memory.
  const rows = [];
  const store = {
    salt: (day) => `salt-${day}`,
    visits: (visitor) => rows.filter((x) => x.visitor === visitor).map((x) => ({ ...x })),
    insert: (v) => rows.push({ ...v, id: rows.length + 1 }),
    update: (v) => Object.assign(rows.find((x) => x.id === v.id), {
      end_ts: v.end_ts, pageviews: v.pageviews, exit_path: v.exit_path,
    }),
  };

  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  let nextId = 1;
  const view = (ts, path, extra = {}) => ({
    id: nextId++, ts, host: 'example.com', ip: '203.0.113.9', ua: 'Browser/1', path, status: 200,
    nav: 1, channel: 'Search', referer_host: 'www.google.com', lang: 'en-US', utm_source: null,
    bytes_out: 0, dur_ms: 0, ...extra,
  });
  const batch = (...views) => {
    const acc = new Accumulator(store);
    for (const v of views) acc.visit(hourBucket(v.ts), v.host, v);
    acc.sessions.persist();
    return acc;
  };
  const rowAt = (acc, ts) => [...acc.rollups.values()].find((r) => r.bucket === hourBucket(ts)) ?? {};
  const dimAt = (acc, dim, value) => {
    const d = [...acc.dims.values()].find((x) => x.dim === dim && x.value === value);
    return d ? [d.requests, d.bytes, d.errors, d.dur_sum] : [0, 0, 0, 0];
  };

  const a = batch(view(T0, '/'), view(T0 + MIN, '/pricing'));
  const r = rowAt(a, T0);
  ok('two page views, one visit', [r.pageviews, r.visits, r.visitors], [2, 1, 1]);
  ok('not a bounce, one minute long', [r.bounces, r.visit_ms], [0, MIN]);
  ok('entry page', dimAt(a, 'entry', '/'), [1, 2, 0, MIN]);
  ok('exit page waits for the visit to close', dimAt(a, 'exit', '/pricing')[0], 0);
  ok('visit credited to its channel once', dimAt(a, 'channel', 'Search'), [1, 2, 0, MIN]);
  ok('external referrer recorded', dimAt(a, 'refsite', 'www.google.com')[0], 1);
  ok('visitor seen once in the hour', a.seen.size, 1);
  ok('visitor written back to both page views', a.visitorOfEvent.size, 2);

  // A later batch extends the stored visit by the difference only.
  const b = batch(view(T0 + 10 * MIN, '/signup', { channel: 'Internal', referer_host: 'example.com' }));
  const rb = rowAt(b, T0);
  ok('extension adds no visit', [rb.visits ?? 0, rb.visitors ?? 0, rb.bounces ?? 0], [0, 0, 0]);
  ok('extension lengthens the visit', rb.visit_ms, 9 * MIN);
  ok('channel stays the landing channel', [dimAt(b, 'channel', 'Search')[0], dimAt(b, 'channel', 'Internal')[0]], [0, 0]);

  // Closing counts the exit page once, with the visit's final figures.
  const closing = new Accumulator(store);
  closing.closeVisit(rows[0]);
  ok('exit page counted on close', dimAt(closing, 'exit', '/signup'), [1, 3, 0, 10 * MIN]);

  const c = batch(view(T0 + 2 * HOUR, '/'));
  ok('after 30 quiet minutes, a new visit by a returning visitor',
    [rowAt(c, T0 + 2 * HOUR).visits, rowAt(c, T0 + 2 * HOUR).visitors, rowAt(c, T0 + 2 * HOUR).bounces], [1, 0, 1]);

  // A closed visit is never extended, even by a page view inside its window.
  rows[rows.length - 1].closed = 1;
  const c2 = batch(view(T0 + 2 * HOUR + 5 * MIN, '/more'));
  ok('a closed visit is not extended', rowAt(c2, T0 + 2 * HOUR).visits, 1);

  const d = batch(view(T0 + 5 * MIN, '/', { ua: 'Other/2' }));
  ok('another browser is another visitor', rowAt(d, T0).visitors, 1);

  const e = batch(view(T0 + 24 * HOUR, '/'));
  ok('the next day is a new visitor', rowAt(e, T0 + 24 * HOUR).visitors, 1);

  const f = batch(view(T0 + 3 * HOUR, '/', { status: 404 }), view(T0 + 3 * HOUR, '/x', { nav: 0 }));
  ok('only page views make visits', [rowAt(f, T0 + 3 * HOUR).visits ?? 0, f.seen.size], [0, 0]);

  ok('visitor id is stable', visitorHash('s', view(T0, '/')), visitorHash('s', view(T0 + MIN, '/a')));
  ok('and differs by salt', visitorHash('s', view(T0, '/')) === visitorHash('t', view(T0, '/')), false);
});

group('notoolkit API', () => {
  const ep = (url, hostHeader) => {
    const r = notoolkitEndpoint(url, hostHeader);
    return [r.url, r.hostHeader, r.migrated];
  };
  ok('default is v1', ep(undefined, undefined), ['https://api.notoolkit.com/v1/', '', false]);
  ok('v1 URL kept as given', ep('https://api.notoolkit.com/v1', ''), ['https://api.notoolkit.com/v1/', '', false]);
  ok('retired root URL is translated', ep('https://notoolkit.com/', ''), ['https://api.notoolkit.com/v1/', '', true]);
  ok('origin by address: path and Host header translated',
    ep('http://10.0.0.5/', 'notoolkit.com'), ['http://10.0.0.5/v1/', 'api.notoolkit.com', true]);
  ok('origin by address already on v1 is kept',
    ep('http://10.0.0.5/v1/', 'api.notoolkit.com'), ['http://10.0.0.5/v1/', 'api.notoolkit.com', false]);

  const ip4 = describeRequest('ip', '8.8.8.8').url;
  const ip6 = describeRequest('ip', '2001:4860:4860::8888').url;
  const asn = describeRequest('asn', 15169).url;
  ok('IP lookup is a path', ip4.pathname.endsWith('/ip/8.8.8.8') && ip4.search === '', true);
  ok('IPv6 keeps its colons', ip6.pathname.endsWith('/ip/2001:4860:4860::8888'), true);
  ok('ASN lookup is a path', asn.pathname.endsWith('/asn/15169'), true);
  let threw = false;
  try {
    describeRequest('ip', '../asn/1');
  } catch {
    threw = true;
  }
  ok('anything but an address is refused', threw, true);
});

group('Stored log lines', () => {
  const line = JSON.stringify({ request: { host: 'example.com', uri: '/ü?q=1' }, status: 200, msg: 'x'.repeat(500) });
  const packed = packRaw(line);
  ok('round trip', unpackRaw(packed), line);
  ok('compressed', packed.length < line.length / 2, true);
});

group('Settings', () => {
  ok('size in GB', sizeMb('20GB', 0), 20 * 1024);
  ok('size in MB', sizeMb('500mb', 0), 500);
  ok('fractional TB', sizeMb('1.5 TB', 0), 1.5 * 1024 * 1024);
  ok('bare number is MB', sizeMb('750', 0), 750);
  ok('empty is the default', sizeMb('', 7), 7);
  ok('nonsense is the default', sizeMb('lots', 7), 7);

  const valid = (s) => Object.keys(validateSettings(s));
  ok('48 hours, no limit', valid({ rawRetentionHours: 48, maxDbSizeMb: 0 }), []);
  ok('until full, with a limit', valid({ rawRetentionHours: 0, maxDbSizeMb: 10240 }), []);
  ok('until full needs a limit', valid({ rawRetentionHours: 0, maxDbSizeMb: 0 }), ['rawRetentionHours']);
  ok('limit too small', valid({ rawRetentionHours: 48, maxDbSizeMb: 10 }), ['maxDbSizeMb']);
  ok('fractional hours refused', valid({ rawRetentionHours: 1.5, maxDbSizeMb: 0 }), ['rawRetentionHours']);
});

group('Live stream filters', () => {
  const row = {
    host: 'example.com', ip: '203.0.113.9', method: 'GET', path: '/blog/post.html', query: 'a=1',
    status: 404, ua: 'Mozilla/5.0 Firefox/133.0', referer: 'https://news.ycombinator.com/x',
    referer_host: 'news.ycombinator.com', country: null, asn: 15169, bot: 0, dur_ms: 42,
    tls_version: 'TLS 1.3', nav: 1, channel: 'Social',
  };
  const keeps = (q) => makeFilter(q)(row);
  ok('no filters keep everything', keeps({}), true);
  ok('host matches, any case', keeps({ host: 'Example.COM' }), true);
  ok('other host', keeps({ host: 'other.org' }), false);
  ok('status class', keeps({ status: '4xx' }), true);
  ok('exact status', keeps({ status: '200' }), false);
  ok('free text, any case', keeps({ q: 'FIREFOX' }), true);
  ok('free text in the query string', keeps({ q: 'a=1' }), true);
  ok('URL contains', keeps({ pathq: '/BLOG' }), true);
  ok('unknown country is XX', keeps({ country: 'XX' }), true);
  ok('referrer site', keeps({ referer: 'news.ycombinator.com' }), true);
  ok('file type', keeps({ ext: 'html' }), true);
  ok('ASN', keeps({ asn: '15169' }), true);
  ok('slower than', keeps({ minDur: '100' }), false);
  ok('latency bucket', keeps({ lat: '25-50 ms' }), true);
  ok('a 404 is not a page view', keeps({ pageview: '1' }), false);
  ok('channel', keeps({ channel: 'Social' }), true);
  ok('humans only', keeps({ bots: 'exclude' }), true);
  ok('all must match', keeps({ host: 'example.com', status: '5xx' }), false);
  ok('a time range is search-only', SEARCH_ONLY_FILTERS, ['from', 'to']);
});

group('Embedding origins', () => {
  const p = (raw) => parseOrigins(raw);
  ok('empty is none', p(''), { origins: [], invalid: [] });
  ok('normalised: case, slash, default port',
    p('HTTPS://HomeControl.Example.com:443/, http://10.30.2.38:80').origins,
    ['https://homecontrol.example.com', 'http://10.30.2.38']);
  ok('other ports kept', p('http://10.30.2.38:8080').origins, ['http://10.30.2.38:8080']);
  ok('duplicates once', p('https://a.example,https://a.example/').origins, ['https://a.example']);
  ok('a path is refused', p('https://a.example/portal').invalid, ['https://a.example/portal']);
  ok('a wildcard is refused', p('https://*.example.com').invalid, ['https://*.example.com']);
  ok('not a URL is refused', p('homecontrol').invalid, ['homecontrol']);
  ok('other schemes are refused', p('ftp://a.example').invalid, ['ftp://a.example']);
  ok('good ones kept beside bad', p('https://a.example,nope').origins, ['https://a.example']);
});

group('Changelog', () => {
  const releases = parseChangelog(
    [
      '# Changelog',
      '',
      'Introduction, not part of any release.',
      '',
      '## [1.1.0] — 2026-09-30',
      '',
      '### Added',
      '',
      '- A thing.',
      '',
      '## [1.0.0] - 2026-09-27',
      '',
      'First release.',
      '',
      '[1.1.0]: https://example.com/v1.1.0',
    ].join('\r\n')
  );
  ok('one entry per release heading', releases.map((r) => r.version), ['1.1.0', '1.0.0']);
  ok('date after an em dash', releases[0].date, '2026-09-30');
  ok('date after a hyphen', releases[1].date, '2026-09-27');
  ok('notes run to the next heading', releases[0].notes, '### Added\n\n- A thing.');
  ok('link definitions are not notes', releases[1].notes, 'First release.');
  ok('link definition gives the URL', releases[0].url, 'https://example.com/v1.1.0');
  ok('no URL without a definition', releases[1].url, null);
});

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('All good.');
