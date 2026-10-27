// Settings changed from the Settings page. Saved in the database so both
// processes — the web UI and the ingester, which prunes — see a change
// without a restart; .env gives the starting value of each.

import { getDb } from './db.js';
import { config } from './config.js';

const HOUR_MS = 3_600_000;

/** The smallest size limit accepted: below this the app itself barely fits. */
export const MIN_DB_SIZE_MB = 256;
/** Ten years. Anything longer is a typo. */
const MAX_RETENTION_HOURS = 24 * 3650;

const DEFINITIONS = {
  // Hours to keep individual requests. 0 = keep them until the database
  // reaches maxDbSizeMb, the oldest going first.
  rawRetentionHours: { fallback: () => config.retention.rawHours },
  // Largest the database may grow, in MB. 0 = no limit. When reached, the
  // oldest data is pruned whatever the retention settings say.
  maxDbSizeMb: { fallback: () => config.retention.maxDbSizeMb },
  // Hours to keep a stored request's original log line — most of what a
  // request takes. 0 = as long as the request. Shorter keeps more requests
  // in the same space; the request detail then shows only the parsed fields.
  rawLineHours: { fallback: () => config.retention.rawLineHours },
};

let cache = null;
let cachedAt = 0;
const CACHE_MS = 5_000;

/** Defaults from .env, before anything saved from the Settings page. */
export function defaultSettings() {
  return Object.fromEntries(Object.entries(DEFINITIONS).map(([k, d]) => [k, d.fallback()]));
}

/** The settings in force: saved values over .env defaults. Cached briefly. */
export function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const out = defaultSettings();
  try {
    for (const { key, value } of getDb().prepare('SELECT key, value FROM settings').all()) {
      if (key in DEFINITIONS) out[key] = JSON.parse(value);
    }
  } catch {
    /* table not there yet (a tool opening an older database): defaults */
  }
  // "Until the size limit" with no limit would keep requests forever. The
  // Settings page refuses it; .env cannot, so fall back to the old default.
  if (out.rawRetentionHours === 0 && !out.maxDbSizeMb) out.rawRetentionHours = 48;
  cache = out;
  cachedAt = Date.now();
  return out;
}

/** Who last saved each setting, and when. */
export function settingsHistory() {
  try {
    return getDb().prepare('SELECT key, updated_at, username FROM settings').all();
  } catch {
    return [];
  }
}

/**
 * Check a proposed set of settings. Returns a map of field -> problem; empty
 * when they can be saved.
 */
export function validateSettings(s) {
  const problems = {};
  const hours = s.rawRetentionHours;
  const size = s.maxDbSizeMb;
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_RETENTION_HOURS) {
    problems.rawRetentionHours = 'Enter a whole number of hours from 1 to 87,600, or keep until the size limit.';
  }
  if (!Number.isInteger(size) || size < 0) {
    problems.maxDbSizeMb = 'Enter a size, or 0 for no limit.';
  } else if (size > 0 && size < MIN_DB_SIZE_MB) {
    problems.maxDbSizeMb = `The smallest limit is ${MIN_DB_SIZE_MB} MB.`;
  }
  if (hours === 0 && size === 0) {
    problems.rawRetentionHours = 'Keeping requests until the size limit needs a size limit to be set.';
  }
  const lines = s.rawLineHours ?? 0;
  if (!Number.isInteger(lines) || lines < 0 || lines > MAX_RETENTION_HOURS) {
    problems.rawLineHours = 'Enter a whole number of hours from 1 to 87,600, or keep them as long as the requests.';
  }
  return problems;
}

/**
 * Save settings. Only known keys are written; the rest keep their value.
 * @returns {{ok: true, settings: object} | {ok: false, problems: object}}
 */
export function saveSettings(changes, username) {
  const next = { ...getSettings() };
  for (const key of Object.keys(DEFINITIONS)) {
    if (changes[key] !== undefined) next[key] = changes[key];
  }
  const problems = validateSettings(next);
  if (Object.keys(problems).length) return { ok: false, problems };

  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at, username) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                      username = excluded.username`
  );
  const now = Date.now();
  db.transaction(() => {
    for (const key of Object.keys(DEFINITIONS)) upsert.run(key, JSON.stringify(next[key]), now, username ?? null);
  })();
  cache = null;
  return { ok: true, settings: getSettings() };
}

/** How long individual requests are kept, in ms; Infinity = until the size limit. */
export function rawRetentionMs() {
  const hours = getSettings().rawRetentionHours;
  return hours > 0 ? hours * HOUR_MS : Infinity;
}

/** How long original log lines are kept, in ms; Infinity = as long as their request. */
export function rawLineRetentionMs() {
  const hours = getSettings().rawLineHours;
  return hours > 0 ? hours * HOUR_MS : Infinity;
}

/** The size limit in bytes, or null for none. */
export function maxDbBytes() {
  const mb = getSettings().maxDbSizeMb;
  return mb > 0 ? mb * 1_048_576 : null;
}

/**
 * The retention facts the UI shows next to stored requests: `hours` (null when
 * kept until the size limit) and the size limit, if any.
 */
export function retentionInfo() {
  const s = getSettings();
  return {
    hours: s.rawRetentionHours > 0 ? s.rawRetentionHours : null,
    untilFull: s.rawRetentionHours === 0,
    maxDbSizeMb: s.maxDbSizeMb || null,
    lineHours: s.rawLineHours > 0 ? s.rawLineHours : null,
  };
}
