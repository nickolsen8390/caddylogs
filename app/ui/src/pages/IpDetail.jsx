// Everything known about one source address: enrichment, what it asked for,
// and the individual requests it made.

import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { Banner, Chip, Empty, Loading, Panel, Stat, TopList } from '../components/ui.jsx';
import { RequestList } from '../components/RequestList.jsx';
import { countryName, flag } from '../lib/countries.js';
import { drillTo } from '../lib/drill.js';
import { bytes, compact, dateTime, num, pct, relative } from '../lib/format.js';

export default function IpDetail({ ctx }) {
  const { ip } = useParams();
  const [params] = useSearchParams();
  const host = params.get('host') || null;
  const range = params.get('range') || ctx?.range;

  const { data, loading, error } = useApi(
    `/api/ip/${encodeURIComponent(ip)}${qs({ host, range })}`,
    { refreshMs: 30_000, onUnauthorized: ctx?.onUnauthorized }
  );
  const requests = useApi(`/api/requests${qs({ ip, host, limit: 200 })}`, {
    refreshMs: 30_000,
    onUnauthorized: ctx?.onUnauthorized,
  });

  if (error) {
    return <Banner level="error">Could not load this address: {String(error.message)}</Banner>;
  }
  if (!data) return <Panel><Loading rows={6} /></Panel>;

  const info = data.info ?? {};
  const live = data.live ?? {};
  const ctxLinks = { host, range };

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="hstack">
          <Link to="/requests" className="btn sm">← Requests</Link>
          <h2 className="mono" style={{ margin: 0, fontSize: 16, fontWeight: 640 }}>{ip}</h2>
          {loading && <span className="spinner" />}
        </div>
        <div className="hstack" style={{ gap: 6 }}>
          <Link className="btn sm" to={`/requests${qs({ ip, host })}`}>All requests</Link>
          <Link className="btn sm" to={`/logs${qs({ ip, host })}`}>Watch live</Link>
        </div>
      </div>

      {/* ------------------------------------------------ enrichment ----- */}
      <Panel title="Network" style={{ marginBottom: 14 }}>
        {info.ip ? (
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
            {info.country && (
              <Chip title="Where the client is, per MaxMind GeoLite2">
                {flag(info.country)} {info.country_name ?? countryName(info.country)}
              </Chip>
            )}
            {info.asn ? (
              <Link to={drillTo('asn', info.asn, ctxLinks)} style={{ textDecoration: 'none' }}>
                <Chip tone="info">
                  AS{info.asn} {info.as_org ?? info.as_name ?? ''}
                </Chip>
              </Link>
            ) : (
              <Chip tone="warn">no ASN resolved</Chip>
            )}
            {info.as_prefix && <Chip title="Longest-matching BGP prefix">{info.as_prefix}</Chip>}
            {info.as_rir && <Chip>{info.as_rir}</Chip>}
            {info.as_country && (
              <Chip title="Where the autonomous system is registered — not where the traffic came from">
                AS registered in {flag(info.as_country)} {info.as_country}
              </Chip>
            )}
            <Chip title="Which source supplied this record">{info.source ?? 'unresolved'}</Chip>
            {info.error && <Chip tone="bad" title={info.error}>last lookup failed</Chip>}
            <span className="faint" style={{ fontSize: 11 }}>
              resolved {relative(info.updated_at)}
            </span>
          </div>
        ) : (
          <Empty>
            This address has not been enriched yet. It is queued — check the{' '}
            <Link to="/health">Health</Link> page if the queue is not draining.
          </Empty>
        )}
      </Panel>

      {/* ------------------------------------------------ counters ------- */}
      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat
          label="Requests (all time)"
          value={compact(data.totals?.requests ?? 0)}
          sub="from stored statistics"
        />
        <Stat
          label={`Requests (last ${data.retentionHours}h)`}
          value={compact(live.requests ?? 0)}
          sub="individually inspectable"
        />
        <Stat label="Bandwidth" value={bytes(data.totals?.bytes ?? 0)} sub="served to this address" />
        <Stat
          label="Errors"
          value={compact(live.errors ?? 0)}
          tone={live.errors ? 'amber' : undefined}
          sub={live.requests ? pct(live.errors / live.requests) : '—'}
        />
        <Stat label="Domains touched" value={num(live.hosts ?? 0)} sub={`${num(live.paths ?? 0)} distinct URLs`} />
        <Stat
          label="User agents"
          value={num(live.agents ?? 0)}
          sub={live.bots ? `${compact(live.bots)} bot requests` : 'no bot signature'}
        />
        <Stat label="First seen" value={live.first_seen ? relative(live.first_seen) : '—'}
              sub={live.first_seen ? dateTime(live.first_seen) : 'outside the raw window'} />
        <Stat label="Last seen" value={live.last_seen ? relative(live.last_seen) : '—'}
              sub={live.last_seen ? dateTime(live.last_seen) : ''} />
      </div>

      {/* ------------------------------------------------ behaviour ------ */}
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Panel title="Domains requested" flush>
          <TopList
            rows={data.hosts}
            render={(r) => <Link to={`/domains/${encodeURIComponent(r.value)}`}>{r.value}</Link>}
            empty="Nothing in the raw window."
          />
        </Panel>
        <Panel title="URLs requested" flush>
          <TopList
            rows={data.paths}
            render={(r) => (
              <Link to={drillTo('path', r.value, ctxLinks)} className="mono">{r.value}</Link>
            )}
            empty="Nothing in the raw window."
          />
        </Panel>
        <Panel title="Status codes" flush>
          <TopList
            rows={data.statuses}
            render={(r) => <Link to={drillTo('status', r.value, ctxLinks)}>{r.value}</Link>}
            empty="Nothing in the raw window."
          />
        </Panel>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <Panel title="User agents" flush>
          <TopList
            rows={data.agents}
            render={(r) => (
              <Link to={drillTo('ua', r.value, ctxLinks)} className="mono" title={r.value}>
                {r.value}
              </Link>
            )}
            empty="No User-Agent recorded."
          />
        </Panel>
        <Panel title="Methods" flush>
          <TopList
            rows={data.methods}
            render={(r) => <Link to={drillTo('method', r.value, ctxLinks)}>{r.value}</Link>}
            empty="Nothing in the raw window."
          />
        </Panel>
      </div>

      {/* ------------------------------------------------ requests ------- */}
      <Panel
        title="Recent requests"
        flush
        actions={
          <span className="faint" style={{ fontSize: 11 }}>
            newest first · click any row for the original log line
          </span>
        }
      >
        {requests.loading && !requests.data ? (
          <Loading rows={6} />
        ) : (
          <RequestList
            rows={requests.data?.rows ?? []}
            context={ctxLinks}
            className="log-view"
            empty={`No requests from this address in the last ${data.retentionHours} hours.`}
          />
        )}
      </Panel>
    </>
  );
}
