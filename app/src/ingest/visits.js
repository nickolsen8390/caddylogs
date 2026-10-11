// Visitors and visits, stitched together from page views.
//
// A visitor is a hash of a per-day random salt, the site, the client address
// and the User-Agent — the scheme Plausible uses. The salt is new every UTC
// day, so the same person on two days is two visitors, and once a day's salt
// is deleted (maintenance.js) its hashes can no longer be recomputed from an
// address. A visit is that visitor's page views with no gap over 30 minutes.
//
// Visits are counted the moment they start and corrected as they grow (see
// Accumulator.visitDelta in rollup.js), so the numbers are live rather than
// waiting for a visit to time out. The `visits` table only holds the state
// needed to extend a visit; the statistics themselves live in rollup/dims.

import crypto from 'node:crypto';
import { getDb } from '../db.js';

export const VISIT_GAP_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
export const SALT_PREFIX = 'visitor_salt:';

/** Columns a visit carries from its first page view. */
export const ATTRIBUTION = [
  'channel', 'refsite', 'lang', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];

/** Visitor id: the salted hash, shortened — 128 bits is plenty to stay unique. */
export function visitorHash(salt, ev) {
  return crypto
    .createHash('sha256')
    .update(`${salt}\n${ev.host}\n${ev.ip ?? ''}\n${ev.ua ?? ''}`)
    .digest('base64url')
    .slice(0, 22);
}

let stmts = null;
function prep() {
  if (stmts) return stmts;
  const db = getDb();
  stmts = {
    salt: db.prepare('SELECT value FROM meta WHERE key = ?'),
    addSalt: db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)'),
    // The visit this page view belongs to: one that had not yet gone quiet
    // for VISIT_GAP_MS. Matching on a window rather than "the latest visit"
    // lets older page views (a backfill) find their own, earlier visit.
    find: db.prepare(
      `SELECT * FROM visits WHERE visitor = ? AND end_ts >= ? AND start_ts <= ?
        ORDER BY end_ts LIMIT 1`
    ),
    seen: db.prepare('SELECT 1 FROM visits WHERE visitor = ? LIMIT 1'),
    insert: db.prepare(
      `INSERT INTO visits (visitor, host, start_ts, end_ts, pageviews, entry_path, exit_path,
                           first, touched, ${ATTRIBUTION.join(', ')})
       VALUES (@visitor, @host, @start_ts, @end_ts, @pageviews, @entry_path, @exit_path,
               @first, @touched, ${ATTRIBUTION.map((c) => `@${c}`).join(', ')})`
    ),
    update: db.prepare(
      `UPDATE visits SET end_ts = @end_ts, pageviews = @pageviews, exit_path = @exit_path,
                         touched = @touched
        WHERE id = @id`
    ),
  };
  return stmts;
}

const salts = new Map();

/** The salt for one UTC day, created the first time that day is seen. */
function saltFor(day) {
  const cached = salts.get(day);
  if (cached) return cached;
  const s = prep();
  const key = `${SALT_PREFIX}${day}`;
  if (!s.salt.get(key)) s.addSalt.run(key, crypto.randomBytes(24).toString('base64url'));
  const salt = s.salt.get(key).value;
  if (salts.size > 16) salts.clear();
  salts.set(day, salt);
  return salt;
}

/** Forget cached salts, so ones maintenance deleted are not reused. */
export function forgetSalts() {
  salts.clear();
}

/** Visit state in the database. The self-test swaps in a memory store. */
export function dbStore() {
  const s = prep();
  return {
    salt: saltFor,
    find: (visitor, lo, hi) => s.find.get(visitor, lo, hi) ?? null,
    seen: (visitor) => Boolean(s.seen.get(visitor)),
    insert: (v, now) => {
      const p = { touched: now };
      for (const k of ['visitor', 'host', 'start_ts', 'end_ts', 'pageviews', 'entry_path', 'exit_path', 'first', ...ATTRIBUTION]) {
        p[k] = v[k] ?? null;
      }
      return Number(s.insert.run(p).lastInsertRowid);
    },
    update: (v, now) =>
      s.update.run({ id: v.id, end_ts: v.end_ts, pageviews: v.pageviews, exit_path: v.exit_path, touched: now }),
  };
}

/**
 * Groups one batch of page views into visits. `onChange(visit, sign)` is
 * called with -1 before a visit changes and +1 after, so the caller can move
 * its counters by exactly the difference.
 */
export class Sessionizer {
  constructor(onChange, store = dbStore()) {
    this.onChange = onChange;
    this.store = store;
    this.byVisitor = new Map(); // visitor -> visits touched in this batch
    this.dirty = new Set();
  }

  /**
   * @param {object} ev a page view, with its visitor-analytics fields
   * @param {string|null} refsite the external referrer, or null
   */
  add(ev, refsite) {
    const visitor = visitorHash(this.store.salt(Math.floor(ev.ts / DAY_MS)), ev);
    const v = this.find(visitor, ev.ts);

    if (!v) {
      const created = {
        id: null,
        visitor,
        host: ev.host,
        start_ts: ev.ts,
        end_ts: ev.ts,
        pageviews: 1,
        entry_path: ev.path,
        exit_path: ev.path,
        first: this.byVisitor.has(visitor) || this.store.seen(visitor) ? 0 : 1,
        channel: ev.channel ?? 'Direct',
        refsite,
        lang: ev.lang ?? null,
      };
      for (const k of ATTRIBUTION.slice(3)) created[k] = ev[k] ?? null;
      this.remember(created);
      this.dirty.add(created);
      this.onChange(created, 1);
      return;
    }

    this.onChange(v, -1);
    v.pageviews += 1;
    // A page view older than the visit's start (logs arriving out of order)
    // still counts, but does not move the start, the entry page or the hour
    // the visit is counted in.
    if (ev.ts >= v.end_ts) {
      v.end_ts = ev.ts;
      v.exit_path = ev.path;
    }
    this.dirty.add(v);
    this.onChange(v, 1);
  }

  find(visitor, ts) {
    const mine = this.byVisitor.get(visitor);
    if (mine) {
      for (const v of mine) {
        if (ts >= v.start_ts - VISIT_GAP_MS && ts <= v.end_ts + VISIT_GAP_MS) return v;
      }
    }
    const row = this.store.find(visitor, ts - VISIT_GAP_MS, ts + VISIT_GAP_MS);
    if (!row) return null;
    // Already in memory with newer values than the stored row.
    const loaded = mine?.find((v) => v.id === row.id);
    if (loaded) return loaded;
    this.remember(row);
    return row;
  }

  remember(v) {
    const list = this.byVisitor.get(v.visitor);
    if (list) list.push(v);
    else this.byVisitor.set(v.visitor, [v]);
  }

  /** Write changed visits. Runs inside the caller's transaction. */
  persist(now = Date.now()) {
    for (const v of this.dirty) {
      if (v.id === null) v.id = this.store.insert(v, now);
      else this.store.update(v, now);
    }
    this.dirty.clear();
  }
}
