import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCaddy } from './CaddyLayout.jsx';
import {
  addressHost, clone, findAll, findAllowlist, importsOf, newSite, proxies, quote, siteLabel,
  tlsMode, unquote, upstreamsOf,
} from '../../lib/caddyfile.js';
import { Banner, Chip, Empty, Panel } from '../../components/ui.jsx';
import { ListEditor, Modal, PromptModal, Toggle } from '../../components/caddy.jsx';

/** One-line description of what a site does, for the list. */
export function describeSite(it) {
  const body = it.body;
  const ups = proxies(body).flatMap(upstreamsOf).map(unquote);
  let what;
  if (ups.length) what = { kind: 'proxy', text: `→ ${[...new Set(ups)].join(', ')}` };
  else if (findAll(body, 'file_server').length) {
    const root = findAll(body, 'root')[0];
    what = { kind: 'files', text: `static files${root ? ` from ${unquote(root.tokens[root.tokens.length - 1])}` : ''}` };
  } else if (findAll(body, 'redir').length) {
    const r = findAll(body, 'redir')[0];
    what = { kind: 'redirect', text: `redirect → ${unquote(r.tokens.find((t, i) => i > 0 && !t.startsWith('@')) ?? '')}` };
  } else if (findAll(body, 'php_fastcgi').length) {
    what = { kind: 'php', text: `PHP → ${unquote(findAll(body, 'php_fastcgi')[0].tokens[1] ?? '')}` };
  } else if (findAll(body, 'respond').length) {
    what = { kind: 'respond', text: `responds ${findAll(body, 'respond')[0].tokens.slice(1).map(unquote).join(' ')}` };
  } else {
    what = { kind: 'other', text: `${body.filter((n) => n.type === 'directive').length} directives` };
  }
  const badges = [];
  const allow = findAllowlist(body);
  if (allow) badges.push({ tone: 'info', text: `IP allowlist (${allow.ranges.length})`, title: allow.ranges.map(unquote).join(' ') });
  const tls = tlsMode(body);
  if (tls.mode !== 'auto') badges.push({ text: tls.mode === 'internal' ? 'internal CA' : `tls: ${tls.mode}` });
  if (findAll(body, 'basic_auth').length || findAll(body, 'basicauth').length) badges.push({ text: 'password' });
  if (findAll(body, 'flush_interval').length) badges.push({ text: 'streaming' });
  for (const imp of importsOf(body)) badges.push({ text: `+ ${imp}`, title: `import ${imp}` });
  return { ...what, badges };
}

