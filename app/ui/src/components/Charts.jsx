import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { axisTime, bytes, compact, ms, num } from '../lib/format.js';
import { Empty } from './ui.jsx';

const AXIS = { stroke: 'var(--text-faint)', fontSize: 10.5 };
const GRID = { stroke: 'var(--border-soft)', strokeDasharray: '2 4' };

const tooltipStyle = {
  contentStyle: {
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    boxShadow: 'var(--shadow)',
  },
  labelStyle: { color: 'var(--text-dim)', marginBottom: 4 },
  itemStyle: { padding: 0 },
};

// ---------------------------------------------------------------------------
//  Bucket size
// ---------------------------------------------------------------------------
// The server picks the bucket size from the time range: per minute for 1h and
// 6h, per hour for 24h, per day up to 90d, per week beyond. A count chart's
// height is "requests in one bucket", so the same burst legitimately reads as
// a per-minute, per-hour or per-day total depending on the range. Every count
// chart therefore states its unit, and its tooltip gives the exact span and
// an average rate that stays comparable across ranges.

const UNITS = { 60: 'minute', 3600: 'hour', 86400: 'day', 604800: 'week' };
export const bucketUnit = (step) => UNITS[step] ?? `${step} seconds`;

/** "Sep 9, 14:00–15:00" · "Tue, Sep 9" · "week of Sep 8". */
function bucketSpan(bucketSec, step) {
  const start = new Date(bucketSec * 1000);
  const t = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (step < 86400) {
    const end = new Date((bucketSec + step) * 1000);
    return `${start.toLocaleString(undefined, { month: 'short', day: 'numeric', ...t })}–${end.toLocaleTimeString(undefined, t)}`;
  }
  if (step === 86400) {
    return start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return `week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** True for the bucket that is still accumulating. */
const isFilling = (bucketSec, step) => bucketSec + step > Date.now() / 1000;

/** Average per minute over the part of the bucket that has actually elapsed. */
function perMinute(count, bucketSec, step) {
  const elapsed = Math.max(1, Math.min(step, Date.now() / 1000 - bucketSec));
  return count / (elapsed / 60);
}

function ChartCaption({ series, what }) {
  const points = series?.points ?? [];
  if (!points.length) return null;
  const unit = bucketUnit(series.step);
  const last = points[points.length - 1];
  return (
    <div
      className="chart-caption"
      title="Each point is one bucket. Changing the time range changes the bucket size, so the same burst reads as a per-minute, per-hour or per-day total."
    >
      {what} per <strong>{unit}</strong> · {points.length} {unit}
      {points.length === 1 ? '' : 's'} shown
      {isFilling(last.bucket, series.step) ? ` · the latest ${unit} is still filling` : ''}
    </div>
  );
}

function spanLabel(payload, extra) {
  const p = payload?.[0]?.payload;
  if (!p) return '';
  return `${p.span}${p.filling ? ' (still filling)' : ''}${extra ? ` — ${extra(p)}` : ''}`;
}

/** Requests over time, split by status class. */
export function TrafficChart({ series, height = 220 }) {
  const points = series?.points ?? [];
  if (!points.length) return <Empty />;
  const step = series.step;
  const data = points.map((p) => ({
    t: p.bucket,
    label: axisTime(p.bucket, step),
    span: bucketSpan(p.bucket, step),
    filling: isFilling(p.bucket, step),
    total: p.requests ?? 0,
    rate: perMinute(p.requests ?? 0, p.bucket, step),
    '2xx': p.c2xx ?? 0,
    '3xx': p.c3xx ?? 0,
    '4xx': p.c4xx ?? 0,
    '5xx': p.c5xx ?? 0,
  }));
  return (
    <>
      <ChartCaption series={series} what="Requests" />
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
          <defs>
            {[['2xx', 'green'], ['3xx', 'blue'], ['4xx', 'amber'], ['5xx', 'red']].map(([k, c]) => (
              <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--${c})`} stopOpacity={0.55} />
                <stop offset="100%" stopColor={`var(--${c})`} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={compact} width={46} />
          <Tooltip
            {...tooltipStyle}
            labelFormatter={(_, payload) =>
              spanLabel(payload, (p) => `${num(p.total)} requests, ${compact(p.rate)}/min avg`)
            }
            formatter={(v, n) => [num(v), n]}
          />
          <Legend wrapperStyle={{ fontSize: 11.5, paddingTop: 6 }} iconType="circle" iconSize={7} />
          {[['2xx', 'green'], ['3xx', 'blue'], ['4xx', 'amber'], ['5xx', 'red']].map(([k, c]) => (
            <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={`var(--${c})`}
                  strokeWidth={1.2} fill={`url(#g-${k})`} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </>
  );
}

/** Bandwidth served over the same buckets. */
export function BandwidthChart({ series, height = 180 }) {
  const points = series?.points ?? [];
  if (!points.length) return <Empty />;
  const data = points.map((p) => ({
    label: axisTime(p.bucket, series.step),
    span: bucketSpan(p.bucket, series.step),
    filling: isFilling(p.bucket, series.step),
    out: p.bytes_out ?? 0,
  }));
  return (
    <>
      <ChartCaption series={series} what="Bytes sent" />
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -6, bottom: 0 }}>
          <defs>
            <linearGradient id="g-bw" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--violet)" stopOpacity={0.5} />
              <stop offset="100%" stopColor="var(--violet)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={bytes} width={62} />
          <Tooltip
            {...tooltipStyle}
            labelFormatter={(_, payload) => spanLabel(payload)}
            formatter={(v) => [bytes(v), 'Sent']}
          />
          <Area type="monotone" dataKey="out" stroke="var(--violet)" strokeWidth={1.3}
                fill="url(#g-bw)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </>
  );
}

