// The request explorer: any dimension value from anywhere in the app resolves
// here, as a filtered list of the individual requests behind it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, ApiError } from '../lib/api.js';
import { Banner, Chip, Loading, Panel } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { FILTER_KEYS, FILTER_LABELS, filterValueLabel } from '../lib/drill.js';
import { compact, num, relative } from '../lib/format.js';

const PAGE = 100;

export default function Requests({ ctx }) {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const reqId = useRef(0);

  // The filter set is entirely in the URL, so every view is shareable and the
  // back button behaves.
  const active = {};
  for (const key of FILTER_KEYS) {
    const v = params.get(key);
    if (v !== null && v !== '') active[key] = v;
  }
  const query = qs({ ...active, limit: PAGE, count: 1 });

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/api/requests${query}`);
      if (reqId.current !== mine) return;
      setRows(res.rows ?? []);
      setCursor(res.nextCursor ?? null);
      setMeta(res);
    } catch (err) {
      if (reqId.current !== mine) return;
      setError(err);
    } finally {
      if (reqId.current === mine) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get(`/api/requests${qs({ ...active, limit: PAGE, before: cursor })}`);
      setRows((prev) => prev.concat(res.rows ?? []));
      setCursor(res.nextCursor ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  function removeFilter(key) {
    const next = { ...active };
    delete next[key];
    setParams(next, { replace: false });
    if (key === 'q') setSearch('');
  }

  function applySearch(e) {
    e.preventDefault();
    const next = { ...active };
    if (search.trim()) next.q = search.trim();
    else delete next.q;
    setParams(next);
  }

  const chips = Object.entries(active);
  const host = active.host ?? null;

  return (
    <>
      <div className="hstack" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
        <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
          {chips.length === 0 ? (
            <span className="faint">
              No filters — showing the most recent requests. Click any value elsewhere in the app to
              filter here.
            </span>
          ) : (
            chips.map(([key, value]) => (
              <button
                key={key}
                className="chip info"
                title={`Remove the ${FILTER_LABELS[key] ?? key} filter`}
                onClick={() => removeFilter(key)}
                style={{ cursor: 'pointer', maxWidth: 380 }}
              >
                <span className="faint">{FILTER_LABELS[key] ?? key}:</span>
                <span className="truncate" style={{ display: 'inline-block', maxWidth: 260 }}>
                  {filterValueLabel(key, value)}
                </span>
                <span aria-hidden="true">×</span>
              </button>
            ))
          )}
          {chips.length > 1 && (
            <button className="btn sm" onClick={() => setParams({})}>
              Clear all
            </button>
          )}
        </div>

        <form className="hstack" onSubmit={applySearch} style={{ gap: 6 }}>
          <input
            className="input"
            style={{ width: 230 }}
            placeholder="search URL / agent / referrer"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn sm primary" type="submit">
            Search
          </button>
        </form>
      </div>

      {error && (
        <Banner level="error">
          Could not load requests
          {error instanceof ApiError && error.status ? ` (HTTP ${error.status})` : ''}:{' '}
          {String(error.message)}
        </Banner>
      )}

      {meta?.retentionHours && (
        <Banner level="info">
          Individual requests are retained for <strong>{meta.retentionHours} hours</strong>
          {meta.retainedFrom ? (
            <>
              {' '}
              — the oldest still stored is from {relative(meta.retainedFrom)}
            </>
          ) : null}
          . Aggregate statistics reach much further back; use the{' '}
          <Link to="/domains">domain pages</Link> for historical analysis.
        </Banner>
      )}

      <Panel
        title="Matching requests"
        flush
        actions={
          <div className="hstack" style={{ gap: 6 }}>
            {meta?.total && (
              <Chip title={meta.total.capped ? 'Counting stopped at the cap' : undefined}>
                {meta.total.capped ? `${compact(meta.total.count)}+` : num(meta.total.count)} total
              </Chip>
            )}
            <Chip>{num(rows.length)} loaded</Chip>
            {host && (
              <Link className="btn sm" to={`/domains/${encodeURIComponent(host)}`}>
                Domain overview
              </Link>
            )}
            <Link className="btn sm" to={`/logs${qs(active)}`}>
              Watch live
            </Link>
          </div>
        }
      >
        {loading ? (
          <Loading rows={8} />
        ) : (
          <>
            <RequestList
              rows={rows}
              context={{ host, range: ctx?.range }}
              className="log-view"
              empty={
                <>
                  No requests match these filters within the last {meta?.retentionHours ?? '?'} hours.
                  {chips.length > 0 && ' Try removing a filter, or widening to the live stream.'}
                </>
              }
            />
            {cursor && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                <button className="btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load ${PAGE} more`}
                </button>
              </div>
            )}
            {!cursor && rows.length > 0 && (
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
