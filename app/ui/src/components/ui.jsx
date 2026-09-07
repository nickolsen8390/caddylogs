import { Link } from 'react-router-dom';
import { compact, num, pct, delta as pctDelta } from '../lib/format.js';
import { drillTo } from '../lib/drill.js';

export function Panel({ title, actions, children, flush = false, className = '', style }) {
  return (
    <section className={`panel ${className}`} style={style}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          <span className="spacer" />
          {actions}
        </header>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

/**
 * @param {object} p
 * @param {boolean} [p.inverted] true when an increase is bad (errors, latency)
 */
export function Stat({ label, value, sub, previous, current, inverted = false, tone }) {
  const d = previous === undefined ? null : pctDelta(current, previous);
  const dir = d === null ? 'flat' : d > 0.001 ? 'up' : d < -0.001 ? 'down' : 'flat';
  return (
    <div className="panel stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
      <span className="stat-sub">
        {d !== null && d !== 0 && (
          <span className={`delta ${dir}${inverted ? ' inverted' : ''}`}>
            {d > 0 ? '▲' : '▼'} {pct(Math.abs(d), 0)}
          </span>
        )}
        {sub && <span className="dim">{sub}</span>}
      </span>
    </div>
  );
}

export function Chip({ tone, children, title }) {
  return (
    <span className={`chip${tone ? ` ${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Banner({ level = 'info', title, children }) {
  return (
    <div className={`banner ${level}`} role={level === 'error' ? 'alert' : undefined}>
      <span aria-hidden="true">{level === 'error' ? '⛔' : level === 'warn' ? '⚠️' : 'ℹ️'}</span>
      <div>
        {title && <div className="banner-title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children = 'No data in this period.' }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Loading({ rows = 4 }) {
  return (
    <div className="vstack" style={{ padding: 12 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 14, width: `${95 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Ranked list with an inline proportional bar. Used for every "top N" panel so
 * relative weight is readable without a separate chart.
 *
 * Pass `dim` (and optionally `context`) to make every row a link to the
 * individual requests behind it — that is how the whole app becomes drillable
 * without each caller wiring its own navigation.
 */
export function TopList({
  rows,
  valueKey = 'requests',
  format = compact,
  render,
  empty,
  onRowClick,
  dim,
  context,
}) {
  if (!rows?.length) return <Empty>{empty ?? 'Nothing recorded yet.'}</Empty>;
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);

  return (
    <table className="data">
      <tbody>
        {rows.map((r, i) => {
          const v = Number(r[valueKey]) || 0;
          const raw = r.value ?? r.host ?? r.country ?? null;
          const to = dim && !render ? drillTo(dim, raw, context) : null;
          const label = render ? render(r) : (raw ?? '—');
          return (
            <tr
              key={`${raw ?? r.asn ?? i}`}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              <td className="bar-cell cell-wide">
                <span className="bar-fill" style={{ width: `${(v / max) * 100}%` }} />
                <span className="bar-label truncate" title={String(raw ?? '')}>
                  {to ? (
                    <Link to={to} title={`Show the requests behind this`}>
                      {label}
                    </Link>
                  ) : (
                    label
                  )}
                </span>
              </td>
              <td className="num">{format(v)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Compact status-code strip: colour-coded share of the total. */
export function StatusStrip({ totals }) {
  if (!totals) return null;
  const parts = [
    ['2xx', totals.c2xx, 'var(--green)'],
    ['3xx', totals.c3xx, 'var(--blue)'],
    ['4xx', totals.c4xx, 'var(--amber)'],
    ['5xx', totals.c5xx, 'var(--red)'],
    ['1xx', totals.c1xx, 'var(--text-faint)'],
  ].filter(([, n]) => n > 0);
  const sum = parts.reduce((s, [, n]) => s + n, 0) || 1;
  return (
    <div className="vstack" style={{ gap: 10 }}>
      <div style={{ display: 'flex', height: 9, borderRadius: 5, overflow: 'hidden', gap: 1 }}>
        {parts.map(([label, n, color]) => (
          <div
            key={label}
            style={{ width: `${(n / sum) * 100}%`, background: color }}
            title={`${label}: ${num(n)} (${pct(n / sum)})`}
          />
        ))}
      </div>
      <div className="hstack" style={{ gap: 12, fontSize: 11.5 }}>
        {parts.map(([label, n, color]) => (
          <span key={label} className="hstack" style={{ gap: 5 }}>
            <span className="status-dot" style={{ background: color }} />
            <span className="dim">{label}</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{compact(n)}</strong>
            <span className="faint">{pct(n / sum, 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Icon({ name }) {
  const paths = {
    dashboard: 'M3 3h7v7H3V3zm11 0h7v4h-7V3zM3 14h7v7H3v-7zm11-3h7v10h-7V11z',
    domains: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 0c3 3 3 17 0 20M2.5 9h19M2.5 15h19',
    requests: 'M10 4h11M10 12h11M10 20h11M4 4h.01M4 12h.01M4 20h.01',
    stream: 'M4 6h16M4 12h10M4 18h13',
    health: 'M3 12h4l2 6 4-14 2 8h6',
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.dashboard} />
    </svg>
  );
}
