// The request explorer: any dimension value from anywhere in the app resolves
// here, as a filtered list of the individual requests behind it. Filters can
// also be built directly — with the field row, or typed into the search box as
// key:value terms (host:example.com ua:curl status:4xx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, ApiError } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Banner, Chip, Loading, Panel } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { FILTER_KEYS, FILTER_LABELS, filterValueLabel } from '../lib/drill.js';
import { normalizeFilterValue, parseSearch } from '../lib/search.js';
import { compact, num, relative } from '../lib/format.js';

const PAGE = 100;

/** Filters edited through the field row. Anything else stays a removable chip. */
const BAR_KEYS = ['host', 'ip', 'status', 'method', 'pathq', 'uaq', 'country', 'asn', 'bots'];
/** What the live stream understands, for the "Watch live" hand-off. */
const LIVE_KEYS = ['host', 'ip', 'status', 'method', 'bots', 'q'];
const EMPTY_DRAFT = Object.fromEntries(BAR_KEYS.map((k) => [k, '']));

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

export default function Requests({ ctx }) {
  const [params, setParams] = useSearchParams();
  const paramString = params.toString();

  // The filter set lives entirely in the URL: every view is a shareable link,
  // and the back button behaves.
  const active = useMemo(() => {
    const out = {};
    const p = new URLSearchParams(paramString);
    for (const key of FILTER_KEYS) {
      const v = p.get(key);
      if (v !== null && v !== '') out[key] = v;
    }
    return out;
  }, [paramString]);

  // Editable copies of the filters. They follow the URL, so arriving by a
  // drill-down link, removing a chip or pressing back all update the fields.
  const [draft, setDraft] = useState(() => ({ ...EMPTY_DRAFT, ...pick(active, BAR_KEYS) }));
  const [search, setSearch] = useState(active.q ?? '');
  // Phones only: the field filters fold away behind a button.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const barFilters = BAR_KEYS.filter((k) => active[k]).length;
  useEffect(() => {
    setDraft({ ...EMPTY_DRAFT, ...pick(active, BAR_KEYS) });
    setSearch(active.q ?? '');
  }, [active]);

  const domains = useApi('/api/domains?range=7d', { onUnauthorized: ctx?.onUnauthorized });
  const hostOptions = useMemo(() => {
    const list = (domains.data?.rows ?? []).map((r) => r.host).sort();
    if (active.host && !list.includes(active.host)) list.unshift(active.host);
    return list;
  }, [domains.data, active.host]);

  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [paging, setPaging] = useState(null);
  const [total, setTotal] = useState(null);
  const [retention, setRetention] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

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
      setPaging({ windowed: res.windowed, pageFull: res.pageFull, searchedBackTo: res.searchedBackTo });
      setTotal(res.total ?? null);
      setRetention({ hours: res.retentionHours, from: res.retainedFrom });
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
      setPaging({ windowed: res.windowed, pageFull: res.pageFull, searchedBackTo: res.searchedBackTo });
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

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

  const chips = Object.entries(active);
  const host = active.host ?? null;
  // Stopped at its time budget rather than at the end of the data.
  const searchedPartway = paging?.windowed && !paging?.pageFull && cursor !== null;

  return (
    <>
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
          <button className="btn sm primary" type="submit">Search</button>
          <button className="btn sm" type="button" onClick={() => setParams({})}>Reset</button>
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
        </div>
      </form>

      {chips.length > 0 && (
        <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
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

      {error && (
        <Banner level="error">
          Could not load requests
          {error instanceof ApiError && error.status ? ` (HTTP ${error.status})` : ''}:{' '}
          {String(error.message)}
        </Banner>
      )}

      {retention?.hours && (
        <Banner level="info">
          Individual requests are retained for <strong>{retention.hours} hours</strong>
          {retention.from ? <> — the oldest still stored is from {relative(retention.from)}</> : null}.
          Aggregate statistics reach much further back; use the{' '}
          <Link to="/domains">domain pages</Link> for historical analysis.
        </Banner>
      )}

      <Panel
        title="Matching requests"
        flush
        actions={
          <div className="hstack" style={{ gap: 6 }}>
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
            <Link className="btn sm" to={`/logs${qs(pick(active, LIVE_KEYS))}`}>
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
                searchedPartway ? (
                  <>
                    No matches among requests back to{' '}
                    {paging.searchedBackTo ? relative(paging.searchedBackTo) : 'the searched range'}.
                    Older requests have not been searched yet.
                  </>
                ) : (
                  <>
                    No requests match these filters within the last {retention?.hours ?? '?'} hours.
                    {chips.length > 0 && ' Try removing a filter, or widening to the live stream.'}
                  </>
                )
              }
            />
            {cursor !== null && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                {searchedPartway && paging.searchedBackTo && rows.length > 0 && (
                  <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
                    Searched back to {relative(paging.searchedBackTo)}.
                  </div>
                )}
                <button className="btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore
                    ? 'Searching…'
                    : searchedPartway
                      ? 'Search older requests'
                      : `Load ${PAGE} more`}
                </button>
              </div>
            )}
            {cursor === null && rows.length > 0 && (
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
