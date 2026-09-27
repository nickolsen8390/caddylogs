// One rendering of "a list of requests", shared by the live stream, the
// request explorer and the per-IP page — so expansion, drill-down links and
// error handling behave identically everywhere.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { JsonView } from './JsonView.jsx';
import { Chip, Empty } from './ui.jsx';
import { bytes, clock, ms, statusClass } from '../lib/format.js';
import { countryName, flag } from '../lib/countries.js';
import { drillTo } from '../lib/drill.js';

/** A chip that navigates to the requests behind it, when one is possible. */
function DrillChip({ dim, value, children, tone, title, context }) {
  const to = drillTo(dim, value, context);
  const chip = (
    <Chip tone={tone} title={title ?? (to ? `Show requests where ${dim} is ${value}` : undefined)}>
      {children}
    </Chip>
  );
  if (!to) return chip;
  return (
    <Link to={to} style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
      {chip}
    </Link>
  );
}

function ExpandedRequest({ row, context }) {
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState(null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api
      .get(`/api/request/${row.id}`)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        setState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        // Distinguish "retention removed it" from "the request failed".
        // Reporting the second as the first sent us chasing a phantom before.
        if (err instanceof ApiError && err.status === 404) {
          setProblem({ kind: 'gone', body: err.body });
          setState('gone');
        } else {
          setProblem({
            kind: 'error',
            status: err instanceof ApiError ? err.status : null,
            message: err?.message ?? 'unknown error',
          });
          setState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <div>
      <div className="hstack" style={{ padding: '8px 14px', gap: 6, background: 'var(--panel-2)' }}>
        <DrillChip dim="ip" value={row.ip} context={context} tone="info">
          {row.ip ?? 'no address'}
        </DrillChip>
        {row.country && (
          <DrillChip dim="country" value={row.country} context={context}>
            {flag(row.country)} {countryName(row.country)}
          </DrillChip>
        )}
        {row.asn ? (
          <DrillChip dim="asn" value={row.asn} context={context} title={row.as_org ?? ''}>
            AS{row.asn} {row.as_org ?? ''}
          </DrillChip>
        ) : null}
        {row.browser && (
          <DrillChip dim="browser" value={row.browser} context={context}>
            {row.browser}
          </DrillChip>
        )}
        {row.os && row.os !== 'Unknown' && (
          <DrillChip dim="os" value={row.os} context={context}>
            {row.os}
          </DrillChip>
        )}
        {row.device && (
          <DrillChip dim="device" value={row.device} context={context}>
            {row.device}
          </DrillChip>
        )}
        {row.bot ? (
          <DrillChip dim="kind" value="bot" context={context} tone="warn">
            bot
          </DrillChip>
        ) : null}
        <DrillChip dim="status" value={row.status} context={context}>
          {row.status}
        </DrillChip>
        <DrillChip dim="method" value={row.method} context={context}>
          {row.method}
        </DrillChip>
        {row.proto && (
          <DrillChip dim="proto" value={row.proto} context={context}>
            {row.proto}
          </DrillChip>
        )}
        {row.tls_version && (
          <DrillChip dim="tls" value={row.tls_version} context={context}>
            {row.tls_version}
          </DrillChip>
        )}
        {row.tls_cipher && (
          <DrillChip dim="cipher" value={row.tls_cipher} context={context} title={row.tls_cipher}>
            {row.tls_cipher.replace(/^TLS_/, '')}
          </DrillChip>
        )}
        {row.referer_host && row.referer_host !== '(direct)' && (
          <DrillChip dim="referer" value={row.referer_host} context={context} title={row.referer ?? ''}>
            via {row.referer_host}
          </DrillChip>
        )}
        <DrillChip dim="path" value={row.path} context={context} title={row.path}>
          this URL
        </DrillChip>
        {row.ua && (
          <DrillChip dim="ua" value={row.ua} context={context} title={row.ua}>
            this exact agent
          </DrillChip>
        )}
      </div>

      {state === 'loading' && <pre className="log-json faint">Loading the original log line…</pre>}

      {state === 'gone' && (
        <pre className="log-json faint">
          {`This request is no longer stored.\n\n`}
          {`Individual requests — and their raw log lines — are kept for `}
          {problem?.body?.retentionHours ?? '?'}
          {` hours (RAW_RETENTION_HOURS).\n`}
          {problem?.body?.retainedFrom
            ? `The oldest one still held is from ${new Date(problem.body.retainedFrom).toLocaleString()}.\n`
            : ''}
          {`\nAggregate statistics for this period are unaffected — only the ability to\ninspect this individual request is gone.`}
        </pre>
      )}

      {state === 'error' && (
        <pre className="log-json" style={{ color: 'var(--red)' }}>
          {`Could not load the original log line.\n\n`}
          {problem?.status ? `HTTP ${problem.status}: ` : ''}
          {problem?.message ?? 'unknown error'}
          {`\n\nThis is a fault, not a retention limit.\n`}
          {problem?.status
            ? `Check the web container's log for a matching entry.`
            : // No status at all means fetch() itself rejected: the request
              // never left the browser, so the server log will be empty.
              `There is no HTTP status, so the request never reached the server —\n` +
              `nothing will appear in the container log. The usual cause is a\n` +
              `browser extension or content blocker dropping it. Check the browser\n` +
              `console for ERR_BLOCKED_BY_CLIENT, or retry in a private window.`}
        </pre>
      )}

      {state === 'ok' && detail?.parseError && (
        <div style={{ padding: '6px 14px' }}>
          <Chip tone="warn" title={detail.parseError}>
            stored line is not valid JSON — showing it verbatim
          </Chip>
        </div>
      )}

      {state === 'ok' && !detail?.hasRaw && (
        <div style={{ padding: '6px 14px' }}>
          <Chip tone="warn">no raw line was stored for this request</Chip>
        </div>
      )}

      {state === 'ok' && <JsonView value={detail?.parsed} raw={detail?.event?.raw} />}
    </div>
  );
}

export function RequestRow({ row, expanded, onToggle, context }) {
  return (
    <div>
      <div
        className={`log-row${expanded ? ' open' : ''}`}
        onClick={() => onToggle(row.id)}
        title="Click to expand the original log entry"
      >
        <span className="faint col-time">{clock(row.ts)}</span>
        <span className={`col-status ${statusClass(row.status)}`} style={{ fontWeight: 650 }}>
          {row.status || '—'}
        </span>
        <span className="dim col-method">{row.method}</span>
        {/* One line and truncated on wide screens; its own wrapping line on
            phones, where there is no room to share a row with the URL. */}
        <span className="truncate col-url" title={`${row.host}${row.path}${row.query ? `?${row.query}` : ''}`}>
          <span className="dim">{row.host}</span>
          {row.path}
          {row.query ? <span className="faint">?{row.query}</span> : null}
        </span>
        <span className="faint col-size" style={{ textAlign: 'right' }}>{bytes(row.bytes_out)}</span>
        <span className="faint col-dur" style={{ textAlign: 'right' }}>{ms(row.dur_ms)}</span>
        <span
          className="truncate col-ip"
          title={`${row.ip ?? ''}${row.as_org ? ` · ${row.as_org}` : ''}`}
        >
          {row.country ? `${flag(row.country)} ` : ''}
          {row.ip ? (
            // Straight to the address's own page; stopPropagation so the click
            // navigates instead of also toggling the row open.
            <Link to={drillTo('ip', row.ip, context)} onClick={(e) => e.stopPropagation()}>
              {row.ip}
            </Link>
          ) : (
            <span className="faint">—</span>
          )}
        </span>
      </div>
      {expanded && <ExpandedRequest row={row} context={context} />}
    </div>
  );
}

/**
 * @param {object} p
 * @param {object[]} p.rows
 * @param {object} [p.context] host/range carried into drill-down links
 */
export function RequestList({ rows, context, empty, viewRef, className = 'log-view' }) {
  const [expanded, setExpanded] = useState(null);
  const toggle = (id) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <div className={className} ref={viewRef}>
      {!rows?.length ? (
        <Empty>{empty ?? 'No requests matched.'}</Empty>
      ) : (
        rows.map((row) => (
          <RequestRow
            key={row.id}
            row={row}
            expanded={expanded === row.id}
            onToggle={toggle}
            context={context}
          />
        ))
      )}
    </div>
  );
}
