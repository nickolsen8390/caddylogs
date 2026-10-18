// Requests: the live log stream and the request explorer in one page.
//
// With no filters it streams — new requests appear at the bottom within about
// a second. Searching stops the stream and lists the matching requests
// instead, newest first; Reset clears the search and goes back to live.
//
// Any dimension value from anywhere in the app resolves here as a search.
// Filters can also be built directly — with the field row, a time range, or
// key:value terms typed into the search box (host:example.com ua:curl
// status:4xx). The filter set lives entirely in the URL, so every view is a
// shareable link and the back button behaves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, ApiError } from '../lib/api.js';
import { useApi, useHostOptions, useLocalState } from '../lib/useApi.js';
import { Banner, Chip, Loading, Panel } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { FILTER_KEYS, FILTER_LABELS, filterValueLabel } from '../lib/drill.js';
import { normalizeFilterValue, parseSearch } from '../lib/search.js';
import { compact, keptFor, num, relative } from '../lib/format.js';

const PAGE = 100;
/** Requests kept on screen while streaming; older ones scroll away. */
const MAX_LIVE_ROWS = 3000;
/**
 * A search stops at a time budget on the server, so a rare match can need
 * several round trips to find a page of results. They are made without
 * asking, up to this many, before the "search older" button takes over.
 */
const AUTO_ROUNDS = 12;

/** Filters edited through the field row. Anything else stays a removable chip. */
const BAR_KEYS = ['host', 'ip', 'status', 'method', 'pathq', 'uaq', 'country', 'asn', 'bots', 'from', 'to'];
const EMPTY_DRAFT = Object.fromEntries(BAR_KEYS.map((k) => [k, '']));

/** Quick choices for the start of the time range. */
const SINCE = [
  ['15m', 'Last 15 minutes', 15 * 60_000],
  ['1h', 'Last hour', 3_600_000],
  ['6h', 'Last 6 hours', 6 * 3_600_000],
  ['24h', 'Last 24 hours', 86_400_000],
  ['7d', 'Last 7 days', 7 * 86_400_000],
];

/** A ms timestamp as a datetime-local value, in the browser's time zone. */
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
/** A datetime-local value (browser's time zone) as a ms timestamp string. */
function fromLocalInput(s) {
  if (!s) return '';
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? String(t) : '';
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = obj[k];
  return out;
}

function withoutEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

/** The field row's values, as the inputs show them. */
function draftOf(active) {
  const d = { ...EMPTY_DRAFT, ...pick(active, BAR_KEYS) };
  d.from = toLocalInput(active.from);
  d.to = toLocalInput(active.to);
  return d;
}

