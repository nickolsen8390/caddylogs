import { useApi } from '../lib/useApi.js';
import { Banner, Chip, Empty, Loading, Panel, Stat } from '../components/ui.jsx';
import { compact, dateTime, num, pct, relative } from '../lib/format.js';

export default function Health({ ctx }) {
  const { onUnauthorized } = ctx;
  const { data, loading } = useApi('/api/health', { refreshMs: 20_000, onUnauthorized });
  const meta = useApi('/api/meta', { refreshMs: 60_000, onUnauthorized });

  if (!data) return <Panel><Loading rows={6} /></Panel>;

  const { ingest, enrichment, providers, warnings } = data;
  const today = ingest.days?.[0];
  const parseRate = today?.lines ? today.parsed / today.lines : null;
  const notoolkit = providers.find((p) => p.provider === 'notoolkit');

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14 }}>
        {loading && <span className="spinner" />}
        <span className="faint" style={{ fontSize: 11.5 }}>Refreshing every 20s</span>
      </div>

      {warnings?.length ? (
        warnings.map((w, i) => (
          <Banner key={i} level={w.level}>
            {w.message}
            {w.since ? <span className="faint"> · since {relative(w.since)}</span> : null}
          </Banner>
        ))
      ) : (
        <Banner level="info">Everything is running normally.</Banner>
      )}

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Stored requests" value={compact(ingest.counts.events)}
              sub={`raw window: ${meta.data?.retention?.rawHours ?? '—'}h`} />
        <Stat label="Awaiting rollup" value={compact(ingest.counts.pending)}
              tone={ingest.counts.pending > 100000 ? 'amber' : undefined}
              sub="events not yet aggregated" />
        <Stat label="Aggregate rows" value={compact(ingest.counts.dims + ingest.counts.rollup)}
              sub={`retained ${meta.data?.retention?.days ?? '—'} days`} />
        <Stat label="Cached IPs" value={compact(ingest.counts.ipInfo)} sub="country / ASN lookups" />
        {/* The queue holds notoolkit retries only; it is not used when
            lookups are switched off. */}
        {enrichment.notoolkitEnabled && (
          <Stat label="Enrichment queue" value={compact(enrichment.queueDepth)}
                tone={enrichment.queueDepth > 5000 ? 'amber' : 'green'} sub="IPs pending resolution" />
        )}
        <Stat label="Parse rate (today)" value={parseRate === null ? '—' : pct(parseRate)}
              sub={today ? `${num(today.parsed)} of ${num(today.lines)} lines` : 'no lines yet'} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <Panel title="IP enrichment providers">
          <div className="vstack" style={{ gap: 12 }}>
            <div>
              <div className="hstack" style={{ marginBottom: 6 }}>
                <strong>notoolkit.com</strong>
                {!enrichment.notoolkitEnabled ? (
                  <Chip>disabled</Chip>
                ) : notoolkit?.ok ? (
                  <Chip tone="ok">healthy</Chip>
                ) : notoolkit ? (
                  <Chip tone="bad">failing</Chip>
                ) : (
                  <Chip>no calls yet</Chip>
                )}
              </div>
              <dl className="kv">
                <dt>Purpose</dt>
                <dd>BGP prefix, originating ASN, and RIR registrant detail</dd>
                {enrichment.notoolkitEnabled ? (
                  <>
                    <dt>ASNs pending detail</dt>
                    <dd>{num(enrichment.asnPending ?? 0)} awaiting their one-off registry lookup</dd>
                    <dt>Calls</dt>
                    <dd>{num(notoolkit?.calls ?? 0)} ({num(notoolkit?.failures ?? 0)} failed)</dd>
                    <dt>Last success</dt>
                    <dd>{notoolkit?.last_ok_at ? relative(notoolkit.last_ok_at) : 'never'}</dd>
                    {notoolkit?.last_error ? (
                      <>
                        <dt>Last error</dt>
                        <dd style={{ color: 'var(--red)' }}>
                          {notoolkit.last_error}
                          <div className="faint">{dateTime(notoolkit.last_error_at)}</div>
                        </dd>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* Past calls and errors are left out: they describe a
                        service that is no longer in use. */}
                    <dt>Status</dt>
                    <dd>
                      Switched off (NOTOOLKIT_ENABLED=false). No addresses are sent anywhere; network
                      data comes from the MaxMind ASN database, when it is loaded.
                    </dd>
                  </>
                )}
              </dl>
            </div>

            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
              <div className="hstack" style={{ marginBottom: 6 }}>
                <strong>MaxMind GeoLite2</strong>
                {enrichment.maxmind.countryDb ? <Chip tone="ok">country loaded</Chip> : <Chip tone="warn">country missing</Chip>}
                {enrichment.maxmind.asnDb ? <Chip tone="ok">ASN loaded</Chip> : <Chip>ASN not loaded</Chip>}
              </div>
              <dl className="kv">
                <dt>Purpose</dt>
                <dd>Country lookup, and an ASN fallback when notoolkit is unavailable</dd>
                {enrichment.maxmind.error ? (
                  <>
                    <dt>Error</dt>
                    <dd style={{ color: 'var(--amber)' }}>{enrichment.maxmind.error}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </div>
        </Panel>

        <Panel title="Log files being followed" flush>
          {ingest.files?.length ? (
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="num">Read</th>
                    <th className="num">Size</th>
                    <th className="num">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {ingest.files.map((f) => (
                    <tr key={f.path}>
                      <td className="cell-wide">
                        <span className="truncate mono" title={f.path}>{f.path}</span>
                      </td>
                      <td className="num">{compact(f.offset)}</td>
                      <td className="num dim">{compact(f.size)}</td>
                      <td className="num dim">{relative(f.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              No log files are being followed. Check that CADDY_LOG_HOST_PATH points at your Caddy
              log directory and that files match CADDY_LOG_GLOB.
            </Empty>
          )}
        </Panel>
      </div>

      <Panel title="Ingest history" flush>
        {ingest.days?.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Lines read</th>
                <th className="num">Requests parsed</th>
                <th className="num">Skipped</th>
                <th className="num">Malformed</th>
              </tr>
            </thead>
            <tbody>
              {ingest.days.map((d) => (
                <tr key={d.day}>
                  <td>{new Date(d.day * 1000).toLocaleDateString()}</td>
                  <td className="num">{num(d.lines)}</td>
                  <td className="num">{num(d.parsed)}</td>
                  <td className="num dim" title="Non-access-log entries: startup messages, TLS errors, admin API">
                    {num(d.skipped)}
                  </td>
                  <td className="num" style={{ color: d.malformed ? 'var(--amber)' : undefined }}>
                    {num(d.malformed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No ingest activity recorded yet.</Empty>
        )}
      </Panel>
    </>
  );
}