export default function Sites() {
  const { model, parseError, canEdit, update } = useCaddy();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [duplicating, setDuplicating] = useState(null);

  const sites = useMemo(
    () => (model ? model.items.map((it, index) => ({ it, index })).filter((x) => x.it.type === 'site') : []),
    [model]
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter(({ it }) => {
      const d = describeSite(it);
      return siteLabel(it).toLowerCase().includes(needle) || d.text.toLowerCase().includes(needle);
    });
  }, [sites, q]);

  if (parseError) {
    return (
      <Banner level="error" title="The Caddyfile could not be parsed">
        {parseError.message}. <Link to={`/caddy/raw${parseError.line ? `?line=${parseError.line}` : ''}`}>Fix it in the Caddyfile editor</Link>.
      </Banner>
    );
  }

  const snippets = model.items.filter((x) => x.type === 'snippet').map((x) => x.name);
  const existingHosts = new Set(sites.flatMap(({ it }) => it.addresses.map((a) => unquote(a).toLowerCase())));

  const setDisabled = (index, disabled) =>
    update((m) => {
      const it = clone(m.items[index]);
      it.raw = null;
      delete it.rawIncludesLeading;
      it.disabled = disabled;
      m.items[index] = it;
      return m;
    });

  const remove = (index) =>
    update((m) => {
      m.items.splice(index, 1);
      return m;
    });

  return (
    <>
      <div className="hstack" style={{ marginBottom: 12 }}>
        <input
          className="input"
          style={{ width: 280 }}
          placeholder="Filter by domain or upstream"
          value={q}
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
        />
        <span className="faint" style={{ fontSize: 12 }}>
          {sites.length} site{sites.length === 1 ? '' : 's'}
          {sites.some((s) => s.it.disabled) ? ` · ${sites.filter((s) => s.it.disabled).length} disabled` : ''}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn primary" disabled={!canEdit} onClick={() => setAdding(true)}>+ Add site</button>
      </div>

      <Panel flush>
        {shown.length ? (
          <table className="data sites-table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Enabled</th>
                <th>Addresses</th>
                <th>Handles requests by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ it, index }) => {
                const d = describeSite(it);
                return (
                  <tr key={index} className={it.disabled ? 'row-disabled' : undefined}>
                    <td>
                      <label className="switch" title={it.disabled ? 'Disabled (commented out) — click to enable' : 'Enabled — click to disable (comments it out)'}>
                        <input
                          type="checkbox"
                          checked={!it.disabled}
                          disabled={!canEdit}
                          onChange={(e) => setDisabled(index, !e.target.checked)}
                        />
                        <span />
                      </label>
                    </td>
                    <td>
                      <div className="vstack" style={{ gap: 2 }}>
                        {it.addresses.map((a, k) => {
                          const host = addressHost(a);
                          return (
                            <span key={k} className="hstack" style={{ gap: 6 }}>
                              <Link to={`/caddy/sites/${index}`} className="mono site-addr">{unquote(a)}</Link>
                              {host && (
                                <Link to={`/domains/${encodeURIComponent(host)}`} className="faint stats-link" title="Traffic statistics for this domain">
                                  stats
                                </Link>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      <div className="vstack" style={{ gap: 4 }}>
                        <span className="mono">{d.text}</span>
                        {d.badges.length > 0 && (
                          <span className="hstack" style={{ gap: 4 }}>
                            {d.badges.map((b, k) => <Chip key={k} tone={b.tone} title={b.title}>{b.text}</Chip>)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num">
                      <span className="hstack" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
                        <button className="btn sm" onClick={() => navigate(`/caddy/sites/${index}`)}>Edit</button>
                        <button className="btn sm" disabled={!canEdit} onClick={() => setDuplicating(index)} title="Duplicate">⧉</button>
                        <button
                          className="btn sm danger"
                          disabled={!canEdit}
                          title="Delete"
                          onClick={() => {
                            if (window.confirm(`Delete ${siteLabel(it)}? (You can review before it is applied.)`)) remove(index);
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>{q ? 'No site matches that filter.' : 'No sites in the Caddyfile yet.'}</Empty>
        )}
      </Panel>

      {adding && (
        <AddSiteModal
          snippets={snippets}
          existing={existingHosts}
          onClose={() => setAdding(false)}
          onAdd={(site) => {
            setAdding(false);
            update((m) => {
              m.items.push(site);
              return m;
            });
          }}
        />
      )}

      {duplicating != null && (
        <PromptModal
          title={`Duplicate ${siteLabel(model.items[duplicating])}`}
          label="Address(es) for the copy — separate several with commas"
          placeholder="new.example.com"
          confirm="Duplicate"
          validate={(v) => addressProblem(v, existingHosts)}
          onClose={() => setDuplicating(null)}
          onSubmit={(v) => {
            const at = duplicating;
            setDuplicating(null);
            update((m) => {
              const copy = clone(m.items[at]);
              copy.raw = null;
              delete copy.rawIncludesLeading;
              copy.leading = [];
              copy.gap = [''];
              copy.addresses = splitAddr(v).map(quote);
              m.items.splice(at + 1, 0, copy);
              return m;
            });
          }}
        />
      )}
    </>
  );
}

const splitAddr = (v) => v.split(/[\s,]+/).filter(Boolean);

export function addressProblem(v, existing, own = new Set()) {
  const parts = splitAddr(v);
  if (!parts.length) return 'Enter at least one address.';
  for (const p of parts) {
    if (/[{}"#]/.test(p) && !/^\{\$?[\w.:-]+\}$/.test(p)) return `"${p}" is not a valid site address.`;
    if (existing.has(p.toLowerCase()) && !own.has(p.toLowerCase())) return `${p} is already defined by another site.`;
  }
  return null;
}

const KINDS = [
  { id: 'proxy', label: 'Reverse proxy', target: 'Upstream address(es)', placeholder: '10.0.0.5:80   or   https://10.0.0.5:8443' },
  { id: 'files', label: 'Static files', target: 'Directory (inside the Caddy container)', placeholder: '/srv/www' },
  { id: 'redirect', label: 'Redirect', target: 'Redirect to', placeholder: 'https://www.example.com{uri}' },
  { id: 'respond', label: 'Fixed response', target: 'Response body', placeholder: 'OK' },
];

function AddSiteModal({ snippets, existing, onAdd, onClose }) {
  const [addresses, setAddresses] = useState('');
  const [kind, setKind] = useState('proxy');
  const [target, setTarget] = useState('');
  const [imports, setImports] = useState(() => snippets.filter((s) => /log/i.test(s)));
  const [flush, setFlush] = useState(false);
  const [restrict, setRestrict] = useState(false);
  const [allow, setAllow] = useState([]);
  const [tlsInternal, setTlsInternal] = useState(false);
  const [permanent, setPermanent] = useState(true);
  const [browse, setBrowse] = useState(false);
  const [status, setStatus] = useState(200);

  const addrErr = addresses.trim() ? addressProblem(addresses, existing) : null;
  const k = KINDS.find((x) => x.id === kind);
  const valid = addresses.trim() && !addrErr && (kind === 'respond' || target.trim()) && (!restrict || allow.length);

  const create = () => {
    const site = newSite({
      addresses: splitAddr(addresses),
      kind,
      target: target.trim(),
      imports,
      allow: restrict ? allow : [],
      flush,
      extra: { permanent, browse, status },
    });
    if (tlsInternal) site.body.splice(imports.length, 0, { type: 'directive', tokens: ['tls', 'internal'], body: null, comment: null, gap: false });
    onAdd(site);
  };

  return (
    <Modal
      title="Add a site"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid} onClick={create}>Add site</button>
        </>
      }
    >
      <div className="vstack" style={{ gap: 14 }}>
        <div className="field">
          <label>Domain(s)</label>
          <input
            className="input mono"
            autoFocus
            placeholder="app.example.com, www.app.example.com"
            value={addresses}
            onChange={(e) => setAddresses(e.target.value)}
          />
          {addrErr && <span className="field-error">{addrErr}</span>}
          <span className="faint field-hint">
            Caddy obtains a certificate for each public name automatically. Use <code>http://name</code> for plain HTTP,
            or <code>:8080</code> to listen on a port for any host.
          </span>
        </div>

        <div className="field">
          <label>Type</label>
          <div className="seg">
            {KINDS.map((x) => (
              <button key={x.id} className={kind === x.id ? 'active' : ''} onClick={() => setKind(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>{k.target}</label>
          <input className="input mono" placeholder={k.placeholder} value={target} onChange={(e) => setTarget(e.target.value)} />
          {kind === 'proxy' && <span className="faint field-hint">Separate several upstreams with spaces to load-balance between them.</span>}
        </div>

        {kind === 'proxy' && (
          <Toggle checked={flush} onChange={setFlush} label="Streaming responses" hint="flush_interval -1 — needed for server-sent events and live logs" />
        )}
        {kind === 'redirect' && <Toggle checked={permanent} onChange={setPermanent} label="Permanent (301)" hint="otherwise temporary (302)" />}
        {kind === 'files' && <Toggle checked={browse} onChange={setBrowse} label="Directory listings" />}
        {kind === 'respond' && (
          <div className="field">
            <label>Status code</label>
            <input className="input" type="number" min={100} max={599} value={status} onChange={(e) => setStatus(Number(e.target.value))} style={{ width: 100 }} />
          </div>
        )}

        {snippets.length > 0 && (
          <div className="field">
            <label>Snippets to import</label>
            <div className="hstack">
              {snippets.map((s) => (
                <Toggle
                  key={s}
                  checked={imports.includes(s)}
                  label={s}
                  onChange={(on) => setImports(on ? [...imports, s] : imports.filter((x) => x !== s))}
                />
              ))}
            </div>
          </div>
        )}

        <Toggle checked={tlsInternal} onChange={setTlsInternal} label="Use Caddy's internal CA" hint="tls internal — for internal-only names that public ACME cannot validate" />

        <div className="vstack" style={{ gap: 8 }}>
          <Toggle checked={restrict} onChange={setRestrict} label="Only allow certain source addresses" hint="everyone else gets 403" />
          {restrict && <ListEditor values={allow} onChange={setAllow} placeholder="10.0.0.0/8 or 203.0.113.7" validate={ipProblem} />}
        </div>
      </div>
    </Modal>
  );
}

export function ipProblem(v) {
  if (v === 'private_ranges') return null;
  if (/^[0-9.]+(\/\d{1,2})?$/.test(v) || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(v) || /^\{.+\}$/.test(v)) return null;
  return `"${v}" is not an IP address or CIDR range.`;
}
