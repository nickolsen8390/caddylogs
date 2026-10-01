import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { Banner, Empty, Loading, Panel } from '../components/ui.jsx';
import { TimeRange } from '../components/TimeRange.jsx';
import { bytes, compact, dateTime, ms, num, pct, relative } from '../lib/format.js';

const COLUMNS = [
  { id: 'host', label: 'Domain', num: false },
  { id: 'requests', label: 'Requests', num: true },
  { id: 'share', label: 'Share', num: true },
  { id: 'bytes_out', label: 'Sent', num: true },
  { id: 'bytes_in', label: 'Received', num: true },
  { id: 'success', label: '2xx/3xx', num: true },
  { id: 'errors', label: '4xx/5xx', num: true },
  { id: 'c5xx', label: '5xx', num: true },
  { id: 'avg_ms', label: 'Mean', num: true },
  { id: 'bots', label: 'Bots', num: true },
  { id: 'last_seen', label: 'Last request', num: true },
];

export default function Domains({ ctx }) {
  const { range, setRange, onUnauthorized } = ctx;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'requests', dir: 'desc' });
  const meta = useApi('/api/meta', { refreshMs: 120_000, onUnauthorized });
  const { data, loading, error } = useApi(`/api/domains${qs({ range })}`, {
    refreshMs: 60_000,
    onUnauthorized,
  });

  const rows = useMemo(() => {
    let list = data?.rows ?? [];
    const grand = list.reduce((s, r) => s + r.requests, 0) || 1;
    list = list.map((r) => ({
      ...r,
      share: r.requests / grand,
      success: r.c2xx + r.c3xx,
    }));
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      list = list.filter((r) => r.host.includes(needle));
    }
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'string') return av.localeCompare(bv) * mul;
      return ((av ?? 0) - (bv ?? 0)) * mul;
    });
  }, [data, search, sort]);

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="hstack">
          <TimeRange value={range} onChange={setRange} retentionDays={meta.data?.retention?.days} />
          {loading && <span className="spinner" />}
        </div>
        <input
          className="input"
          placeholder="Filter domains…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
      </div>

      {error && <Banner level="error">Could not load domains: {String(error.message)}</Banner>}

      <Panel
        title={`Domains served${rows.length ? ` · ${num(rows.length)}` : ''}`}
        flush
        actions={
          <span className="faint" style={{ fontSize: 11.5 }}>
            Every host that received a request Caddy actually served
          </span>
        }
      >
        {!data ? (
          <Loading rows={6} />
        ) : !rows.length ? (
          <Empty>
            {search ? 'No domains match that filter.' : 'No domains have received traffic in this period.'}
          </Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.id}
                      className={`sortable${c.num ? ' num' : ''}${c.id === 'host' ? ' cell-sticky' : ''}`}
                      onClick={() => toggleSort(c.id)}
                    >
                      {c.label}
                      {sort.key === c.id ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.host}>
                    {/* On phones the host name is shown whole and pinned while
                        the numbers scroll sideways (styles.css, "phones"). */}
                    <td className="cell-sticky cell-full">
                      <Link to={`/domains/${encodeURIComponent(r.host)}`} className="truncate" title={r.host}>
                        {r.host}
                      </Link>
                    </td>
                    <td className="num">{num(r.requests)}</td>
                    <td className="num dim">{pct(r.share, 1)}</td>
                    <td className="num">{bytes(r.bytes_out)}</td>
                    <td className="num dim">{bytes(r.bytes_in)}</td>
                    <td className="num" style={{ color: 'var(--green)' }}>{compact(r.success)}</td>
                    <td className="num" style={{ color: r.errors ? 'var(--amber)' : undefined }}>
                      {compact(r.errors)}
                    </td>
                    <td className="num" style={{ color: r.c5xx ? 'var(--red)' : undefined }}>
                      {compact(r.c5xx)}
                    </td>
                    <td className="num">{ms(r.avg_ms)}</td>
                    <td className="num dim">{compact(r.bots)}</td>
                    <td className="num dim" title={dateTime(r.last_seen)}>
                      {relative(r.last_seen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
