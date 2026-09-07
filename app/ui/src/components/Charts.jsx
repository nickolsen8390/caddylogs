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

/** Requests over time, split by status class. */
export function TrafficChart({ series, height = 220 }) {
  const points = series?.points ?? [];
  if (!points.length) return <Empty />;
  const step = series.step;
  const data = points.map((p) => ({
    t: p.bucket,
    label: axisTime(p.bucket, step),
    '2xx': p.c2xx ?? 0,
    '3xx': p.c3xx ?? 0,
    '4xx': p.c4xx ?? 0,
    '5xx': p.c5xx ?? 0,
  }));
  return (
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
        <Tooltip {...tooltipStyle} formatter={(v, n) => [num(v), n]} />
        <Legend wrapperStyle={{ fontSize: 11.5, paddingTop: 6 }} iconType="circle" iconSize={7} />
        {[['2xx', 'green'], ['3xx', 'blue'], ['4xx', 'amber'], ['5xx', 'red']].map(([k, c]) => (
          <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={`var(--${c})`}
                strokeWidth={1.2} fill={`url(#g-${k})`} isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Bandwidth served over the same buckets. */
export function BandwidthChart({ series, height = 180 }) {
  const points = series?.points ?? [];
  if (!points.length) return <Empty />;
  const data = points.map((p) => ({
    label: axisTime(p.bucket, series.step),
    out: p.bytes_out ?? 0,
  }));
  return (
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
        <Tooltip {...tooltipStyle} formatter={(v) => [bytes(v), 'Sent']} />
        <Area type="monotone" dataKey="out" stroke="var(--violet)" strokeWidth={1.3}
              fill="url(#g-bw)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
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