export default function Requests({ ctx }) {
  const [params, setParams] = useSearchParams();
  const paramString = params.toString();

  const active = useMemo(() => {
    const out = {};
    const p = new URLSearchParams(paramString);
    for (const key of FILTER_KEYS) {
      const v = p.get(key);
      if (v !== null && v !== '') out[key] = v;
    }
    return out;
  }, [paramString]);
  // Any filter at all is a search; none is the live stream.
  const live = Object.keys(active).length === 0;

  // Editable copies of the filters. They follow the URL, so arriving by a
  // drill-down link, removing a chip or pressing back all update the fields.
  const [draft, setDraft] = useState(() => draftOf(active));
  const [search, setSearch] = useState(active.q ?? '');
  // Phones only: the field filters fold away behind a button.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const barFilters = BAR_KEYS.filter((k) => active[k]).length;
  useEffect(() => {
    setDraft(draftOf(active));
    setSearch(active.q ?? '');
  }, [active]);

  const hostOptions = useHostOptions(active.host, { onUnauthorized: ctx?.onUnauthorized });
  const meta = useApi('/api/meta', { refreshMs: 120_000, onUnauthorized: ctx?.onUnauthorized });

  function applyFilters(e) {
    e?.preventDefault();
    const { structured, q } = parseSearch(search);
    // Filters that are not on the field row (a browser or TLS version from a
    // drill-down link, say) carry over. Typed key:value terms win over fields.
    const carried = {};
    for (const [k, v] of Object.entries(active)) {
      if (!BAR_KEYS.includes(k) && k !== 'q') carried[k] = v;
    }
    const fields = {};
    for (const k of BAR_KEYS) fields[k] = normalizeFilterValue(k, draft[k]);
    fields.from = fromLocalInput(draft.from);
    fields.to = fromLocalInput(draft.to);
    setParams(withoutEmpty({ ...carried, ...fields, ...structured, q }));
    setFieldsOpen(false);
  }

  function removeFilter(key) {
    const next = { ...active };
    delete next[key];
    setParams(next);
  }

  const field = (key) => ({
    value: draft[key],
    onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
  });

  function since(e) {
    const choice = SINCE.find(([id]) => id === e.target.value);
    if (choice) setDraft((d) => ({ ...d, from: toLocalInput(Date.now() - choice[2]), to: '' }));
  }

  const chips = Object.entries(active);
  const retention = meta.data?.retention;

  return (
    <div className={live ? 'requests-live' : undefined}>
      <form className="panel filter-bar" onSubmit={applyFilters} style={{ marginBottom: 12 }}>
        <div className="filter-search">
          <input
            className="input"
            aria-label="Search requests"
            placeholder='Search, or terms like  host:example.com  ua:curl  status:4xx  url:/wp-login  ip:1.2.3.4'
            title="Free text, or key:value terms — host: ua: status: url: ip: country: asn: ref: bot:"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn sm primary" type="submit" title="Search stored requests; the live stream pauses">
            Search
          </button>
          <button className="btn sm" type="button" onClick={() => setParams({})}
                  title="Clear the search and go back to the live stream">
            Reset
          </button>
        </div>
        <button
          type="button"
          className="btn sm mobile-only"
          aria-expanded={fieldsOpen}
          onClick={() => setFieldsOpen(!fieldsOpen)}
        >
          {fieldsOpen ? 'Hide filters ▴' : `More filters${barFilters ? ` (${barFilters} set)` : ''} ▾`}
        </button>
        <div className={`filter-fields${fieldsOpen ? ' open' : ''}`}>
          <label>
            Domain
            <select className="input" {...field('host')}>
              <option value="">Any domain</option>
              {hostOptions.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <label>
            Source IP
            <input className="input mono" placeholder="203.0.113.9" {...field('ip')} />
          </label>
          <label>
            Status
            <input className="input" placeholder="404 or 4xx" {...field('status')} />
          </label>
          <label>
            Method
            <select className="input" {...field('method')}>
              <option value="">Any method</option>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            URL contains
            <input className="input mono" placeholder="/wp-login" {...field('pathq')} />
          </label>
          <label>
            User agent contains
            <input className="input" placeholder="curl, Googlebot…" {...field('uaq')} />
          </label>
          <label>
            Country
            <input className="input" placeholder="US" maxLength={2} {...field('country')} />
          </label>
          <label>
            ASN
            <input className="input mono" placeholder="15169" {...field('asn')} />
          </label>
          <label>
            Traffic
            <select className="input" {...field('bots')}>
              <option value="">Bots &amp; humans</option>
              <option value="exclude">Humans only</option>
              <option value="only">Bots only</option>
            </select>
          </label>
          <label>
            Time
            <select className="input" value="" onChange={since} aria-label="Quick time range">
              <option value="">Pick a period…</option>
              {SINCE.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            From
            <input className="input" type="datetime-local" {...field('from')} />
          </label>
          <label>
            To
            <input className="input" type="datetime-local" {...field('to')} />
          </label>
        </div>
      </form>

      {live ? (
        <LiveStream />
      ) : (
        <SearchResults
          active={active}
          chips={chips}
          onRemove={removeFilter}
          onReset={() => setParams({})}
          retention={retention}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Live: the stream of new requests
// ---------------------------------------------------------------------------

function LiveStream() {
  const [rows, setRows] = useState([]);
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState('connecting');
  const [follow, setFollow] = useLocalState('cli.logs.follow', true);
  const [rate, setRate] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [seedError, setSeedError] = useState(null);

  // While paused, arriving requests collect here instead of re-rendering the
  // list, so the rows under the cursor never move.
  const pausedBuffer = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [pendingCount, setPendingCount] = useState(0);
  const viewRef = useRef(null);
  const rateWindow = useRef([]);

  const appendRows = useCallback((incoming) => {
    setRows((prev) => {
      // The seeded history and the stream can overlap (the hub's cursor is
      // shared across tabs), and both are ascending by id — so dropping
      // anything not newer than the last row we hold prevents duplicate keys.
      const lastId = prev.length ? prev[prev.length - 1].id : 0;
      const fresh = incoming.filter((r) => r.id > lastId);
      if (!fresh.length) return prev;
      const next = prev.concat(fresh);
      return next.length > MAX_LIVE_ROWS ? next.slice(next.length - MAX_LIVE_ROWS) : next;
    });
  }, []);

  // Seed with recent history so the view is never empty on arrival.
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/requests${qs({ limit: 200 })}`)
      .then((res) => {
        if (cancelled) return;
        const seed = (res?.rows ?? []).slice().reverse();
        // Anything the stream delivered meanwhile is newer: keep it after.
        setRows((streamed) => {
          const lastSeed = seed.length ? seed[seed.length - 1].id : 0;
          return seed.concat(streamed.filter((r) => r.id > lastSeed));
        });
        setSeedError(null);
      })
      .catch((err) => {
        // A browser-blocked request must not look like "no history yet".
        if (!cancelled) setSeedError(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    setState('connecting');

    source.addEventListener('hello', () => setState('live'));
    source.addEventListener('skipped', (evt) => {
      // The server produced requests faster than the tail could carry them.
      try {
        setSkipped((n) => n + (JSON.parse(evt.data)?.count ?? 0));
      } catch {
        /* ignore a malformed frame */
      }
    });
    source.addEventListener('events', (evt) => {
      let batch;
      try {
        batch = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (!Array.isArray(batch) || !batch.length) return;

      const now = Date.now();
      rateWindow.current.push([now, batch.length]);
      rateWindow.current = rateWindow.current.filter(([t]) => now - t < 10_000);
      setRate(rateWindow.current.reduce((s, [, n]) => s + n, 0) / 10);

      if (pausedRef.current) {
        pausedBuffer.current = pausedBuffer.current.concat(batch).slice(-MAX_LIVE_ROWS);
        setPendingCount(pausedBuffer.current.length);
      } else {
        appendRows(batch);
      }
    });
    source.onopen = () => setState('live');
    source.onerror = () => setState('reconnecting');

    return () => source.close();
  }, [appendRows]);

  // Keep the newest request in view.
  useEffect(() => {
    if (!follow || paused) return;
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, follow, paused]);

  function resume() {
    if (pausedBuffer.current.length) {
      appendRows(pausedBuffer.current);
      pausedBuffer.current = [];
      setPendingCount(0);
    }
    setPaused(false);
  }

  const dot = state === 'live' && !paused ? 'pulsing' : paused ? 'paused' : state === 'live' ? '' : 'down';

  return (
    <div className="panel stream-panel">
      <div className="stream-bar">
        <div className="stream-controls">
          <span className={`live-dot ${dot}`} />
          <span className="stream-state">
            {paused ? 'Paused' : state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
          <button type="button" className="btn sm" onClick={() => (paused ? resume() : setPaused(true))}>
            {paused ? `▶ Resume${pendingCount ? ` (${num(pendingCount)})` : ''}` : '⏸ Pause'}
          </button>
          <button type="button" className="btn sm" onClick={() => setRows([])}>
            Clear
          </button>
          <label className="hstack" style={{ gap: 5, fontSize: 12 }}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
        </div>
        <div className="stream-stats">
          <Chip title="Requests per second across the whole server, averaged over 10s">
            {rate.toFixed(rate < 10 ? 1 : 0)}/s
          </Chip>
          {skipped > 0 && (
            <Chip tone="warn" title="The server logged requests faster than the live view can carry. They are all stored, and statistics are complete.">
              {num(skipped)} not shown
            </Chip>
          )}
          <Chip>{num(rows.length)} shown</Chip>
        </div>
      </div>

      {seedError && (
        <div style={{ padding: '0 12px' }}>
          <Banner level="warn">
            Could not load recent requests: {String(seedError.message)}. If this says "Failed to
            fetch" and the server log is empty, a browser extension or content blocker is
            dropping the request before it leaves the browser.
          </Banner>
        </div>
      )}
      {state === 'reconnecting' && (
        <div style={{ padding: '0 12px' }}>
          <Banner level="warn">
            The stream dropped and is reconnecting. Requests that arrive meanwhile are still
            stored — search for them, or reload.
          </Banner>
        </div>
      )}

      <RequestList
        rows={rows}
        viewRef={viewRef}
        context={{}}
        empty="Waiting for requests… Anything Caddy logs from now on appears here within about a second. Search above to look through stored requests."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Search: stored requests matching the filters
// ---------------------------------------------------------------------------

function SearchResults({ active, chips, onRemove, onReset, retention }) {
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [paging, setPaging] = useState(null);
  const [total, setTotal] = useState(null);
  const [retained, setRetained] = useState(null);
  const [loading, setLoading] = useState(true);
  // While searching further back on its own: how far it has got.
  const [searching, setSearching] = useState(null);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  const page = useCallback(
    (before, withCount) =>
      api.get(`/api/requests${qs({ ...active, limit: PAGE, before, count: withCount ? 1 : undefined })}`),
    [active]
  );

  /**
   * Fetch from `before` (null = the newest) until a page of matches is found,
   * the matching requests run out, or AUTO_ROUNDS round trips have been made,
   * adding rows as they come in.
   */
  const run = useCallback(
    async (before, replace) => {
      const mine = ++reqId.current;
      setError(null);
      if (replace) setLoading(true);
      try {
        let res = await page(before, replace);
        if (reqId.current !== mine) return;
        let found = res.rows ?? [];
        if (replace) {
          setRows(found);
          setTotal(res.total ?? null);
          setRetained({ hours: res.retentionHours, from: res.retainedFrom });
          setLoading(false);
        } else {
          setRows((prev) => prev.concat(found));
        }
        for (let round = 1; round < AUTO_ROUNDS; round++) {
          const partway = res.windowed && !res.pageFull && res.nextCursor !== null;
          if (!partway || found.length >= PAGE) break;
          setSearching(res.searchedBackTo);
          res = await page(res.nextCursor, false);
          if (reqId.current !== mine) return;
          found = found.concat(res.rows ?? []);
          const more = res.rows ?? [];
          setRows((prev) => prev.concat(more));
        }
        setCursor(res.nextCursor ?? null);
        setPaging({ windowed: res.windowed, pageFull: res.pageFull, searchedBackTo: res.searchedBackTo });
      } catch (err) {
        if (reqId.current === mine) setError(err);
      } finally {
        if (reqId.current === mine) {
          setLoading(false);
          setSearching(null);
        }
      }
    },
    [page]
  );

  useEffect(() => {
    setRows([]);
    setCursor(null);
    run(null, true);
    // A newer search, or leaving for live, stops one still searching back.
    return () => {
      reqId.current += 1;
    };
  }, [run]);

  const host = active.host ?? null;
  // Stopped at its time budget rather than at the end of the matches.
  const searchedPartway = paging?.windowed && !paging?.pageFull && cursor !== null;
  const hours = retained?.hours ?? retention?.rawHours ?? null;
  const kept = keptFor(hours);

  return (
    <>
      {chips.length > 0 && (
        <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className="faint" style={{ fontSize: 11.5 }}>Filtering by</span>
          {chips.map(([key, value]) => (
            <button
              key={key}
              type="button"
              className="chip info"
              title={`Remove the ${FILTER_LABELS[key] ?? key} filter`}
              onClick={() => onRemove(key)}
              style={{ maxWidth: 380 }}
            >
              <span className="faint">{FILTER_LABELS[key] ?? key}:</span>
              <span className="truncate" style={{ display: 'inline-block', maxWidth: 260 }}>
                {filterValueLabel(key, value)}
              </span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <Banner level="error">
          Could not load requests
          {error instanceof ApiError && error.status ? ` (HTTP ${error.status})` : ''}:{' '}
          {String(error.message)}
        </Banner>
      )}

      <Banner level="info">
        {kept ? (
          <>Individual requests are kept for <strong>{kept}</strong></>
        ) : (
          <>Individual requests are kept until the database reaches its size limit</>
        )}
        {retained?.from ? <> — the oldest still stored is from {relative(retained.from)}</> : null}.
        Statistics reach much further back; use the <Link to="/domains">domain pages</Link> for
        historical analysis.
      </Banner>

      <Panel
        title="Matching requests"
        flush
        actions={
          <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="hstack" style={{ gap: 5, fontSize: 11.5 }} title="The live stream is paused while you search">
              <span className="live-dot paused" />
              <span className="faint">Live paused</span>
            </span>
            {total ? (
              <Chip title={total.capped ? 'Counting stopped at the cap' : undefined}>
                {total.capped ? `${compact(total.count)}+` : num(total.count)} total
              </Chip>
            ) : null}
            <Chip>{num(rows.length)} shown</Chip>
            {host && (
              <Link className="btn sm" to={`/domains/${encodeURIComponent(host)}`}>
                Domain overview
              </Link>
            )}
            <button type="button" className="btn sm primary" onClick={onReset}>
              ▶ Back to live
            </button>
          </div>
        }
      >
        {loading ? (
          <Loading rows={8} />
        ) : (
          <>
            <RequestList
              rows={rows}
              context={{ host, from: active.from }}
              className="log-view"
              empty={
                searching !== null ? (
                  <>Searching… back to {searching ? relative(searching) : 'older requests'} so far.</>
                ) : searchedPartway ? (
                  <>
                    No matches among requests back to{' '}
                    {paging.searchedBackTo ? relative(paging.searchedBackTo) : 'the searched range'}.
                    Older requests have not been searched yet.
                  </>
                ) : (
                  <>
                    No requests match these filters
                    {active.from || active.to ? ' in this period' : kept ? ` within the last ${kept}` : ''}.
                    {chips.length > 0 && ' Try removing a filter, or go back to live.'}
                  </>
                )
              }
            />
            {searching !== null && rows.length > 0 && (
              <div className="faint" style={{ padding: 12, textAlign: 'center', fontSize: 11.5 }}>
                Searching… back to {searching ? relative(searching) : 'older requests'} so far.
              </div>
            )}
            {searching === null && cursor !== null && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                {searchedPartway && paging.searchedBackTo && rows.length > 0 && (
                  <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
                    Searched back to {relative(paging.searchedBackTo)}.
                  </div>
                )}
                <button className="btn" onClick={() => run(cursor, false)}>
                  {searchedPartway ? 'Search older requests' : `Load ${PAGE} more`}
                </button>
              </div>
            )}
            {searching === null && cursor === null && rows.length > 0 && (
              <div className="empty" style={{ padding: 14 }}>
                End of results.
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
