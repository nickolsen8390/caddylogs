const nf = new Intl.NumberFormat();
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const num = (n) => (n === null || n === undefined ? '—' : nf.format(Math.round(n)));

/** Compact form for dense stat cards: 12.4k, 3.1M. */
export function compact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return nf.format(Math.round(n));
  if (abs < 1e6) return `${nf1.format(n / 1e3)}k`;
  if (abs < 1e9) return `${nf1.format(n / 1e6)}M`;
  return `${nf1.format(n / 1e9)}B`;
}

export function bytes(b) {
  if (b === null || b === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const sign = b < 0 ? '-' : '';
  return `${sign}${i === 0 ? Math.round(v) : nf1.format(v)} ${units[i]}`;
}

export function ms(v) {
  if (v === null || v === undefined) return '—';
  if (v < 1) return `${Math.round(v * 1000)} µs`;
  if (v < 1000) return `${nf1.format(v)} ms`;
  return `${nf1.format(v / 1000)} s`;
}

export const pct = (v, digits = 1) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;

export function relative(tsMs) {
  if (!tsMs) return '—';
  const diff = Date.now() - tsMs;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 45_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.round(abs / 86_400_000)}d ${suffix}`;
  return new Date(tsMs).toLocaleDateString();
}

export const clock = (tsMs) =>
  new Date(tsMs).toLocaleTimeString(undefined, { hour12: false }) +
  '.' +
  String(new Date(tsMs).getMilliseconds()).padStart(3, '0');

export const dateTime = (tsMs) =>
  tsMs ? new Date(tsMs).toLocaleString(undefined, { hour12: false }) : '—';

/** Axis label appropriate to the bucket size. */
export function axisTime(bucketSec, stepSec) {
  const d = new Date(bucketSec * 1000);
  if (stepSec < 3600) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (stepSec < 86400) return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Percentage change between two totals, guarding division by zero. */
export function delta(current, previous) {
  if (!previous) return current ? null : 0;
  return (current - previous) / previous;
}

export const statusClass = (s) => `st-${Math.floor((s || 0) / 100)}`;
