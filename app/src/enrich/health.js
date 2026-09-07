// Provider health, persisted so the web process can surface an enrichment
// failure banner even though the calls happen in the ingest process.

import { getDb } from '../db.js';

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    ok: db.prepare(
      `INSERT INTO provider_health (provider, ok, last_ok_at, calls, failures)
         VALUES (?, 1, ?, 1, 0)
       ON CONFLICT(provider) DO UPDATE SET
         ok = 1, last_ok_at = excluded.last_ok_at, calls = provider_health.calls + 1`
    ),
    fail: db.prepare(
      `INSERT INTO provider_health (provider, ok, last_error, last_error_at, calls, failures)
         VALUES (?, 0, ?, ?, 1, 1)
       ON CONFLICT(provider) DO UPDATE SET
         ok = 0, last_error = excluded.last_error, last_error_at = excluded.last_error_at,
         calls = provider_health.calls + 1, failures = provider_health.failures + 1`
    ),
    read: db.prepare('SELECT * FROM provider_health'),
  };
  return stmts;
}

// Health rows are written on every call, which would be a wasteful amount of
// write traffic at high request rates. Coalesce: always persist a state change
// immediately, otherwise at most once every few seconds.
const lastWrite = new Map();
const MIN_INTERVAL_MS = 5000;
const lastState = new Map();

export function recordProviderResult(provider, ok, error) {
  const s = prep();
  const changed = lastState.get(provider) !== ok;
  const due = Date.now() - (lastWrite.get(provider) ?? 0) > MIN_INTERVAL_MS;
  lastState.set(provider, ok);
  if (!changed && !due) return;
  lastWrite.set(provider, Date.now());
  try {
    if (ok) s.ok.run(provider, Date.now());
    else s.fail.run(provider, String(error ?? 'unknown error').slice(0, 500), Date.now());
  } catch {
    /* health reporting must never break enrichment */
  }
}

export function readProviderHealth() {
  try {
    return prep().read.all();
  } catch {
    return [];
  }
}
