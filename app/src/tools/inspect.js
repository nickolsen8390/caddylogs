// Parser sanity check against real logs, without writing anything.
//
//   docker compose run --rm --no-deps app node src/tools/inspect.js [count]
//
// Prints how many lines parsed, why the rest did not, and a couple of fully
// decoded examples. Run this first if the dashboard looks empty.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { parseLine } from '../ingest/parser.js';

const want = parseInt(process.argv[2] || '2000', 10);

let files;
try {
  files = fs
    .readdirSync(config.logDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => path.join(config.logDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
} catch (err) {
  console.error(`Cannot read ${config.logDir}: ${err.message}`);
  console.error('Check CADDY_LOG_HOST_PATH in .env and that the bind mount exists.');
  process.exit(1);
}

if (!files.length) {
  console.error(`No *.log files found in ${config.logDir}.`);
  process.exit(1);
}

console.log(`Log directory: ${config.logDir}`);
console.log(`Files found  : ${files.length} (newest: ${path.basename(files[0])})\n`);

const counts = { total: 0, ok: 0, json: 0, 'not-access': 0, 'no-host': 0 };
const samples = [];
const hosts = new Map();

const rl = readline.createInterface({ input: fs.createReadStream(files[0]), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  counts.total += 1;
  const res = parseLine(line);
  if (res.ok) {
    counts.ok += 1;
    hosts.set(res.event.host, (hosts.get(res.event.host) ?? 0) + 1);
    if (samples.length < 2) samples.push(res.event);
  } else {
    counts[res.reason] += 1;
    if (res.reason === 'json' && counts.json <= 2) {
      console.log('Unparseable line:', line.slice(0, 300));
    }
  }
  if (counts.total >= want) break;
}

console.log('Results');
console.log('-------');
console.log(`  lines read        : ${counts.total}`);
console.log(`  parsed as requests: ${counts.ok}`);
console.log(`  not access logs   : ${counts['not-access']}  (startup/TLS/admin entries — expected)`);
console.log(`  missing a host    : ${counts['no-host']}`);
console.log(`  invalid JSON      : ${counts.json}`);

if (!counts.ok) {
  console.log('\nNothing parsed. Confirm Caddy is using the `json` log format:');
  console.log('    log { output file /var/log/caddy/access.log; format json }');
  process.exit(2);
}

console.log(`\nDistinct hosts in this sample: ${hosts.size}`);
for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(7)}  ${h}`);
}

console.log('\nDecoded examples');
console.log('----------------');
for (const s of samples) {
  const { raw, ...rest } = s;
  console.log(JSON.stringify(rest, null, 2));
}

const missing = [];
if (samples.length) {
  const s = samples[0];
  if (!s.ua) missing.push('User-Agent (browser/OS/bot stats will be empty)');
  if (s.dur_ms === null) missing.push('duration (latency percentiles will be empty)');
  if (!s.tls_version) missing.push('TLS details (plain HTTP, or TLS info not logged)');
  if (!s.ip) missing.push('client IP (country/ASN stats will be empty)');
}
if (missing.length) {
  console.log('\nFields absent from these logs:');
  for (const m of missing) console.log(`  - ${m}`);
}
