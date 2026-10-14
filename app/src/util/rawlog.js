// Storage form of a request's original log line: raw DEFLATE, in the
// events_raw table (see schema.sql). Caddy's JSON lines compress three to
// four times, and keeping them out of `events` keeps that table small enough
// to scan.

import zlib from 'node:zlib';

export const packRaw = (text) => zlib.deflateRawSync(Buffer.from(text, 'utf8'));

export const unpackRaw = (blob) => zlib.inflateRawSync(blob).toString('utf8');

/**
 * The original log line of one stored request, wherever it is kept: rows
 * written from 1.2.3 on have it in events_raw, older ones inline in
 * events.raw until they age out.
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null}
 */
export function readRaw(db, id) {
  const packed = db.prepare('SELECT raw FROM events_raw WHERE id = ?').get(id);
  if (packed) return unpackRaw(packed.raw);
  return db.prepare('SELECT raw FROM events WHERE id = ?').get(id)?.raw ?? null;
}
