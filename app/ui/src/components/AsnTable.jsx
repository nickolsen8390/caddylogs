import { useState } from 'react';
import { api, qs } from '../lib/api.js';
import { Chip, Empty } from './ui.jsx';
import { bytes, compact, dateTime, num, relative } from '../lib/format.js';
import { countryName, flag } from '../lib/countries.js';

const COLSPAN = 9;

/**
 * Networks table with a per-ASN drill-down. The registry detail behind each
 * row (RIR, description, raw WHOIS, originated prefix counts) is fetched once
 * per ASN by the ingester, so expanding a row is a cheap local read.
 */
export function AsnTable({ rows, host, range }) {
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});

  if (!rows?.length) return <Empty>No ASN data available yet.</Empty>;

  async function toggle(asn) {
    if (asn === '0') return; // the unresolved bucket has nothing to show
    if (open === asn) {
      setOpen(null);
      return;
    }
    setOpen(asn);
    if (detail[asn] === undefined) {
      setDetail((d) => ({ ...d, [asn]: null }));
      try {
        const res = await api.get(`/api/asn/${asn}${qs({ host, range })}`);
        setDetail((d) => ({ ...d, [asn]: res }));
      } catch {
        setDetail((d) => ({ ...d, [asn]: { error: true } }));
      }
    }
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th>Organisation</th>
            <th>ASN</th>
            <th>Name</th>
            <th>RIR</th>
            <th>Registered</th>
            <th className="num">Prefixes v4/v6</th>
            <th className="num">Requests</th>
            <th className="num">Bytes</th>
            <th className="num">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const expandable = a.asn !== '0';
            const d = detail[a.asn];
            return [
              <tr
                key={a.asn}
                onClick={() => toggle(a.asn)}
                style={{ cursor: expandable ? 'pointer' : 'default' }}
                title={expandable ? 'Click for registry detail' : undefined}
              >
                <td className="cell-wide">
                  <span className="truncate" title={a.description || a.org}>
                    {expandable && <span className="faint">{open === a.asn ? '▾ ' : '▸ '}</span>}
                    {a.org}
                  </span>
                </td>
                <td className="mono">{a.asn === '0' ? '—' : `AS${a.asn}`}</td>
                <td className="dim mono">{a.as_name ?? '—'}</td>
                <td className="dim">{a.rir ?? '—'}</td>
                <td className="dim" title={a.as_country ? countryName(a.as_country) : undefined}>
                  {a.as_country ? `${flag(a.as_country)} ${a.as_country}` : '—'}
                </td>
                <td className="num dim">
                  {a.prefix_v4 === null || a.prefix_v4 === undefined
                    ? '—'
                    : `${num(a.prefix_v4)} / ${num(a.prefix_v6 ?? 0)}`}
                </td>
                <td className="num">{num(a.requests)}</td>
                <td className="num">{bytes(a.bytes)}</td>
                <td className="num">{compact(a.errors)}</td>
              </tr>,

              open === a.asn ? (
                <tr key={`${a.asn}-detail`}>
                  <td colSpan={COLSPAN} style={{ background: 'var(--panel-2)', padding: 14 }}>
                    {d === null || d === undefined ? (
                      <span className="faint">Loading registry detail…</span>
                    ) : d.error ? (
                      <span className="faint">Could not load detail for AS{a.asn}.</span>
                    ) : (
                      <AsnDetailBody asn={a.asn} data={d} />
                    )}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function AsnDetailBody({ asn, data }) {
  const info = data.info ?? {};
  const addresses = data.addresses ?? [];

  return (
    <div className="vstack" style={{ gap: 12 }}>
      <div className="hstack">
        <Chip tone="info">AS{asn}</Chip>
        {info.rir && <Chip>{info.rir}</Chip>}
        {info.country && (
          <Chip title={countryName(info.country)}>
            {flag(info.country)} registered in {info.country}
          </Chip>
        )}
        {info.prefix_v4 !== null && info.prefix_v4 !== undefined && (
          <Chip title="Prefixes originated by this AS, per notoolkit's RouteViews import">
            {num(info.prefix_v4)} IPv4 / {num(info.prefix_v6 ?? 0)} IPv6 prefixes
          </Chip>
        )}
        {info.detail_at && (
          <span className="faint" style={{ fontSize: 11 }}>
            registry data fetched {relative(info.detail_at)}
          </span>
        )}
        {info.detail_error && <Chip tone="warn">{info.detail_error}</Chip>}
      </div>

      {info.description && (
        <div>
          <div className="stat-label">Description</div>
          <div className="dim">{info.description}</div>
        </div>
      )}

      <div className="grid cols-2" style={{ gap: 14 }}>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>
            Addresses seen from this network ({num(addresses.length)}
            {addresses.length >= 200 ? '+' : ''})
          </div>
          {addresses.length ? (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table className="data">
                <tbody>
                  {addresses.map((r) => (
                    <tr key={r.ip}>
                      <td className="mono cell-wide">
                        <span className="truncate">{r.ip}</span>
                      </td>
                      <td className="dim mono">{r.as_prefix ?? '—'}</td>
                      <td className="dim">
                        {r.country ? `${flag(r.country)} ${r.country}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <span className="faint">None cached.</span>
          )}
        </div>

        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>
            WHOIS
            {info.whois_raw ? (
              <span className="faint"> (first 4 KB, as returned by the RIR)</span>
            ) : null}
          </div>
          {info.whois_raw ? (
            <pre className="log-json" style={{ maxHeight: 220, margin: 0 }}>
              {info.whois_raw}
            </pre>
          ) : (
            <span className="faint">
              Not fetched yet — the background worker collects this once per ASN.
            </span>
          )}
        </div>
      </div>

      {info.updated_at ? (
        <span className="faint" style={{ fontSize: 11 }}>
          First counted {dateTime(info.updated_at)}
        </span>
      ) : null}
    </div>
  );
}
