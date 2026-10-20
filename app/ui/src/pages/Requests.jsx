// Requests: the live log stream and the request explorer in one page.
//
// It streams: new requests appear at the bottom within about a second, with
// the latest stored ones above and older ones a click away. Filters apply to
// the stream as well — domain, address, status, free text and the rest. A
// time range is the one thing a stream cannot honour, so setting one stops
// the stream and lists the stored requests in that period instead, newest
// first; "Back to live" drops the time range, and Reset clears everything.
//
// Any dimension value from anywhere in the app resolves here as a search.
// Filters can also be built directly — with the field row, a time range, or
// key:value terms typed into the search box (host:example.com ua:curl
// status:4xx). The filter set lives entirely in the URL, so every view is a
// shareable link and the back button behaves.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, ApiError } from '../lib/api.js';
import { useApi, useHostOptions, useLocalState } from '../lib/useApi.js';
import { Banner, Chip, Loading, Panel } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { FILTER_KEYS, FILTER_LABELS, filterValueLabel } from '../lib/drill.js';
import { normalizeFilterValue, parseSearch } from '../lib/search.js';
import { compact, keptPhrase, num, relative } from '../lib/format.js';

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
  // A time range is a search of stored requests; anything else streams.
  const live = !active.from && !active.to;

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
          <button className="btn sm primary" type="submit"
                  title="Apply the filters. The stream keeps running, filtered, unless a time range is set">
            Search
          </button>
          <button className="btn sm" type="button" onClick={() => setParams({})}
                  title="Clear every filter and go back to the unfiltered live stream">
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
          <label className="f-time" title="Setting a time range searches stored requests instead of streaming">
            Time
            <select className="input" value="" onChange={since} aria-label="Quick time range">
              <option value="">Pick a period…</option>
              {SINCE.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label className="f-time">
            From
            <input className="input" type="datetime-local" {...field('from')} />
          </label>
          <label className="f-time">
            To
            <input className="input" type="datetime-local" {...field('to')} />
          </label>
        </div>
      </form>

      {chips.length > 0 && (
        <div className="filter-chips hstack" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className="faint" style={{ fontSize: 11.5 }}>Filtering by</span>
          {chips.map(([key, value]) => (
            <button
              key={key}
              type="button"
              className="chip info"
              title={`Remove the ${FILTER_LABELS[key] ?? key} filter`}
              onClick={() => removeFilter(key)}
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

      {live ? (
        // Keyed on the filters: a change starts a fresh stream and history.
        <LiveStream key={paramString} filters={active} />
      ) : (
        <SearchResults
          active={active}
          filtered={chips.length > 0}
          onLive={() => {
            const next = { ...active };
            delete next.from;
            delete next.to;
            setParams(next);
          }}
          retention={retention}
        />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
//  Fetching stored requests
// ---------------------------------------------------------------------------

/**
 * Stored requests matching `filters`, newest first, from `before` (null =
 * the newest). A search stops at a time budget on the server, so a rare match
 * can need several round trips to find `want` of them; they are made without
 * asking, up to AUTO_ROUNDS. `onPage` gets each page as it arrives, so the
 * list fills in rather than waiting; `stillWanted` going false stops the
 * search (a newer one started, or the page left).
 * @returns the last response, whose nextCursor continues the search; or null
 *   when it was abandoned
 */
async function findRequests(filters, { before = null, want = PAGE, count = false, stillWanted, onPage, onProgress }) {
  const get = (b, limit, withCount) =>
    api.get(`/api/requests${qs({ ...filters, limit, before: b, count: withCount ? 1 : undefined })}`);
  let res = await get(before, want, count);
  if (!stillWanted()) return null;
  let found = res.rows?.length ?? 0;
  onPage(res, true);
  for (let round = 1; round < AUTO_ROUNDS; round++) {
    const partway = res.windowed && !res.pageFull && res.nextCursor !== null;
    if (!partway || found >= want) break;
    onProgress?.(res.searchedBackTo);
    res = await get(res.nextCursor, want - found, false);
    if (!stillWanted()) return null;
    found += res.rows?.length ?? 0;
    onPage(res, false);
  }
  return res;
}

// ---------------------------------------------------------------------------
//  Live: the stream of new requests, with the stored ones above
// ---------------------------------------------------------------------------

function LiveStream({ filters }) {
  const filtered = Object.keys(filters).length > 0;
  const [rows, setRows] = useState([]);
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState('connecting');
  const [follow, setFollow] = useLocalState('cli.logs.follow', true);
  const [rate, setRate] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [seedError, setSeedError] = useState(null);
  // Where the stored requests above the stream continue, and whether the
  // last look stopped at its time budget rather than at the end of them.
  const [older, setOlder] = useState({ cursor: null, partway: false, back: null });
  const [loadingOlder, setLoadingOlder] = useState(false);

  // While paused, arriving requests collect here instead of re-rendering the
  // list, so the rows under the cursor never move.
  const pausedBuffer = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [pendingCount, setPendingCount] = useState(0);
  const viewRef = useRef(null);
  const rateWindow = useRef([]);
  const alive = useRef(true);
  // Following only while the newest row is in view: scrolled up to read, the
  // view stays put as requests arrive.
  const atBottom = useRef(true);
  // Distance from the bottom to restore after older rows go in at the top.
  const keepFromBottom = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const appendRows = useCallback((incoming) => {
    setRows((prev) => {
      // The stored history and the stream can overlap (the hub's cursor is
      // shared across tabs), and both are ascending by id — so dropping
      // anything not newer than the last row we hold prevents duplicate keys.
      const lastId = prev.length ? prev[prev.length - 1].id : 0;
      const fresh = incoming.filter((r) => r.id > lastId);
      if (!fresh.length) return prev;
      const next = prev.concat(fresh);
      return next.length > MAX_LIVE_ROWS ? next.slice(next.length - MAX_LIVE_ROWS) : next;
    });
  }, []);

  /** Stored requests older than the oldest shown, put in at the top. */
  const prependOlder = useCallback((batch) => {
    const el = viewRef.current;
    if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
    setRows((prev) => {
      const firstId = prev.length ? prev[0].id : Infinity;
      return batch.filter((r) => r.id < firstId).reverse().concat(prev);
    });
  }, []);

  // The latest stored requests, so the view is never empty on arrival.
  useEffect(() => {
    const collected = [];
    findRequests(filters, {
      want: 200,
      stillWanted: () => alive.current,
      onPage: (res) => collected.push(...(res.rows ?? [])),
    })
      .then((res) => {
        if (!res) return;
        // Anything the stream delivered meanwhile is newer: keep it after.
        const seed = collected.slice().reverse();
        setRows((streamed) => {
          const lastSeed = seed.length ? seed[seed.length - 1].id : 0;
          return seed.concat(streamed.filter((r) => r.id > lastSeed));
        });
        setOlder({ cursor: res.nextCursor ?? null, partway: Boolean(res.windowed && !res.pageFull), back: res.searchedBackTo });
        setSeedError(null);
      })
      .catch((err) => {
        // A browser-blocked request must not look like "no history yet".
        if (alive.current) setSeedError(err);
      });
  }, [filters]);

  async function loadOlder() {
    if (older.cursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await findRequests(filters, {
        before: older.cursor,
        stillWanted: () => alive.current,
        onPage: (page) => prependOlder(page.rows ?? []),
      });
      if (res) setOlder({ cursor: res.nextCursor ?? null, partway: Boolean(res.windowed && !res.pageFull), back: res.searchedBackTo });
    } catch (err) {
      if (alive.current) setSeedError(err);
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  }

  useEffect(() => {
    // The server applies the filters (makeFilter in web/stream.js).
    const source = new EventSource(`/api/stream${qs(filters)}`);
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
  }, [filters, appendRows]);

  // Track whether the newest row is in view.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      // Older rows went in above: keep the same rows under the reader's eye.
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (follow && !paused && atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
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
  const stateLabel = paused
    ? 'Paused'
    : state === 'live'
      ? filtered ? 'Live, filtered' : 'Live'
      : state === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  const olderBar = older.cursor !== null && (
    <div style={{ padding: 8, textAlign: 'center' }}>
      <button type="button" className="btn sm" onClick={loadOlder} disabled={loadingOlder}>
        {loadingOlder ? 'Searching…' : older.partway ? 'Search older requests' : 'Load older requests'}
      </button>
      {older.partway && older.back && (
        <span className="faint" style={{ fontSize: 11.5, marginLeft: 8 }}>
          searched back to {relative(older.back)}
        </span>
      )}
    </div>
  );

  return (
    <div className="panel stream-panel">
      <div className="stream-bar">
        <div className="stream-controls">
          <span className={`live-dot ${dot}`} />
          <span className="stream-state">{stateLabel}</span>
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
          <Chip title={filtered
            ? 'Matching requests per second, averaged over 10s'
            : 'Requests per second across the whole server, averaged over 10s'}>
            {rate.toFixed(rate < 10 ? 1 : 0)}/s{filtered ? ' matching' : ''}
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
            Could not load stored requests: {String(seedError.message)}. If this says "Failed to
            fetch" and the server log is empty, a browser extension or content blocker is
            dropping the request before it leaves the browser.
          </Banner>
        </div>
      )}
      {state === 'reconnecting' && (
        <div style={{ padding: '0 12px' }}>
          <Banner level="warn">
            The stream dropped and is reconnecting. Requests that arrive meanwhile are still
            stored — load them from above, or reload.
          </Banner>
        </div>
      )}

      <RequestList
        rows={rows}
        viewRef={viewRef}
        before={olderBar}
        context={{ host: filters.host ?? null }}
        empty={filtered
          ? 'No stored requests match these filters, and none have arrived since. Matching requests appear here within about a second.'
          : 'Waiting for requests… Anything Caddy logs from now on appears here within about a second.'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Search: stored requests in a time range
// ---------------------------------------------------------------------------

function SearchResults({ active, filtered, onLive, retention }) {
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

  const run = useCallback(
    async (before, replace) => {
      const mine = ++reqId.current;
      setError(null);
      if (replace) setLoading(true);
      try {
        const res = await findRequests(active, {
          before,
          count: replace,
          stillWanted: () => reqId.current === mine,
          onProgress: (back) => setSearching(back),
          onPage: (page, first) => {
            if (first && replace) {
              setRows(page.rows ?? []);
              setTotal(page.total ?? null);
              setRetained({ hours: page.retentionHours, maxDbSizeMb: page.maxDbSizeMb, from: page.retainedFrom });
              setLoading(false);
            } else {
              const more = page.rows ?? [];
              setRows((prev) => prev.concat(more));
            }
          },
        });
        if (!res) return;
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
    [active]
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
  const kept = keptPhrase({
    hours: retained ? retained.hours : retention?.rawHours,
    maxDbSizeMb: retained ? retained.maxDbSizeMb : retention?.maxDbSizeMb,
  });

  return (
    <>
      {error && (
        <Banner level="error">
          Could not load requests
          {error instanceof ApiError && error.status ? ` (HTTP ${error.status})` : ''}:{' '}
          {String(error.message)}
        </Banner>
      )}

      <Banner level="info">
        Individual requests are kept {kept}
        {retained?.from ? <> — the oldest still stored is from {relative(retained.from)}</> : null}.
        Statistics reach much further back; use the <Link to="/domains">domain pages</Link> for
        historical analysis.
      </Banner>

      <Panel
        title="Requests in this period"
        flush
        actions={
          <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="hstack" style={{ gap: 5, fontSize: 11.5 }} title="The live stream is paused while a time range is set">
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
            <button type="button" className="btn sm primary" onClick={onLive}
                    title={filtered ? 'Drop the time range and stream, keeping the other filters' : 'Stream new requests'}>
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
                    Older requests in this period have not been searched yet.
                  </>
                ) : (
                  <>No stored requests match these filters in this period.</>
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
