import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useLocalState } from '../lib/useApi.js';
import { Banner, Chip } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { num } from '../lib/format.js';

const MAX_ROWS = 3000;

export default function LogStream() {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    host: params.get('host') ?? '',
    ip: params.get('ip') ?? '',
    status: params.get('status') ?? '',
    method: params.get('method') ?? '',
    bots: params.get('bots') ?? '',
    q: params.get('q') ?? '',
  }));
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState([]);
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState('connecting');
  const [follow, setFollow] = useLocalState('cli.logs.follow', true);
  const [rate, setRate] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [seedError, setSeedError] = useState(null);
  // Phones only: the filter inputs fold away so the log keeps the screen.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = Object.values(applied).filter(Boolean).length;

  // While paused, arriving events collect here instead of re-rendering the
  // list, so the rows under the cursor never move.
  const pausedBuffer = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [pendingCount, setPendingCount] = useState(0);
  const viewRef = useRef(null);
  const rateWindow = useRef([]);

  const query = useMemo(() => qs(applied), [applied]);

  const appendRows = useCallback((incoming) => {
    setRows((prev) => {
      // The seeded history and the stream can overlap (the hub's cursor is
      // shared across tabs), and both are ascending by id — so dropping
      // anything not newer than the last row we hold prevents duplicate keys.
      const lastId = prev.length ? prev[prev.length - 1].id : 0;
      const fresh = incoming.filter((r) => r.id > lastId);
      if (!fresh.length) return prev;
      const next = prev.concat(fresh);
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
    });
  }, []);

  // --- seed with recent history so the view is never empty on arrival ------
  useEffect(() => {
    let cancelled = false;
    setRows([]);
    pausedBuffer.current = [];
    setPendingCount(0);
    api
      .get(`/api/requests${qs({ ...applied, limit: 200 })}`)
      .then((res) => {
        if (!cancelled) {
          setRows((res?.rows ?? []).slice().reverse());
          setSeedError(null);
        }
      })
      .catch((err) => {
        // Previously swallowed. Hiding this meant a browser-blocked request
        // looked like "no history yet" instead of a fault worth reporting.
        if (!cancelled) setSeedError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  // --- live connection -----------------------------------------------------
  useEffect(() => {
    const source = new EventSource(`/api/stream${query}`);
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
      const total = rateWindow.current.reduce((s, [, n]) => s + n, 0);
      setRate(total / 10);

      if (pausedRef.current) {
        pausedBuffer.current = pausedBuffer.current.concat(batch).slice(-MAX_ROWS);
        setPendingCount(pausedBuffer.current.length);
      } else {
        appendRows(batch);
      }
    });
    source.onopen = () => setState('live');
    source.onerror = () => setState('reconnecting');

    return () => source.close();
  }, [query, appendRows]);

  // --- autoscroll ----------------------------------------------------------
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

  function applyFilters(e) {
    e?.preventDefault();
    setApplied(filters);
    setFiltersOpen(false);
    const next = {};
    for (const [k, v] of Object.entries(filters)) if (v) next[k] = v;
    setParams(next, { replace: true });
  }

  function clearAll() {
    const blank = { host: '', ip: '', status: '', method: '', bots: '', q: '' };
    setFilters(blank);
    setApplied(blank);
    setParams({}, { replace: true });
  }

  const dot =
    state === 'live' && !paused ? 'pulsing' : paused ? 'paused' : state === 'live' ? '' : 'down';

  return (
    <div className="panel stream-panel">
      <form className="stream-bar" onSubmit={applyFilters}>
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
          <button
            type="button"
            className={`btn sm mobile-only${activeFilters ? ' primary' : ''}`}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            Filters{activeFilters ? ` (${activeFilters})` : ''} {filtersOpen ? '▴' : '▾'}
          </button>
        </div>

        <div className={`stream-filters${filtersOpen ? ' open' : ''}`}>
          <input className="input f-host" placeholder="host"
                 value={filters.host} onChange={(e) => setFilters({ ...filters, host: e.target.value })} />
          <input className="input f-ip" placeholder="source IP"
                 value={filters.ip} onChange={(e) => setFilters({ ...filters, ip: e.target.value })} />
          <input className="input f-status" placeholder="status"
                 value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                 title="Exact code (404) or class (4xx)" />
          <select className="input f-method" value={filters.method}
                  onChange={(e) => setFilters({ ...filters, method: e.target.value })}>
            <option value="">Any method</option>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select className="input f-bots" value={filters.bots}
                  onChange={(e) => setFilters({ ...filters, bots: e.target.value })}>
            <option value="">Bots &amp; humans</option>
            <option value="exclude">Humans only</option>
            <option value="only">Bots only</option>
          </select>
          <input className="input f-q" placeholder="search path / UA / referrer"
                 value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          <span className="stream-filter-actions">
            <button className="btn primary sm" type="submit">Apply</button>
            <button className="btn sm" type="button" onClick={clearAll}>Reset</button>
          </span>
        </div>

        <div className="stream-stats">
          <Chip title="Requests per second across the whole server, averaged over 10s">
            {rate.toFixed(rate < 10 ? 1 : 0)}/s
          </Chip>
          {skipped > 0 && (
            <Chip tone="warn" title="The server logged requests faster than the live tail can carry. Aggregate statistics are still complete.">
              {num(skipped)} not shown
            </Chip>
          )}
          <Chip>{num(rows.length)} shown</Chip>
        </div>
      </form>

      {seedError && (
        <div style={{ padding: '0 12px' }}>
          <Banner level="warn">
            Could not load recent history: {String(seedError.message)}. If this says "Failed to
            fetch" and the server log is empty, a browser extension or content blocker is
            dropping the request before it leaves the browser.
          </Banner>
        </div>
      )}

      {state === 'reconnecting' && (
        <div style={{ padding: '0 12px' }}>
          <Banner level="warn">
            The stream dropped and is reconnecting. Events that arrive while disconnected are still
            recorded — reload to see them.
          </Banner>
        </div>
      )}

      <RequestList
        rows={rows}
        viewRef={viewRef}
        context={{ host: applied.host || null }}
        empty="Waiting for requests… Anything Caddy logs from now on appears here within about a second."
      />
    </div>
  );
}
