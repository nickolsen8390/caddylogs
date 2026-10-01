// The running version and its release notes, for the Health page.
//
// The version comes from package.json, which the release workflow checks
// against the tag. The notes are CHANGELOG.md, the same text the GitHub
// releases are written from: the image carries a copy next to package.json;
// in a source checkout it is found at the repository root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './util/log.js';

const log = logger('release');
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

/** @returns {{version:string, releases:{version:string, date:string|null, url:string|null, notes:string}[]}} */
export function releaseInfo() {
  cached ??= load();
  return cached;
}

function load() {
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  } catch (err) {
    log.warn('cannot read package.json', { err: err.message });
  }

  let releases = [];
  const file = [path.join(appDir, 'CHANGELOG.md'), path.join(appDir, '..', 'CHANGELOG.md')].find(
    (f) => fs.existsSync(f)
  );
  if (file) {
    try {
      releases = parseChangelog(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log.warn('cannot read the changelog', { file, err: err.message });
    }
  } else {
    log.warn('CHANGELOG.md not found; the Health page will show no release notes');
  }
  return { version, releases };
}

/**
 * Splits a Keep a Changelog style file into releases. Each release starts at a
 * `## [1.0.3] — 2026-09-29` heading and runs to the next one; link reference
 * definitions (`[1.0.3]: https://…`) at the end give each release its URL.
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const links = new Map();
  const releases = [];
  let current = null;

  for (const line of lines) {
    const link = /^\[([^\]]+)\]:\s*(\S+)\s*$/.exec(line);
    if (link) {
      links.set(link[1], link[2]);
      continue;
    }
    const head = /^##\s+\[?([^\]\s]+)\]?(?:\s*[—–-]\s*(.+?))?\s*$/.exec(line);
    if (head) {
      current = { version: head[1], date: head[2] ?? null, body: [] };
      releases.push(current);
      continue;
    }
    // Anything before the first release heading is the file's introduction.
    current?.body.push(line);
  }

  return releases.map(({ version, date, body }) => ({
    version,
    date,
    url: links.get(version) ?? null,
    notes: body.join('\n').trim(),
  }));
}
