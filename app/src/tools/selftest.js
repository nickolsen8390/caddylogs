// Self-contained checks for the pure logic that is easy to get subtly wrong
// and hard to notice: CIDR matching, IP normalisation, and log parsing.
// Touches no database, no network, no log files.
//
//   docker compose run --rm --no-deps app node src/tools/selftest.js

import { cidrMatcher, isPrivateIp, normalizeIp, isIPv4 } from '../util/net.js';
import { parseLine, latencyBucket, extensionOf, refererHost } from '../ingest/parser.js';
import { parseUserAgent } from '../ingest/useragent.js';

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

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('All good.');
