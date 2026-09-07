import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { Banner, Chip, Empty, Loading, Panel, Stat, StatusStrip, Tabs, TopList } from '../components/ui.jsx';
import { BandwidthChart, CategoryBars, LatencyHistogram, LatencyTrend, TrafficChart, statusColor } from '../components/Charts.jsx';
import { WorldMap } from '../components/WorldMap.jsx';
import { AsnTable } from '../components/AsnTable.jsx';
import { TimeRange } from '../components/TimeRange.jsx';
import { countryName, flag } from '../lib/countries.js';
import { bytes, compact, dateTime, ms, num, pct } from '../lib/format.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'content', label: 'Content' },
  { id: 'clients', label: 'Clients' },
  { id: 'geography', label: 'Geography' },
  { id: 'agents', label: 'User agents' },
  { id: 'performance', label: 'Performance' },
  { id: 'protocol', label: 'Protocol & TLS' },
  { id: 'errors', label: 'Errors' },
];

export default function DomainDetail({ ctx }) {
  const { host } = useParams();
  const { range, setRange, onUnauthorized } = ctx;
  const [tab, setTab] = useState('overview');
  const meta = useApi('/api/meta', { refreshMs: 120_000, onUnauthorized });
  const { data, loading, error } = useApi(
    `/api/domains/${encodeURIComponent(host)}${qs({ range })}`,
    { refreshMs: 45_000, onUnauthorized }
  );

  if (error) {
    return (
      <Banner level="error">
        {error.code === 'unknown_host'
          ? `No data recorded for ${host}.`
          : `Could not load this domain: ${String(error.message)}`}{' '}
        <Link to="/domains">Back to domains</Link>
      </Banner>
    );
  }
  if (!data) return <Panel><Loading rows={6} /></Panel>;

  const t = data.totals;
  const p = data.previous;
  const d = data.dims;
  // Carried into every drill-down link so the filter keeps this domain.
  const dctx = { host, range };

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="hstack">
          <Link to="/domains" className="btn sm">← Domains</Link>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 640 }}>{host}</h2>
          {loading && <span className="spinner" />}
        </div>
        <TimeRange value={range} onChange={setRange} retentionDays={meta.data?.retention?.days} />
      </div>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Requests" value={compact(t.requests)} current={t.requests} previous={p?.requests}
              sub={num(t.requests)} />
        <Stat label="Success rate" value={pct(t.success_rate)} current={t.success_rate}
              previous={p?.success_rate}
              tone={t.success_rate > 0.95 ? 'green' : t.success_rate > 0.85 ? 'amber' : 'red'}
              sub={`${compact(t.c4xx + t.c5xx)} failed`} />
        <Stat label="Unique clients" value={compact(t.unique_ips)} current={t.unique_ips}
              previous={p?.unique_ips} sub="distinct source IPs" />
        <Stat label="Sent" value={bytes(t.bytes_out)} current={t.bytes_out} previous={p?.bytes_out}
              sub={`${bytes(t.bytes_in)} received`} />
        <Stat label="Mean response" value={ms(t.avg_ms)} current={t.avg_ms} previous={p?.avg_ms}
              inverted sub={`p95 ${ms(data.latency?.p95)} · max ${ms(t.dur_max)}`} />
        <Stat label="Bot traffic" value={pct(t.requests ? t.bots / t.requests : 0)}
              sub={`${compact(t.bots)} requests`} />
      </div>

      <Panel flush className="" style={{ marginBottom: 14 }}>
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
        <div style={{ padding: 14 }}>
          {tab === 'overview' && (
            <div className="vstack" style={{ gap: 14 }}>
              <TrafficChart series={data.series} height={250} />
              <div className="grid cols-2">
                <Panel title="Response mix"><StatusStrip totals={t} /></Panel>
                <Panel title="Status codes" flush>
                  <CategoryBars rows={d.status.slice(0, 8)} colorFor={statusColor} height={180} />
                </Panel>
              </div>
              <div className="grid cols-3">
                <Panel title="Top URLs" flush><TopList rows={d.path.slice(0, 12)} dim="path" context={dctx} /></Panel>
                <Panel title="Top clients" flush>
                  <TopList rows={d.ip.slice(0, 12)} render={(r) => (
                             <Link to={`/ip/${encodeURIComponent(r.value)}${qs({ host })}`} className="mono">
                               {r.value}
                             </Link>
                           )} />
                </Panel>
                <Panel title="Referrers" flush><TopList rows={d.referer.slice(0, 12)} dim="referer" context={dctx} /></Panel>
              </div>
            </div>
          )}

          {tab === 'content' && (
            <div className="grid cols-2">
              <Panel title="Requested URLs" flush>
                <TopList rows={d.path} dim="path" context={dctx} />
              </Panel>
              <div className="vstack" style={{ gap: 14 }}>
                <Panel title="Bandwidth by URL" flush>
                  <TopList rows={[...d.path].sort((a, b) => b.bytes - a.bytes).slice(0, 15)}
                           valueKey="bytes" format={bytes} />
                </Panel>
                <Panel title="File types" flush><TopList rows={d.ext} dim="ext" context={dctx} /></Panel>
                <Panel title="Methods" flush><TopList rows={d.method} dim="method" context={dctx} /></Panel>
              </div>
            </div>
          )}

          {tab === 'clients' && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="grid cols-2">
                <Panel title="Top talkers" flush
                       actions={<span className="faint" style={{ fontSize: 11 }}>by request count</span>}>
                  <TopList rows={d.ip} render={(r) => (
                             <Link to={`/ip/${encodeURIComponent(r.value)}${qs({ host })}`} className="mono">
                               {r.value}
                             </Link>
                           )} />
                </Panel>
                <Panel title="Heaviest clients" flush
                       actions={<span className="faint" style={{ fontSize: 11 }}>by bytes served</span>}>
                  <TopList rows={[...d.ip].sort((a, b) => b.bytes - a.bytes)}
                           valueKey="bytes" format={bytes}
                           render={(r) => (
                             <Link to={`/ip/${encodeURIComponent(r.value)}${qs({ host })}`} className="mono">
                               {r.value}
                             </Link>
                           )} />
                </Panel>
              </div>
              <Panel
                title="Networks (ASN)"
                flush
                actions={
                  <span className="faint" style={{ fontSize: 11 }}>
                    Registry data from notoolkit.com. Country is where the AS is registered,
                    not where the traffic came from.
                  </span>
                }
              >
                <AsnTable rows={data.asns} host={host} range={range} />
              </Panel>
            </div>
          )}

          {tab === 'geography' && (
            <div className="vstack" style={{ gap: 14 }}>
              <Panel title="Request origins"><WorldMap rows={data.countries} /></Panel>
              <Panel title="All countries" flush>
                {data.countries?.length ? (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Country</th>
                        <th className="num">Requests</th>
                        <th className="num">Share</th>
                        <th className="num">Bytes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const total = data.countries.reduce((s, c) => s + c.requests, 0) || 1;
                        return data.countries.map((c) => (
                          <tr key={c.country}>
                            <td className="cell-wide">
                              <Link to={`/requests${qs({ country: c.country, host })}`}>
                                {flag(c.country)} {countryName(c.country)}
                              </Link>{' '}
                              <span className="faint mono">{c.country}</span>
                            </td>
                            <td className="num">{num(c.requests)}</td>
                            <td className="num dim">{pct(c.requests / total)}</td>
                            <td className="num">{bytes(c.bytes)}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                ) : (
                  <Empty>No country data. Check that the GeoLite2 database is mounted.</Empty>
                )}
              </Panel>
            </div>
          )}

          {tab === 'agents' && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="grid cols-3">
                <Panel title="Browsers" flush><TopList rows={d.browser} dim="browser" context={dctx} /></Panel>
                <Panel title="Operating systems" flush><TopList rows={d.os} dim="os" context={dctx} /></Panel>
                <Panel title="Device class" flush><TopList rows={d.device} dim="device" context={dctx} /></Panel>
              </div>
              <Panel title="Raw user agents" flush>
                <TopList
                  rows={d.ua}
                  render={(r) => (
                    <Link to={`/requests${qs({ ua: r.value, host })}`} className="mono" title={r.value}>
                      {r.value}
                    </Link>
                  )}
                />
              </Panel>
              <Panel title="Human vs bot" flush><TopList rows={d.kind} dim="kind" context={dctx} /></Panel>
            </div>
          )}

          {tab === 'performance' && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="hstack">
                {['p50', 'p75', 'p90', 'p95', 'p99'].map((k) => (
                  <Chip key={k} tone={k === 'p99' ? 'bad' : k === 'p95' ? 'warn' : undefined}>
                    {k} {ms(data.latency?.[k])}
                  </Chip>
                ))}
                <Chip>max {ms(t.dur_max)}</Chip>
              </div>
              <Panel title="Latency distribution">
                <LatencyHistogram latency={data.latency} height={220} />
              </Panel>
              <div className="grid cols-2">
                <Panel title="Mean response time"><LatencyTrend series={data.series} height={200} /></Panel>
                <Panel title="Bandwidth"><BandwidthChart series={data.series} height={200} /></Panel>
              </div>
              <Panel title="Slowest URLs" flush
                     actions={<span className="faint" style={{ fontSize: 11 }}>mean response time</span>}>
                <TopList
                  rows={[...d.path].sort((a, b) => b.avg_ms - a.avg_ms).slice(0, 15)}
                  valueKey="avg_ms"
                  format={ms}
                />
              </Panel>
            </div>
          )}

          {tab === 'protocol' && (
            <div className="grid cols-3">
              <Panel title="HTTP protocol" flush><TopList rows={d.proto} dim="proto" context={dctx} /></Panel>
              <Panel title="TLS version" flush><TopList rows={d.tls} dim="tls" context={dctx} /></Panel>
              <Panel title="Cipher suite" flush><TopList rows={d.cipher} dim="cipher" context={dctx} /></Panel>
            </div>
          )}

          {tab === 'errors' && (
            <div className="vstack" style={{ gap: 14 }}>
              <div className="grid cols-4">
                <Stat label="4xx" value={compact(t.c4xx)} tone="amber" sub={pct(t.requests ? t.c4xx / t.requests : 0)} />
                <Stat label="5xx" value={compact(t.c5xx)} tone={t.c5xx ? 'red' : 'green'}
                      sub={pct(t.requests ? t.c5xx / t.requests : 0)} />
                <Stat label="Total errors" value={compact(t.c4xx + t.c5xx)} sub={pct(t.error_rate)} />
                <Stat label="First seen" value={dateTime(data.window.from).split(',')[0]} sub="window start" />
              </div>
              <Panel title="URLs producing the most errors" flush>
                {data.errorPaths?.length ? (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>URL</th>
                        <th className="num">Errors</th>
                        <th className="num">Requests</th>
                        <th className="num">Error rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.errorPaths.map((r) => (
                        <tr key={r.path}>
                          <td className="cell-wide">
                            <Link
                              to={`/requests${qs({ path: r.path, host, status: '4xx' })}`}
                              className="truncate mono"
                              title={`Show the failing requests for ${r.path}`}
                            >
                              {r.path}
                            </Link>
                          </td>
                          <td className="num" style={{ color: 'var(--amber)' }}>{num(r.errors)}</td>
                          <td className="num dim">{num(r.requests)}</td>
                          <td className="num">{pct(r.error_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty>No errors recorded for this domain. </Empty>
                )}
              </Panel>
              <Panel title="Status codes" flush>
                <CategoryBars rows={d.status} colorFor={statusColor} height={Math.max(180, d.status.length * 26)} />
              </Panel>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Live requests for this domain" flush>
        <div style={{ padding: 12 }}>
          <Link className="btn sm" to={`/logs?host=${encodeURIComponent(host)}`}>
            Open the log stream filtered to {host} →
          </Link>
        </div>
      </Panel>
    </>
  );
}
