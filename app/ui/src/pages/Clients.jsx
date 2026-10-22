// Clients: every source address with traffic in the period, as the Domains
// page lists hosts. Sorted and paged by the server — a busy site has tens of
// thousands of addresses.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useApi, useHostOptions } from '../lib/useApi.js';
import { Banner, Empty, Loading, Panel } from '../components/ui.jsx';
import { TimeRange } from '../components/TimeRange.jsx';
import { countryName, flag } from '../lib/countries.js';
import { bytes, compact, dateTime, ms, num, pct, relative } from '../lib/format.js';

const PAGE = 100;

const COLUMNS = [
  { id: 'ip', label: 'Address', num: false },
  { id: 'country', label: 'Country', num: false },
  { id: 'network', label: 'Network', num: false },
  { id: 'requests', label: 'Requests', num: true },
  { id: 'share', label: 'Share', num: true, sort: 'requests' },
  { id: 'bytes', label: 'Sent', num: true },
  { id: 'errors', label: '4xx/5xx', num: true },
  { id: 'error_rate', label: 'Error rate', num: true },
  { id: 'avg_ms', label: 'Mean', num: true },
  { id: 'first_seen', label: 'First seen', num: true },
  { id: 'last_seen', label: 'Last seen', num: true },
];
// Text columns read best A→Z; numbers biggest first.
const ASC_FIRST = new Set(['ip', 'country', 'network']);

export default function Clients({ ctx }) {
  const { range, setRange, onUnauthorized } = ctx;
  const [params, setParams] = useSearchParams();
  const host = params.get('host') || '';
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [applied, setApplied] = useState(search);
  const [sort, setSort] = useState({ key: 'requests', dir: 'desc' });
  const [extra, setExtra] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);

  // Searching as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setApplied(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const meta = useApi('/api/meta', { refreshMs: 120_000, onUnauthorized });
  const hostOptions = useHostOptions(host, { range, onUnauthorized });
  const query = useMemo(
    () => ({ range, host: host || undefined, sort: sort.key, dir: sort.dir, search: applied || undefined }),
    [range, host, sort, applied]
  );
  const { data, loading, error } = useApi(`/api/clients${qs({ ...query, limit: PAGE })}`, {
    refreshMs: 60_000,
    onUnauthorized,
  });
  // Pages beyond the first, dropped whenever the list changes underneath them.
  useEffect(() => setExtra([]), [query]);

  const rows = useMemo(() => (data?.rows ?? []).concat(extra), [data, extra]);
  const grand = data?.totalRequests || 1;
  const more = data ? data.matching - rows.length : 0;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await api.get(`/api/clients${qs({ ...query, limit: PAGE, offset: rows.length })}`);
      setExtra((prev) => prev.concat(res.rows ?? []));
    } finally {
      setLoadingMore(false);
    }
  }

  const toggleSort = (col) => {
    const key = col.sort ?? col.id;
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 'desc' ? 'asc' : 'desc') : ASC_FIRST.has(key) ? 'asc' : 'desc',
    }));
  };

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="hstack" style={{ flexWrap: 'wrap' }}>
          <TimeRange value={range} onChange={setRange} retentionDays={meta.data?.retention?.days} />
          <select
            className="input"
            aria-label="Domain"
            value={host}
            onChange={(e) => setParams(e.target.value ? { host: e.target.value } : {})}
            style={{ width: 'auto', maxWidth: '100%' }}
          >
            <option value="">All domains</option>
            {hostOptions.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          {loading && <span className="spinner" />}
        </div>
        <input
          className="input"
          placeholder="Address, network, ASN or country…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260, maxWidth: '100%' }}
        />
      </div>

      {error && <Banner level="error">Could not load clients: {String(error.message)}</Banner>}

      <Panel
        title={`Clients${data ? ` · ${num(data.matching)}` : ''}`}
        flush
        actions={
          <span className="faint" style={{ fontSize: 11.5 }}>
            Every source address with traffic in this period{host ? ` to ${host}` : ''}
          </span>
        }
      >
        {!data ? (
          <Loading rows={6} />
        ) : !rows.length ? (
          <Empty>
            {applied ? 'No addresses match that search.' : 'No traffic in this period.'}
          </Empty>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => {
                      const key = c.sort ?? c.id;
                      return (
                        <th
                          key={c.id}
                          className={`sortable${c.num ? ' num' : ''}${c.id === 'ip' ? ' cell-sticky' : ''}`}
                          onClick={() => toggleSort(c)}
                        >
                          {c.label}
                          {sort.key === key && c.id !== 'share' ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ip}>
                      <td className="cell-sticky cell-full">
                        <Link to={`/ip/${encodeURIComponent(r.ip)}${qs({ host: host || undefined, range })}`}
                              className="mono truncate" title={r.ip}>
                          {r.ip}
                        </Link>
                      </td>
                      <td>
                        {r.country ? (
                          <span title={r.country_name ?? countryName(r.country)}>
                            {flag(r.country)} {r.country}
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="truncate" style={{ maxWidth: 260 }} title={r.as_org ?? r.as_name ?? ''}>
                        {r.as_org || r.as_name ? (
                          <>
                            {r.as_org ?? r.as_name}
                            {r.asn ? <span className="faint mono" style={{ fontSize: 11 }}> AS{r.asn}</span> : null}
                          </>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="num">{num(r.requests)}</td>
                      <td className="num dim">{pct(r.requests / grand, 1)}</td>
                      <td className="num">{bytes(r.bytes)}</td>
                      <td className="num" style={{ color: r.errors ? 'var(--amber)' : undefined }}>
                        {compact(r.errors)}
                      </td>
                      <td className="num dim">{r.requests ? pct(r.errors / r.requests, 0) : '—'}</td>
                      <td className="num">{ms(r.avg_ms)}</td>
                      <td className="num dim" title={dateTime(r.first_seen)}>{relative(r.first_seen)}</td>
                      <td className="num dim" title={dateTime(r.last_seen)}>{relative(r.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hstack" style={{ padding: 12, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span className="faint" style={{ fontSize: 11.5 }}>
                Showing {num(rows.length)} of {num(data.matching)}. First and last seen are to the hour.
                {data.folded > 0 &&
                  ` ${compact(data.folded)} requests from rarely seen addresses were merged into one row by storage trimming and are not listed.`}
              </span>
              {more > 0 && (
                <button type="button" className="btn sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Show ${num(Math.min(PAGE, more))} more`}
                </button>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
