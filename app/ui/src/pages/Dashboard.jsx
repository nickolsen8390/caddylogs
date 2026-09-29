import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { Banner, Chip, Empty, Loading, Panel, Stat, StatusStrip, TopList } from '../components/ui.jsx';
import { BandwidthChart, CategoryBars, LatencyHistogram, LatencyTrend, TrafficChart, statusColor } from '../components/Charts.jsx';
import { WorldMap } from '../components/WorldMap.jsx';
import { TimeRange } from '../components/TimeRange.jsx';
import { countryName, flag } from '../lib/countries.js';
import { bytes, compact, ms, num, pct } from '../lib/format.js';

export default function Dashboard({ ctx }) {
  const { range, setRange, onUnauthorized } = ctx;
  const meta = useApi('/api/meta', { refreshMs: 60_000, onUnauthorized });
  const { data, loading, error } = useApi(`/api/overview${qs({ range })}`, {
    refreshMs: 30_000,
    onUnauthorized,
  });

  const t = data?.totals;
  const p = data?.previous;
  const warnings = meta.data?.warnings ?? [];

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="hstack">
          <TimeRange value={range} onChange={setRange} retentionDays={meta.data?.retention?.days} />
          {loading && <span className="spinner" />}
        </div>
        <span className="faint" style={{ fontSize: 11.5 }}>
          Auto-refreshing every 30s
        </span>
      </div>

      {warnings.map((w, i) => (
        <Banner key={i} level={w.level} title={w.source === 'notoolkit' ? 'notoolkit.com enrichment' : undefined}>
          {w.message}
        </Banner>
      ))}

      {error && <Banner level="error">Could not load statistics: {String(error.message)}</Banner>}

      {!t ? (
        <Panel><Loading rows={5} /></Panel>
      ) : t.requests === 0 ? (
        <Panel>
          <Empty>
            No requests recorded in this window. If the stack has just started, give the ingester a
            moment — or check <Link to="/health">System health</Link> to confirm it is reading your logs.
          </Empty>
        </Panel>
      ) : (
        <>
          {/* ---------------------------------------------------- headline */}
          <div className="grid stats" style={{ marginBottom: 14 }}>
            <Stat label="Requests" value={compact(t.requests)} current={t.requests} previous={p?.requests}
                  sub={`${num(t.requests)} total`} />
            <Stat label="Success rate" value={pct(t.success_rate)} current={t.success_rate}
                  previous={p?.success_rate} sub={`${compact(t.c2xx + t.c3xx)} 2xx/3xx`}
                  tone={t.success_rate > 0.95 ? 'green' : t.success_rate > 0.85 ? 'amber' : 'red'} />
            <Stat label="Errors" value={compact(t.c4xx + t.c5xx)} current={t.c4xx + t.c5xx}
                  previous={p ? p.c4xx + p.c5xx : undefined} inverted
                  sub={`${pct(t.error_rate)} of traffic`} tone={t.c5xx > 0 ? 'red' : undefined} />
            <Stat label="Server errors" value={compact(t.c5xx)} current={t.c5xx} previous={p?.c5xx}
                  inverted sub="5xx responses" tone={t.c5xx > 0 ? 'red' : 'green'} />
            <Stat label="Unique clients" value={compact(t.unique_ips)} current={t.unique_ips}
                  previous={p?.unique_ips} sub="distinct source IPs" />
            <Stat label="Bandwidth out" value={bytes(t.bytes_out)} current={t.bytes_out}
                  previous={p?.bytes_out} sub={`${bytes(t.bytes_in)} in`} />
            <Stat label="Mean response" value={ms(t.avg_ms)} current={t.avg_ms} previous={p?.avg_ms}
                  inverted sub={`p95 ${ms(data.latency?.p95)}`} />
            <Stat label="Domains served" value={num(t.hosts)} sub="with traffic in range" />
            <Stat label="Bot traffic" value={pct(t.requests ? t.bots / t.requests : 0)}
                  sub={`${compact(t.bots)} requests`} />
          </div>

          {/* ---------------------------------------------------- traffic */}
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Requests over time" style={{ gridColumn: "span 2" }}>
              <TrafficChart series={data.series} height={240} />
            </Panel>
            <div className="vstack" style={{ gap: 14 }}>
              <Panel title="Response mix">
                <StatusStrip totals={t} />
              </Panel>
              <Panel title="Status codes" flush>
                <CategoryBars rows={data.status.slice(0, 8)} colorFor={statusColor} height={180} />
              </Panel>
            </div>
          </div>

          {/* ---------------------------------------------------- top lists */}
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Busiest domains" flush
                   actions={<Link className="btn sm" to="/domains">All domains</Link>}>
              <TopList
                rows={data.topDomains.map((d) => ({ ...d, value: d.host }))}
                render={(r) => <Link to={`/domains/${encodeURIComponent(r.host)}`}>{r.host}</Link>}
              />
            </Panel>
            <Panel title="Top requested URLs" flush>
              <TopList rows={data.topPaths} dim="path" context={{ range }} />
            </Panel>
            <Panel title="Top talkers" flush>
              <TopList
                rows={data.topIps}
                dim="ip"
                context={{ range }}
                render={(r) => (
                  <Link to={`/ip/${encodeURIComponent(r.value)}`} className="mono">{r.value}</Link>
                )}
              />
            </Panel>
          </div>

          {/* ---------------------------------------------------- geography */}
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Requests by country" style={{ gridColumn: 'span 2' }}>
              <WorldMap rows={data.countries} />
            </Panel>
            <Panel title="Top countries" flush>
              <TopList
                rows={data.countries.slice(0, 12).map((c) => ({ ...c, value: c.country }))}
                render={(r) => (
                  <Link to={`/requests?country=${encodeURIComponent(r.country)}`}>
                    {flag(r.country)} {countryName(r.country)}
                  </Link>
                )}
              />
            </Panel>
          </div>

          {/* ---------------------------------------------------- clients */}
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Top networks (ASN)" flush>
              {data.topAsns?.length ? (
                <table className="data">
                  <tbody>
                    {data.topAsns.map((a) => (
                      <tr key={a.asn}>
                        <td className="cell-wide">
                          <Link to={`/requests?asn=${encodeURIComponent(a.asn)}`}
                                className="truncate" title={a.org}>
                            {a.org}
                          </Link>
                          <span className="faint mono" style={{ fontSize: 11 }}>
                            {a.asn === '0' ? 'unresolved' : `AS${a.asn}`}
                            {a.rir ? ` · ${a.rir}` : ''}
                            {a.as_country ? ` · ${a.as_country}` : ''}
                          </span>
                        </td>
                        <td className="num">{compact(a.requests)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>
                  {ctx.features?.notoolkit
                    ? 'No ASN data. Check notoolkit configuration on the Health page.'
                    : 'No ASN data. With notoolkit switched off, networks come from the MaxMind ASN database — check the Health page.'}
                </Empty>
              )}
            </Panel>
            <Panel title="Browsers" flush>
              <TopList rows={data.topBrowsers} dim="browser" context={{ range }} />
            </Panel>
            <Panel title="Referrers" flush>
              <TopList rows={data.topReferers} dim="referer" context={{ range }} />
            </Panel>
          </div>

          {/* ---------------------------------------------------- perf */}
          <div className="grid cols-3">
            <Panel title="Bandwidth served" style={{ gridColumn: 'span 2' }}>
              <BandwidthChart series={data.series} height={190} />
            </Panel>
            <Panel
              title="Latency distribution"
              actions={
                <div className="hstack" style={{ gap: 5 }}>
                  <Chip>p50 {ms(data.latency?.p50)}</Chip>
                  <Chip tone="warn">p95 {ms(data.latency?.p95)}</Chip>
                  <Chip tone="bad">p99 {ms(data.latency?.p99)}</Chip>
                </div>
              }
            >
              <LatencyHistogram latency={data.latency} height={190} />
            </Panel>
          </div>

          <div className="grid cols-1" style={{ marginTop: 14 }}>
            <Panel title="Mean response time over time">
              <LatencyTrend series={data.series} height={170} />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
