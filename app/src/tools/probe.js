// Connectivity probe for the notoolkit API, run from inside the container so
// it tests the network path the enricher actually uses.
//
//   docker compose run --rm --no-deps app node src/tools/probe.js [ip] [--force]
//
// Touches no database and writes nothing. Respects NOTOOLKIT_ENABLED=false:
// with lookups disabled for offline operation, it makes no network request
// unless --force is given.

import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { describeRequest } from '../enrich/notoolkit.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const testIp = args.find((a) => !a.startsWith('--')) || '8.8.8.8';

if (!config.notoolkit.enabled && !force) {
  console.log('notoolkit lookups are disabled (NOTOOLKIT_ENABLED=false).');
  console.log('The stack makes no calls to notoolkit.com in this mode, so there is');
  console.log('nothing to probe. Country data still comes from MaxMind, and ASNs from');
  console.log('GeoLite2-ASN.mmdb if that file is present.');
  console.log('');
  console.log('To test connectivity anyway, without changing .env, add --force.');
  process.exit(0);
}

const { url, headers } = describeRequest({ ip: testIp });
const target = new URL(url);

console.log('notoolkit connectivity probe');
console.log('---------------------------');
console.log(`  NOTOOLKIT_API_URL   ${config.notoolkit.url}`);
console.log(`  request URL         ${url}`);
console.log(`  Host header         ${headers.Host ?? `(default: ${target.hostname})`}`);
console.log(`  timeout             ${config.notoolkit.timeoutMs} ms`);
console.log(`  enabled             ${config.notoolkit.enabled}`);
console.log('');

// --- DNS -------------------------------------------------------------------
let addresses = [];
if (net.isIP(target.hostname)) {
  addresses = [{ address: target.hostname, family: net.isIP(target.hostname) }];
  console.log(`DNS      skipped, ${target.hostname} is already an address`);
} else {
  try {
    addresses = await dns.lookup(target.hostname, { all: true });
    console.log(`DNS      ${target.hostname} -> ${addresses.map((a) => a.address).join(', ')}`);
  } catch (err) {
    console.error(`DNS      FAILED to resolve ${target.hostname}: ${err.message}`);
    console.error('');
    console.error('The container cannot resolve the API hostname. Check the DNS');
    console.error('configuration of the Docker daemon, or point NOTOOLKIT_API_URL at an');
    console.error('address directly and set NOTOOLKIT_HOST_HEADER.');
    process.exit(2);
  }
}

// --- TCP -------------------------------------------------------------------
const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
const first = addresses[0]?.address;

async function tcpCheck(address) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port, timeout: config.notoolkit.timeoutMs });
    socket.on('connect', () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - started });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, err: 'timed out' });
    });
    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, err: err.message });
    });
  });
}

const tcp = await tcpCheck(first);
if (tcp.ok) {
  console.log(`TCP      connected to ${first}:${port} in ${tcp.ms} ms`);
} else {
  console.error(`TCP      FAILED to reach ${first}:${port} after ${tcp.ms} ms (${tcp.err})`);
  console.error('');
  console.error('The address resolves but nothing accepts a connection from this');
  console.error('container. The usual cause, when this stack monitors the same server');
  console.error('that hosts the API:');
  console.error('');
  console.error('  NAT hairpin. The container resolves the public address, sends the');
  console.error('  packet out the default route, and the firewall will not loop it back');
  console.error('  in from the Docker subnet. It works from the host (never leaves the');
  console.error('  box) and from outside (arrives normally), but not from in here.');
  console.error('');
  console.error('Fix by not leaving the network at all. In .env:');
  console.error('');
  console.error('  NOTOOLKIT_API_URL=http://<origin-lan-address>/');
  console.error(`  NOTOOLKIT_HOST_HEADER=${target.hostname}`);
  console.error('');
  console.error('See README section 5, "When the API is on the same server".');
  process.exit(3);
}

// --- HTTP ------------------------------------------------------------------
const started = Date.now();
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), config.notoolkit.timeoutMs);
try {
  const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
  const ms = Date.now() - started;
  console.log(`HTTP     ${res.status} ${res.statusText} in ${ms} ms`);

  if (res.status === 404) {
    console.log('');
    console.log(`No BGP prefix covers ${testIp}. That is a valid answer, not a fault —`);
    console.log('the pipeline caches it and moves on. Try a different address.');
    process.exit(0);
  }
  if (!res.ok) {
    console.error('');
    console.error(`The API answered but with an error status. Body: ${(await res.text()).slice(0, 300)}`);
    process.exit(4);
  }

  const body = await res.json();
  console.log('');
  console.log('Raw response');
  console.log(JSON.stringify({ ...body, whois_raw: body.whois_raw ? '<truncated>' : undefined }, null, 2).slice(0, 1400));
  console.log('');
  console.log('Interpreted');
  console.log(`  ASN        ${body.asn ?? '(none)'}`);
  console.log(`  AS name    ${body.asn_name ?? '(none)'}`);
  console.log(`  Org        ${body.org_name ?? '(none)'}`);
  console.log(`  Prefix     ${body.prefix ?? '(none)'}`);
  console.log(`  RIR        ${body.rir ?? '(none)'}`);
  console.log(`  Registered ${body.country ?? '(none)'}  <- the AS registrant, not the visitor`);
  console.log(`  Cache hit  ${body.cache_hit ?? '(not reported)'}`);
  console.log('');
  console.log('Enrichment is working.');
} catch (err) {
  const ms = Date.now() - started;
  const why = err?.name === 'AbortError' ? `timed out after ${ms} ms` : err.message;
  console.error(`HTTP     FAILED: ${why}`);
  console.error('');
  console.error('TCP connected but the HTTP exchange did not complete. If this is an');
  console.error('https:// URL pointed at an origin by address, the TLS certificate will');
  console.error('not match — use http:// with NOTOOLKIT_HOST_HEADER instead.');
  process.exit(5);
} finally {
  clearTimeout(timer);
}