/** Mean response time per bucket. */
export function LatencyTrend({ series, height = 180 }) {
  const points = series?.points ?? [];
  if (!points.length) return <Empty />;
  const data = points.map((p) => ({
    label: axisTime(p.bucket, series.step),
    avg: p.requests ? p.dur_sum / p.requests : 0,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v)}ms`} width={54} />
        <Tooltip {...tooltipStyle} formatter={(v) => [ms(v), 'Mean']} />
        <Line type="monotone" dataKey="avg" stroke="var(--accent)" strokeWidth={1.6}
              dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Latency distribution, ordered fastest to slowest. */
export function LatencyHistogram({ latency, height = 190 }) {
  const rows = latency?.histogram ?? [];
  if (!rows.length) return <Empty>No timing data in these logs.</Empty>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="bucket" {...AXIS} tickLine={false} axisLine={false}
               interval={0} angle={-35} textAnchor="end" height={54} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} tickFormatter={compact} width={46} />
        <Tooltip {...tooltipStyle} formatter={(v) => [num(v), 'Requests']} cursor={{ fill: 'var(--panel-2)' }} />
        <Bar dataKey="requests" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={r.bucket} fill={i < 6 ? 'var(--accent)' : i < 9 ? 'var(--amber)' : 'var(--red)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal ranked bars — used for status codes and small categoricals. */
export function CategoryBars({ rows, height = 200, colorFor, labelKey = 'value' }) {
  if (!rows?.length) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={compact} />
        <YAxis type="category" dataKey={labelKey} {...AXIS} tickLine={false} axisLine={false} width={86} />
        <Tooltip {...tooltipStyle} formatter={(v) => [num(v), 'Requests']} cursor={{ fill: 'var(--panel-2)' }} />
        <Bar dataKey="requests" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={colorFor ? colorFor(r) : 'var(--accent)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export const statusColor = (row) => {
  const code = parseInt(row.value, 10) || 0;
  if (code >= 500) return 'var(--red)';
  if (code >= 400) return 'var(--amber)';
  if (code >= 300) return 'var(--blue)';
  if (code >= 200) return 'var(--green)';
  return 'var(--text-faint)';
};
