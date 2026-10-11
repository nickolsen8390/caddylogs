// Visitor analytics, worked out from the access log alone: visitors, visits,
// page views, and where they came from. Only page loads by browsers count —
// assets, API calls, prefetches and bots are left out.
//
// Top pages and broken links count page views. Everything else counts visits,
// credited to the page each visit started on, so a visit from a search engine
// that goes on to read five pages is one Search visit, not one Search and four
// Internal.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi, useHostOptions } from '../lib/useApi.js';
import { qs } from '../lib/api.js';
import { drillTo } from '../lib/drill.js';
import { Banner, Empty, Loading, Panel, Stat, Tabs, TopList } from '../components/ui.jsx';
import { PageviewChart } from '../components/Charts.jsx';
import { TimeRange } from '../components/TimeRange.jsx';
import { compact, duration, num, pct } from '../lib/format.js';

const UTM_TABS = [
  { id: 'utm_source', label: 'Source' },
  { id: 'utm_medium', label: 'Medium' },
  { id: 'utm_campaign', label: 'Campaign' },
  { id: 'utm_term', label: 'Term' },
  { id: 'utm_content', label: 'Content' },
];

let languageNames = null;
function languageName(tag) {
  try {
    languageNames ??= new Intl.DisplayNames(undefined, { type: 'language' });
    const name = languageNames.of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
}

export default function Traffic({ ctx }) {
  const { range, setRange, onUnauthorized } = ctx;
  const [params, setParams] = useSearchParams();
  const host = params.get('host') || '';
  const [utmTab, setUtmTab] = useState('utm_source');

  const meta = useApi('/api/meta', { refreshMs: 60_000, onUnauthorized });
  const hostOptions = useHostOptions(host, { range, onUnauthorized });
  const { data, loading, error } = useApi(`/api/traffic${qs({ range, host })}`, {
    refreshMs: 30_000,
    onUnauthorized,
  });

  const t = data?.totals;
  const p = data?.previous;
  const views = t?.pageviews ?? 0;
  const visits = t?.visits ?? 0;
  const dctx = { host: host || undefined, range };

  return (
    <>
      <div className="hstack" style={{ marginBottom: 14, justifyContent: 'space-between', flexWrap: 'wrap' }}>
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
        <span className="faint" style={{ fontSize: 11.5 }}>
          Page loads by browsers — assets, API calls, prefetches and bots are not counted
        </span>
      </div>

      {error && <Banner level="error">Could not load traffic: {String(error.message)}</Banner>}

      {!t ? (
        <Panel><Loading rows={5} /></Panel>
      ) : views === 0 ? (
        <Panel>
          <Empty>
            No page views in this window{t.requests ? ` (${compact(t.requests)} requests, none of them a browser loading a page)` : ''}.
            Page views are counted from version 1.2.0 onward, plus the requests that were still stored
            when it was installed. They need Caddy's access log to include request headers, which it
            does unless a log filter removes them. Single-page apps only show their first page load:
            later route changes never reach the server.
          </Empty>
        </Panel>
      ) : (
        <>
          <div className="grid stats" style={{ marginBottom: 14 }}>
            <Stat label="Active now" value={num(data.active)} tone={data.active ? 'green' : undefined}
                  sub="visitors in the last 5 minutes" />
            <Stat label="Visitors" value={compact(t.visitors)} current={t.visitors} previous={p?.visitors}
                  sub="distinct per day, summed" />
            <Stat label="Visits" value={compact(visits)} current={visits} previous={p?.visits}
                  sub={`${num(visits)} total`} />
            <Stat label="Page views" value={compact(views)} current={views} previous={p?.pageviews}
                  sub={`${compact(data.pages.distinct)} distinct pages`} />
            <Stat label="Pages per visit" value={t.pages_per_visit === null ? '—' : t.pages_per_visit.toFixed(1)}
                  current={t.pages_per_visit} previous={p?.pages_per_visit ?? undefined} />
            <Stat label="Bounce rate" value={t.bounce_rate === null ? '—' : pct(t.bounce_rate, 0)}
                  current={t.bounce_rate} previous={p?.bounce_rate ?? undefined} inverted
                  sub="visits of a single page" />
            <Stat label="Visit duration" value={duration(t.avg_visit_ms)}
                  current={t.avg_visit_ms} previous={p?.avg_visit_ms ?? undefined}
                  sub="first to last page, average" />
            <Stat label="From other sites" value={visits ? pct(data.referrers.total / visits, 0) : '—'}
                  sub={`${compact(data.referrers.total)} visits with a referrer`} />
          </div>

          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Visitors and page views" style={{ gridColumn: 'span 2' }}>
              <PageviewChart series={data.series} height={240} />
            </Panel>
            <Panel title="Channels" flush>
              <VisitList rows={data.channels.rows} dim="channel" ctx={dctx}
                         label={(r) => (
                           <>
                             {r.value} <span className="faint">{visits ? pct(r.requests / visits, 0) : ''}</span>
                           </>
                         )} />
            </Panel>
          </div>

          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Entry pages" flush>
              <VisitList rows={data.entries.rows} dim="entry" ctx={dctx} />
            </Panel>
            <Panel title="Top pages" flush>
              <TopList rows={data.pages.rows} dim="page" context={dctx} />
            </Panel>
            <Panel title="Exit pages" flush
                   actions={<span className="faint" style={{ fontSize: 11 }} title="A visit's exit page is counted once it has been quiet for 30 minutes">finished visits</span>}>
              <TopList rows={data.exits.rows} dim="exit" context={dctx} />
            </Panel>
          </div>

          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <Panel title="Referrers" flush>
              <VisitList rows={data.referrers.rows} dim="refsite" ctx={dctx}
                         empty="No visits from other sites in this window." />
            </Panel>
            <Panel title="Languages" flush>
              <TopList rows={data.languages.rows} dim="lang" context={dctx}
                       label={(r) => languageName(r.value)} />
            </Panel>
            <Panel title="Broken links" flush>
              <TopList
                rows={data.broken.rows}
                dim="broken"
                context={dctx}
                empty="No links led to a missing page in this window."
              />
            </Panel>
          </div>

          <div className="grid cols-1">
            <Panel title="Campaigns (UTM)" flush>
              <div style={{ padding: '0 14px' }}>
                <Tabs tabs={UTM_TABS} active={utmTab} onChange={setUtmTab} />
              </div>
              <VisitList
                rows={data.utm[utmTab]?.rows}
                dim={utmTab}
                ctx={dctx}
                empty="No tagged links in this window. Add utm_source, utm_medium and utm_campaign to links you share; ad click IDs (gclid, msclkid, fbclid…) are read too."
              />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Ranked visits with bounce rate and time on site. Visit dimensions store
 * visits as `requests`, bounces as `errors` and duration as `avg_ms`.
 */
function VisitList({ rows, dim, ctx, label: labelOf, empty }) {
  if (!rows?.length) return <Empty>{empty ?? 'Nothing recorded yet.'}</Empty>;
  const max = Math.max(...rows.map((r) => r.requests), 1);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th />
            <th className="num">Visits</th>
            <th className="num" title="Visits that saw a single page">Bounce</th>
            <th className="num" title="Average time from first to last page view">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const to = drillTo(dim, r.value, ctx);
            const label = labelOf ? labelOf(r) : r.value;
            return (
              <tr key={r.value}>
                <td className="bar-cell cell-wide">
                  <span className="bar-fill" style={{ width: `${(r.requests / max) * 100}%` }} />
                  <span className="bar-label truncate" title={r.value}>
                    {to ? <Link to={to} title="Show the page views behind this">{label}</Link> : label}
                  </span>
                </td>
                <td className="num">{compact(r.requests)}</td>
                <td className="num">{r.requests ? pct(r.errors / r.requests, 0) : '—'}</td>
                <td className="num">{duration(r.avg_ms)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
