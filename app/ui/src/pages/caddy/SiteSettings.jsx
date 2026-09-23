// The Settings tab of the site editor: every common Caddy option as a form
// field with its own help, grouped by what it is for. Anything the forms do
// not cover is listed at the bottom and stays editable under "All directives".

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addressHost, directive, findAllowlist, importsOf, quote, setAllowlist, tlsMode, unquote,
} from '../../lib/caddyfile.js';
import {
  HANDLER_DIRS, HEADER_OPS, MODES, RULE_TYPES, argsOf, catchAll, container, countSet, hasMatcher,
  isDir, leadCount, mainNode, readHeaders, readRules, replaceNodes, setMode, siteMode,
  writeField, writeHeaders, writeRules,
} from '../../lib/caddyedit.js';
import {
  FILE_SERVER_FIELDS, PROXY_GROUPS, SITE_FIELDS, TLS_FIELDS, dropEmptyTls,
} from '../../lib/caddyschema.js';
import { DraftInput, Field, FieldGrid, Group, Help, Label, Section } from '../../components/caddyform.jsx';
import { ListEditor } from '../../components/caddy.jsx';
import { addressProblem, ipProblem } from './Sites.jsx';
import { api } from '../../lib/api.js';

/** Returns a writer for fields whose block is found by `locate(workingCopy)`. */
function writerFor(edit, locate, opts) {
  return (field, value) =>
    edit((it) => {
      const root = locate(it);
      if (root) writeField(root, field, value, opts);
    });
}

const siteRoot = (it) => it;

export default function SiteSettings({ site, edit, others, canEdit, snippets, showDirectives }) {
  const mode = siteMode(site);
  const sections = [
    ['domains', 'Domains'],
    ['handling', 'Handling'],
    ['rules', 'Path rules'],
    ['access', 'Access'],
    ['tls', 'HTTPS'],
    ['headers', 'Headers'],
    ['compression', 'Compression'],
    ['logging', 'Logging'],
    ['advanced', 'Advanced'],
  ];
  return (
    <fieldset disabled={!canEdit} className="plain-fieldset">
      <nav className="sec-nav" aria-label="Sections">
        {sections.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="btn sm"
            onClick={() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {label}
          </button>
        ))}
        <span className="faint" style={{ fontSize: 11.5 }}>Hover or focus any <span className="help-btn static">?</span> for what an option does and what to enter.</span>
      </nav>

      <div className="vstack" style={{ gap: 14 }}>
        <DomainsSection site={site} edit={edit} others={others} />
        <HandlingSection site={site} mode={mode} edit={edit} />
        <RulesSection site={site} edit={edit} />
        <AccessSection site={site} edit={edit} />
        <TlsSection site={site} edit={edit} />
        <HeadersSection site={site} edit={edit} />
        <CompressionSection site={site} edit={edit} />
        <LoggingSection site={site} edit={edit} snippets={snippets} />
        <AdvancedSection site={site} edit={edit} showDirectives={showDirectives} />
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
//  Domains
// ---------------------------------------------------------------------------

const ADDRESS_HELP = `The names (and optionally scheme or port) this site answers to. Caddy gets an HTTPS
certificate for each public name automatically. Use http://name for plain HTTP only, :8080 to
listen on a port for any host, or *.example.com for a wildcard (needs the DNS challenge).`;

function DomainsSection({ site, edit, others }) {
  const values = site.addresses.map(unquote);
  const problem = values.map((v) => addressProblem(v, others)).find(Boolean);
  const hosts = site.addresses.map(addressHost).filter(Boolean);
  return (
    <Section id="domains" title="Domains" help="Which addresses this site serves, and where Caddy listens for it.">
      <div className="f-grid">
        <div className="f-field wide">
          <Label field={{ label: 'Addresses', help: ADDRESS_HELP, example: 'app.example.com, www.app.example.com' }} />
          <ListEditor
            values={values}
            placeholder="another.example.com"
            addLabel="Add address"
            validate={(v) => addressProblem(v, new Set([...others, ...values.map((x) => x.toLowerCase())]))}
            onChange={(vals) => {
              if (!vals.length) return; // a site needs at least one address
              edit((it) => {
                it.addresses = vals.map(quote);
              });
            }}
          />
          {problem && <span className="field-error">{problem}</span>}
          {hosts.length > 0 && (
            <div className="hstack" style={{ fontSize: 12 }}>
              <span className="faint">Traffic statistics:</span>
              {hosts.map((h) => <Link key={h} to={`/domains/${encodeURIComponent(h)}`}>{h}</Link>)}
            </div>
          )}
        </div>
        <Field root={site} field={SITE_FIELDS.bind} onWrite={(v) => writerFor(edit, siteRoot, { top: true })(SITE_FIELDS.bind, v)} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
//  Handling: what the site does with a request
// ---------------------------------------------------------------------------

function HandlingSection({ site, mode, edit }) {
  const choose = (m) => {
    if (m === mode) return;
    if (mode !== 'none' && !window.confirm(`Switch this site to "${MODES.find((x) => x.id === m).label}"? Its current ${MODES.find((x) => x.id === mode).label.toLowerCase()} settings are removed (you can review before applying).`)) return;
    edit((it) => setMode(it, m));
  };
  return (
    <Section id="handling" title="What this site does" help="The main job of this site. Path rules below can handle parts of the site differently.">
      <div className="mode-cards" role="radiogroup" aria-label="Site type">
        {MODES.filter((m) => m.id !== 'none' || mode === 'none').map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`mode-card${mode === m.id ? ' active' : ''}`}
            onClick={() => choose(m.id)}
          >
            <strong>{m.label}</strong>
            <span>{m.help}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        {mode === 'proxy' && (
          <ProxyEditor
            node={mainNode(site, 'reverse_proxy')}
            locate={(it) => mainNode(it, 'reverse_proxy')}
            edit={edit}
          />
        )}
        {mode === 'static' && <StaticEditor site={site} edit={edit} />}
        {mode === 'php' && <PhpEditor site={site} edit={edit} />}
        {mode === 'redirect' && <RedirectEditor site={site} edit={edit} />}
        {mode === 'respond' && <RespondEditor site={site} edit={edit} />}
      </div>
    </Section>
  );
}

// --- reverse proxy -------------------------------------------------------------

function upstreamsOfNode(n) {
  const a = argsOf(n);
  const ups = hasMatcher(n) ? a.slice(1) : a;
  const to = n.body?.find((x) => isDir(x, 'to'));
  return to ? [...ups, ...argsOf(to)] : ups;
}

function writeUpstreams(n, vals) {
  const head = [n.tokens[0], ...(hasMatcher(n) ? [n.tokens[1]] : [])];
  if (n.body?.some((x) => isDir(x, 'to'))) {
    n.tokens = head;
    replaceNodes(n.body, (x) => isDir(x, 'to'), vals.length ? [directive(['to', ...vals.map(quote)])] : [], 0);
  } else {
    n.tokens = [...head, ...vals.map(quote)];
  }
}

const HOST_FIELD = {
  id: 'host', type: 'flag', label: "Send the upstream's own host name as Host",
  help: `By default the upstream receives the Host the visitor asked for. Turn this on when the upstream
    only answers to its own name — typical for https:// upstreams and hosted services.`,
  example: 'header_up Host {upstream_hostport}',
  read: (n) => Boolean(n.body?.some((x) => isDir(x, 'header_up') && unquote(x.tokens[1]) === 'Host' && unquote(x.tokens[2] ?? '') === '{upstream_hostport}')),
  write: (n, on) => {
    n.body = (n.body ?? []).filter((x) => !(isDir(x, 'header_up') && unquote(x.tokens[1]) === 'Host'));
    if (on) n.body.push(directive(['header_up', 'Host', '{upstream_hostport}']));
  },
};

const PROXY_VIEW = PROXY_GROUPS.map((g) =>
  g.id === 'headers'
    ? {
        ...g,
        fields: [
          HOST_FIELD,
          ...g.fields.map((f) =>
            f.id === 'header_up'
              ? { ...f, pred: (n) => !(unquote(n.tokens[1]) === 'Host' && unquote(n.tokens[2] ?? '') === '{upstream_hostport}') }
              : f
          ),
        ],
      }
    : g
);

export function ProxyEditor({ node, locate, edit, showUpstreams = true }) {
  if (!node) return null;
  const write = writerFor(edit, locate, { rootNullable: true });
  const ups = upstreamsOfNode(node);
  const https = ups.some((u) => u.startsWith('https://'));
  return (
    <div className="vstack" style={{ gap: 10 }}>
      {showUpstreams && (
        <div className="f-field wide">
          <Label
            field={{
              label: 'Upstreams',
              help: `The backend server(s) requests are sent to: host:port, or a full URL. Use https:// for a
                backend that expects TLS. With several, Caddy spreads requests between them (see Load balancing).`,
              example: '10.40.10.51:80  or  https://10.0.0.5:8443  or  unix//run/app.sock',
              dir: 'reverse_proxy',
            }}
          />
          <ListEditor
            values={ups}
            placeholder="10.0.0.5:80  or  https://host:8443"
            addLabel="Add upstream"
            onChange={(vals) => edit((it) => writeUpstreams(locate(it), vals))}
          />
          {!ups.length && <span className="field-error">A reverse proxy needs at least one upstream.</span>}
          {https && (
            <span className="field-hint faint">
              HTTPS upstream: if it uses a self-signed certificate, turn on "Don't verify the upstream's certificate" under
              Connection to the upstream.
            </span>
          )}
        </div>
      )}
      {PROXY_VIEW.map((g) => (
        <Group key={g.id} title={g.title} help={g.help} count={countSet(node, g.fields)}>
          <FieldGrid root={node} fields={g.fields} onWrite={write} />
        </Group>
      ))}
    </div>
  );
}

// --- static files ------------------------------------------------------------------

/** Index of the first match, or the end of the list. */
const indexOr = (list, pred) => {
  const i = list.findIndex(pred);
  return i < 0 ? list.length : i;
};

const ROOT_FIELD = {
  id: 'root', type: 'text', label: 'Folder to serve', dir: 'root',
  help: `Directory inside the Caddy container holding the files. Host folders must be mounted into the
    caddy service in docker-compose.yml first, e.g. /srv/www.`,
  placeholder: '/srv', example: '/srv/www',
  read: (it) => {
    const n = mainNode(it, 'root');
    const a = n ? argsOf(n) : [];
    return a[a.length - 1] ?? '';
  },
  write: (it, v) => {
    const c = container(it);
    const n = mainNode(it, 'root');
    if (!v.trim()) {
      if (n) c.splice(c.indexOf(n), 1);
      return;
    }
    const nd = directive(['root', '*', quote(v.trim())]);
    if (n) c[c.indexOf(n)] = { ...n, tokens: nd.tokens };
    else c.splice(indexOr(c, (x) => isDir(x, ['file_server', 'php_fastcgi'])), 0, nd);
  },
};

const SPA_FIELD = {
  id: 'spa', type: 'flag', label: 'Single-page app fallback',
  help: `Serve /index.html for paths that do not match a file, so client-side routing (React, Vue,
    Angular…) works on reload and deep links.`,
  example: 'try_files {path} /index.html', dir: 'try_files',
  read: (it) => Boolean(mainNode(it, 'try_files')),
  write: (it, on) => {
    const c = container(it);
    const n = mainNode(it, 'try_files');
    if (n) c.splice(c.indexOf(n), 1);
    if (on) c.splice(indexOr(c, (x) => isDir(x, 'file_server')), 0, directive(['try_files', '{path}', '/index.html']));
  },
};

function StaticEditor({ site, edit }) {
  const fs = mainNode(site, 'file_server');
  return (
    <div className="vstack" style={{ gap: 10 }}>
      <div className="f-grid">
        <Field root={site} field={ROOT_FIELD} onWrite={writerFor(edit, siteRoot).bind(null, ROOT_FIELD)} />
        <Field root={site} field={SPA_FIELD} onWrite={writerFor(edit, siteRoot).bind(null, SPA_FIELD)} />
      </div>
      <Group title="File server options" help="How files are listed, found and sent." count={countSet(fs, FILE_SERVER_FIELDS)}>
        <FieldGrid root={fs} fields={FILE_SERVER_FIELDS} onWrite={writerFor(edit, (it) => mainNode(it, 'file_server'), { rootNullable: true })} />
      </Group>
    </div>
  );
}

// --- PHP ---------------------------------------------------------------------------

const PHP_FIELDS = [
  {
    id: 'php_up', type: 'list', listLike: true, label: 'PHP-FPM server', dir: 'php_fastcgi',
    help: `Address of the PHP-FPM service: host:port (usually port 9000) or a unix socket. Several are load-balanced.`,
    example: 'php:9000  or  unix//run/php/php-fpm.sock',
    read: (n) => (hasMatcher(n) ? argsOf(n).slice(1) : argsOf(n)),
    write: (n, vals) => {
      n.tokens = [n.tokens[0], ...(hasMatcher(n) ? [n.tokens[1]] : []), ...vals.map(quote)];
    },
  },
  {
    id: 'php_index', dir: 'index', type: 'text', label: 'Front controller',
    help: 'The PHP file that handles requests for paths that are not files (the app\'s router).', placeholder: 'index.php', example: 'index.php',
  },
  {
    id: 'php_env', dir: 'env', type: 'rows', label: 'Environment variables',
    help: 'Extra variables passed to PHP ($_SERVER), e.g. to tell an app it is behind HTTPS.',
    columns: [{ label: 'Name', placeholder: 'APP_ENV' }, { label: 'Value', placeholder: 'production', rest: true, optional: true }],
    example: 'APP_ENV production',
  },
];

function PhpEditor({ site, edit }) {
  const php = mainNode(site, 'php_fastcgi');
  return (
    <div className="vstack" style={{ gap: 10 }}>
      <div className="f-grid">
        <Field root={site} field={{ ...ROOT_FIELD, help: `${ROOT_FIELD.help} For PHP this is the app's public folder, as PHP-FPM sees it too.` }} onWrite={writerFor(edit, siteRoot).bind(null, ROOT_FIELD)} />
      </div>
      <FieldGrid root={php} fields={PHP_FIELDS} onWrite={writerFor(edit, (it) => mainNode(it, 'php_fastcgi'), { rootNullable: true })} />
    </div>
  );
}

// --- redirect / fixed response ----------------------------------------------------

const REDIRECT_FIELDS = [
  {
    id: 'to', type: 'text', label: 'Send visitors to', dir: 'redir',
    help: `The address to redirect to. Add {uri} to keep the path and query, so /page?x=1 goes to the same page on the new site.`,
    placeholder: 'https://example.com{uri}', example: 'https://www.example.com{uri}',
    read: (n) => argsOf(n)[0] ?? '',
    write: (n, v) => { n.tokens = ['redir', quote(v || '/'), ...n.tokens.slice(2)]; },
  },
  {
    id: 'code', type: 'select', label: 'Kind of redirect',
    help: `Permanent (301) tells browsers and search engines the move is for good — they remember it. Use
      temporary while testing. 307/308 also keep the request method (important for form posts).`,
    options: [
      { value: '', label: 'Temporary — 302 (default)' },
      { value: 'permanent', label: 'Permanent — 301' },
      { value: '307', label: 'Temporary, keep method — 307' },
      { value: '308', label: 'Permanent, keep method — 308' },
      { value: 'html', label: 'HTML page with a meta refresh' },
    ],
    read: (n) => argsOf(n)[1] ?? '',
    write: (n, v) => { n.tokens = [...n.tokens.slice(0, 2), ...(v ? [v] : [])]; },
  },
];

function RedirectEditor({ site, edit }) {
  return <FieldGrid root={mainNode(site, 'redir')} fields={REDIRECT_FIELDS} onWrite={writerFor(edit, (it) => mainNode(it, 'redir'))} />;
}

function respondParts(n) {
  const a = argsOf(n);
  if (a.length === 1 && /^\d{3}$/.test(a[0])) return { body: '', status: a[0] };
  return { body: a[0] ?? '', status: a[1] ?? '' };
}
function writeRespond(n, parts) {
  n.tokens = ['respond', ...(parts.body ? [quote(parts.body)] : []), ...(parts.status ? [parts.status] : [])];
}

const RESPOND_FIELDS = [
  {
    id: 'status', type: 'text', kind: 'status', label: 'Status code', dir: 'respond',
    help: 'HTTP status to answer with: 200 OK, 204 No Content, 403 Forbidden, 404 Not Found, 503 Unavailable (maintenance)…',
    placeholder: '200', example: '503',
    read: (n) => respondParts(n).status,
    write: (n, v) => writeRespond(n, { ...respondParts(n), status: v.trim() }),
  },
  {
    id: 'body', type: 'text', label: 'Response text', mono: false,
    help: 'Text sent as the body. Placeholders work, e.g. {remote_host} or {time.now}.',
    placeholder: '(empty)', example: 'Down for maintenance, back soon',
    read: (n) => respondParts(n).body,
    write: (n, v) => writeRespond(n, { ...respondParts(n), body: v }),
  },
  {
    id: 'close', dir: 'close', type: 'flag', label: 'Close the connection afterwards',
    help: 'Close the client connection after responding, instead of keeping it alive.',
  },
];

function RespondEditor({ site, edit }) {
  return <FieldGrid root={mainNode(site, 'respond')} fields={RESPOND_FIELDS} onWrite={writerFor(edit, (it) => mainNode(it, 'respond'), { rootNullable: true })} />;
}

// ---------------------------------------------------------------------------
//  Path rules
// ---------------------------------------------------------------------------

const RULE_DEFAULTS = {
  redirect: { path: '/old-path', target: '/new-path', code: 'permanent' },
  rewrite: { path: '/old-path', target: '/new-path' },
  respond: { path: '/path', status: '404', body: '' },
  block: { path: '/wp-login.php' },
  proxy: { path: '/api/*', target: 'localhost:8081', strip: false },
  files: { path: '/static/*', target: '/srv/static', strip: true },
};

function RulesSection({ site, edit }) {
  const rules = readRules(site);
  const [adding, setAdding] = useState('redirect');
  const [open, setOpen] = useState(null);
  const save = (next) => edit((it) => writeRules(it, next));
  const change = (i, patch) => save(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <Section
      id="rules"
      title="Path rules"
      count={rules.length}
      help={`Handle parts of this site differently from the rest: redirect an old URL, send /api/* to another
        backend, block a path. Paths match exactly unless they end in *, e.g. /api/* matches /api/users.`}
    >
      <div className="vstack" style={{ gap: 8 }}>
        {!rules.length && <span className="faint" style={{ fontSize: 12.5 }}>No path rules. Every request goes to the main handler above.</span>}
        {rules.map((r, i) => {
          const t = RULE_TYPES.find((x) => x.id === r.type);
          return (
            <div key={i} className="rule">
              <div className="rule-row">
                <select className="input" value={r.type} onChange={(e) => change(i, { ...RULE_DEFAULTS[e.target.value], path: r.path, type: e.target.value })} title={t.help}>
                  {RULE_TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
                <DraftInput className="input mono" value={r.path} placeholder="/path/*" onChange={(v) => change(i, { path: v })} title="Path to match" />
                <RuleTarget rule={r} onChange={(p) => change(i, p)} />
                <Help text={t.help + ' ' + RULE_HELP[r.type]} />
                {r.type === 'proxy' && (
                  <button type="button" className="btn sm" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? 'Hide options' : 'Options'}
                  </button>
                )}
                <button type="button" className="btn sm danger" title="Remove rule" onClick={() => save(rules.filter((_, k) => k !== i))}>✕</button>
              </div>
              {r.type === 'proxy' && open === i && (
                <div className="rule-options">
                  <ProxyEditor
                    node={r.node.body.find((x) => isDir(x, 'reverse_proxy'))}
                    locate={(it) => readRules(it)[i]?.node.body.find((x) => isDir(x, 'reverse_proxy'))}
                    edit={edit}
                    showUpstreams={false}
                  />
                </div>
              )}
            </div>
          );
        })}
        <div className="hstack">
          <select className="input" value={adding} onChange={(e) => setAdding(e.target.value)} style={{ width: 200 }}>
            {RULE_TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <button type="button" className="btn sm" onClick={() => save([...rules, { type: adding, ...RULE_DEFAULTS[adding] }])}>
            + Add rule
          </button>
          <Help text={RULE_TYPES.find((x) => x.id === adding).help} />
        </div>
      </div>
    </Section>
  );
}

const RULE_HELP = {
  redirect: 'Target can be a path or a full URL; {uri} inserts the original path. Codes: permanent (301), temporary (302), 307, 308.',
  rewrite: 'Target is the new path, e.g. /index.php?page={path}. The rest of the site then handles the rewritten request.',
  respond: 'Status such as 403, 404 or 410; text is optional.',
  block: 'Nothing is sent back; the client sees a dropped connection.',
  proxy: 'Upstream as host:port or URL. "Strip path" removes the matched prefix before proxying, so /api/users reaches the backend as /users.',
  files: 'Folder inside the Caddy container. "Strip path" serves /static/app.css from <folder>/app.css.',
};

function RuleTarget({ rule, onChange }) {
  const strip = (
    <label className="check" title="Remove the matched path prefix before handling">
      <input type="checkbox" checked={Boolean(rule.strip)} onChange={(e) => onChange({ strip: e.target.checked })} />
      <span>Strip path</span>
    </label>
  );
  switch (rule.type) {
    case 'redirect':
      return (
        <>
          <DraftInput className="input mono" value={rule.target} placeholder="https://example.com{uri}" onChange={(v) => onChange({ target: v })} />
          <select className="input" value={rule.code ?? ''} onChange={(e) => onChange({ code: e.target.value })} style={{ maxWidth: 150 }}>
            <option value="">302 temporary</option>
            <option value="permanent">301 permanent</option>
            <option value="307">307</option>
            <option value="308">308</option>
          </select>
        </>
      );
    case 'rewrite':
      return <DraftInput className="input mono" value={rule.target} placeholder="/new/path" onChange={(v) => onChange({ target: v })} />;
    case 'respond':
      return (
        <>
          <DraftInput className="input mono" value={rule.status} placeholder="404" onChange={(v) => onChange({ status: v })} style={{ maxWidth: 80 }} />
          <DraftInput className="input" value={rule.body} placeholder="text (optional)" onChange={(v) => onChange({ body: v })} />
        </>
      );
    case 'block':
      return <span className="faint" style={{ fontSize: 12 }}>connection is dropped</span>;
    case 'proxy':
      return (
        <>
          <DraftInput className="input mono" value={rule.target} placeholder="localhost:8081" onChange={(v) => onChange({ target: v })} />
          {strip}
        </>
      );
    case 'files':
      return (
        <>
          <DraftInput className="input mono" value={rule.target} placeholder="/srv/static" onChange={(v) => onChange({ target: v })} />
          {strip}
        </>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
//  Access
// ---------------------------------------------------------------------------

function AccessSection({ site, edit }) {
  const found = findAllowlist(site.body);
  const auth = findAuth(site);
  const fa = site.body.find((n) => isDir(n, 'forward_auth') && !hasMatcher(n));
  const count = (found ? 1 : 0) + (auth ? 1 : 0) + (fa ? 1 : 0) + (countSet(site, [SITE_FIELDS.requestBody]));
  return (
    <Section id="access" title="Access control" count={count} help="Who may reach this site, and what they may send.">
      <div className="vstack" style={{ gap: 10 }}>
        <Allowlist site={site} found={found} edit={edit} />
        <BasicAuth node={auth} edit={edit} />
        <ForwardAuth node={fa} edit={edit} />
        <div className="f-grid">
          <Field root={site} field={SITE_FIELDS.requestBody} onWrite={(v) => writerFor(edit, siteRoot)(SITE_FIELDS.requestBody, v)} />
        </div>
      </div>
    </Section>
  );
}

function Allowlist({ site, found, edit }) {
  const [pending, setPending] = useState(false);
  const ranges = found ? found.ranges.map(unquote) : [];
  const on = Boolean(found) || pending;
  return (
    <Group
      title="IP allowlist"
      count={found ? 1 : 0}
      defaultOpen={Boolean(found)}
      help={`Only visitors from these addresses or networks can use the site; everyone else gets 403 Forbidden.
        Good for admin panels and internal tools. Blocked visitors never reach your app.`}
    >
      <div className="vstack" style={{ gap: 8 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              if (e.target.checked) setPending(true);
              else {
                setPending(false);
                edit((it) => { it.body = setAllowlist(it.body, null); });
              }
            }}
          />
          <span>Only allow these addresses</span>
        </label>
        {on && (
          <>
            <ListEditor
              values={ranges}
              placeholder="10.0.0.0/8, 203.0.113.7, or private_ranges"
              addLabel="Allow"
              validate={ipProblem}
              onChange={(vals) => {
                if (!vals.length) {
                  setPending(true);
                  edit((it) => { it.body = setAllowlist(it.body, null); });
                  return;
                }
                setPending(false);
                edit((it) => { it.body = setAllowlist(it.body, vals.map(quote), found?.kind ?? 'remote_ip'); });
              }}
            />
            <span className="faint field-hint">
              Single addresses (203.0.113.7), networks in CIDR form (10.30.1.0/24), or <code>private_ranges</code> for
              all private networks.{' '}
              {found?.kind === 'client_ip' && 'Matched on the client address, honouring trusted proxies. '}
              {found && !found.handler && <strong style={{ color: 'var(--amber)' }}>No rule rejects the matcher — it has no effect. </strong>}
              {!found && 'Add at least one address to turn this on.'}
            </span>
          </>
        )}
      </div>
    </Group>
  );
}

// --- basic auth ----------------------------------------------------------------------

const isAuth = (n) => isDir(n, ['basic_auth', 'basicauth']);
const findAuth = (it) => it.body.find(isAuth) ?? container(it).find(isAuth);

const HASH_ALGS = /^(bcrypt|scrypt|argon2id)$/;

function parseAuth(n) {
  const a = argsOf(n);
  let i = 0;
  const matcher = a[i] && (a[i].startsWith('/') || a[i].startsWith('@') || a[i] === '*') ? a[i++] : '';
  const alg = a[i] && HASH_ALGS.test(a[i]) ? a[i++] : '';
  const realm = a[i] ?? '';
  const users = (n.body ?? []).filter((x) => x.type === 'directive').map((x) => [unquote(x.tokens[0]), unquote(x.tokens[1] ?? '')]);
  return { matcher, alg, realm, users };
}

function authTokens({ matcher, alg, realm }) {
  return ['basic_auth', ...(matcher ? [quote(matcher)] : []), ...(realm ? [alg || 'bcrypt', quote(realm)] : alg ? [alg] : [])];
}

function BasicAuth({ node, edit }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const a = node ? parseAuth(node) : { matcher: '', alg: '', realm: '', users: [] };

  const change = (fn) =>
    edit((it) => {
      let n = findAuth(it);
      if (!n) {
        n = directive(['basic_auth'], []);
        it.body.splice(leadCount(it.body), 0, n);
      }
      const cur = parseAuth(n);
      const next = fn(cur);
      if (!next.users.length) {
        for (const list of [it.body, container(it)]) {
          const i = list.indexOf(n);
          if (i >= 0) list.splice(i, 1);
        }
        return;
      }
      n.tokens = authTokens(next);
      n.body = next.users.map(([u, h]) => directive([quote(u), quote(h)]));
    });

  const addUser = async () => {
    setErr(null);
    if (!user.trim() || !pass) return;
    if (a.users.some(([u]) => u === user.trim())) {
      setErr('That user already exists — remove it first to change its password.');
      return;
    }
    setBusy(true);
    try {
      const { hash } = await api.post('/api/caddy/hash-password', { password: pass });
      change((cur) => ({ ...cur, users: [...cur.users, [user.trim(), hash]] }));
      setUser('');
      setPass('');
    } catch (e) {
      setErr(e.body?.message ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group
      title="Password protection"
      count={a.users.length ? 1 : 0}
      help={`Ask for a user name and password (HTTP basic authentication) before anything on the site loads.
        Passwords are hashed with bcrypt here before they are written; the Caddyfile never holds them in
        plain text. Use it over HTTPS only.`}
    >
      <div className="vstack" style={{ gap: 8 }}>
        {a.users.map(([u, h]) => (
          <div key={u} className="hstack" style={{ flexWrap: 'nowrap' }}>
            <span className="mono" style={{ minWidth: 140 }}>{u}</span>
            <span className="faint mono truncate" style={{ flex: 1, fontSize: 11 }} title={h}>{h ? 'password set (hashed)' : 'no password'}</span>
            <button type="button" className="btn sm danger" onClick={() => change((cur) => ({ ...cur, users: cur.users.filter(([x]) => x !== u) }))}>
              Remove
            </button>
          </div>
        ))}
        <div className="hstack" style={{ flexWrap: 'nowrap' }}>
          <input className="input" placeholder="user name" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          <input className="input" type="password" placeholder="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          <button type="button" className="btn sm" disabled={busy || !user.trim() || !pass} onClick={addUser}>
            {busy ? 'Hashing…' : 'Add user'}
          </button>
        </div>
        {err && <span className="field-error">{err}</span>}
        {a.users.length > 0 && (
          <div className="f-grid">
            <div className="f-field">
              <Label field={{ label: 'Prompt text (realm)', help: 'Shown by some browsers in the login prompt. Optional.', example: 'Staff only' }} />
              <DraftInput className="input" value={a.realm} placeholder="restricted" onChange={(v) => change((cur) => ({ ...cur, realm: v.trim() }))} />
            </div>
            <div className="f-field">
              <Label field={{ label: 'Only for path', help: 'Protect just part of the site, e.g. /admin/*. Empty protects everything.', example: '/admin/*' }} />
              <DraftInput className="input mono" value={a.matcher} placeholder="whole site" onChange={(v) => change((cur) => ({ ...cur, matcher: v.trim() }))} />
            </div>
          </div>
        )}
      </div>
    </Group>
  );
}

// --- forward auth ------------------------------------------------------------------------

const FORWARD_FIELDS = [
  {
    id: 'fa_up', type: 'list', listLike: true, label: 'Auth service', dir: 'forward_auth',
    help: 'Address of the authentication service Caddy asks before letting each request through.',
    example: 'authelia:9091',
    read: (n) => argsOf(n),
    write: (n, vals) => { n.tokens = ['forward_auth', ...vals.map(quote)]; },
  },
  {
    id: 'uri', dir: 'uri', type: 'text', label: 'Verification path',
    help: "The path on the auth service that approves or rejects a request. See your auth service's Caddy guide.",
    placeholder: '/', example: '/api/authz/forward-auth',
  },
  {
    id: 'copy_headers', dir: 'copy_headers', type: 'list', label: 'Pass these headers to the app',
    help: 'Headers from an approved response copied onto the request, so the app knows who the user is.',
    placeholder: 'none', example: 'Remote-User Remote-Groups Remote-Email Remote-Name',
  },
];

function ForwardAuth({ node, edit }) {
  const locate = (it) => it.body.find((n) => isDir(n, 'forward_auth') && !hasMatcher(n));
  return (
    <Group
      title="Single sign-on (forward auth)"
      count={node ? 1 : 0}
      help={`Hand every request to an authentication service (Authelia, Authentik, Tinyauth, oauth2-proxy…)
        first. It either lets the request through or redirects the visitor to log in.`}
    >
      <div className="vstack" style={{ gap: 8 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(node)}
            onChange={(e) =>
              edit((it) => {
                if (e.target.checked) {
                  it.body.splice(leadCount(it.body), 0, directive(['forward_auth', 'authelia:9091'], [
                    directive(['uri', '/api/authz/forward-auth']),
                    directive(['copy_headers', 'Remote-User', 'Remote-Groups', 'Remote-Email', 'Remote-Name']),
                  ]));
                } else {
                  it.body = it.body.filter((n) => n !== locate(it));
                }
              })
            }
          />
          <span>Require login through an auth service</span>
        </label>
        {node && <FieldGrid root={node} fields={FORWARD_FIELDS} onWrite={writerFor(edit, locate)} />}
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
//  HTTPS
// ---------------------------------------------------------------------------

const TLS_MODE_HELP = `Where this site's certificate comes from. Automatic is right for public names. The internal CA
suits names only reachable on your network (browsers warn until they trust Caddy's root). Certificate files
are for certificates you obtained elsewhere.`;

function TlsSection({ site, edit }) {
  const t = tlsMode(site.body);
  const setArgs = (args) =>
    edit((it) => {
      let n = it.body.find((x) => isDir(x, 'tls'));
      if (!n) {
        if (!args.length) return;
        n = directive(['tls']);
        it.body.splice(leadCount(it.body), 0, n);
      }
      n.tokens = ['tls', ...args.map(quote)];
      if (!args.length && !n.body?.length) dropEmptyTls(it, n);
    });
  const optFields = TLS_FIELDS.filter((f) => f.id !== 'protocols');
  const write = writerFor(edit, siteRoot);
  const count = (t.mode !== 'auto' ? 1 : 0) + countSet(site, optFields) + (TLS_FIELDS[0].read(site).some(Boolean) ? 1 : 0);
  return (
    <Section id="tls" title="HTTPS certificate" count={count} help="How this site gets and uses its TLS certificate. The defaults suit almost every public site.">
      <div className="f-grid">
        <div className="f-field">
          <Label field={{ label: 'Certificate', help: TLS_MODE_HELP, dir: 'tls' }} />
          <select
            className="input"
            value={t.mode}
            disabled={t.mode === 'custom'}
            onChange={(e) => {
              const m = e.target.value;
              if (m === 'auto') setArgs([]);
              else if (m === 'internal') setArgs(['internal']);
              else if (m === 'email') setArgs([t.email ?? 'admin@example.com']);
              else if (m === 'files') setArgs([t.cert ?? '/etc/caddy/certs/site.crt', t.key ?? '/etc/caddy/certs/site.key']);
            }}
          >
            <option value="auto">Automatic (Let's Encrypt / ZeroSSL)</option>
            <option value="internal">Caddy's internal CA</option>
            <option value="email">Automatic, with this site's own ACME e-mail</option>
            <option value="files">Certificate and key files</option>
            {t.mode === 'custom' && <option value="custom">Custom — see All directives</option>}
          </select>
        </div>
        {t.mode === 'email' && (
          <div className="f-field">
            <Label field={{ label: 'ACME e-mail', help: 'Contact address for this site\'s certificate account (overrides the global one).', example: 'ops@example.com' }} />
            <DraftInput className="input" value={t.email} onChange={(v) => setArgs([v])} placeholder="you@example.com" />
          </div>
        )}
        {t.mode === 'files' && (
          <>
            <div className="f-field">
              <Label field={{ label: 'Certificate file', help: 'PEM certificate (with the full chain), as a path inside the Caddy container. Mount it via docker-compose.yml.', example: '/etc/caddy/certs/site.crt' }} />
              <DraftInput className="input mono" value={t.cert} onChange={(v) => setArgs([v, t.key])} />
            </div>
            <div className="f-field">
              <Label field={{ label: 'Private key file', help: 'The matching PEM private key, inside the Caddy container.', example: '/etc/caddy/certs/site.key' }} />
              <DraftInput className="input mono" value={t.key} onChange={(v) => setArgs([t.cert, v])} />
            </div>
          </>
        )}
      </div>
      <Group title="Advanced TLS options" help="Versions, key type, certificate authority and DNS challenge for this site only." count={countSet(site, optFields) + (TLS_FIELDS[0].read(site).some(Boolean) ? 1 : 0)}>
        <div className="f-grid">
          <ProtocolsField site={site} edit={edit} />
          {optFields.map((f) => <Field key={f.id} root={site} field={f} onWrite={(v) => write(f, v)} />)}
        </div>
      </Group>
    </Section>
  );
}

function ProtocolsField({ site, edit }) {
  const f = TLS_FIELDS[0];
  const [min, max] = f.read(site);
  const set = (a, b) => edit((it) => f.write(it, [a, b]));
  return (
    <div className="f-field">
      <Label field={{ ...f, dir: 'protocols' }} />
      <div className="hstack" style={{ flexWrap: 'nowrap' }}>
        <select className="input" value={min} onChange={(e) => set(e.target.value, max)} aria-label="Minimum TLS version">
          <option value="">oldest: default (1.2)</option>
          <option value="tls1.2">oldest: TLS 1.2</option>
          <option value="tls1.3">oldest: TLS 1.3</option>
        </select>
        <select className="input" value={max} onChange={(e) => set(min, e.target.value)} aria-label="Maximum TLS version">
          <option value="">newest: default (1.3)</option>
          <option value="tls1.2">newest: TLS 1.2</option>
          <option value="tls1.3">newest: TLS 1.3</option>
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Headers
// ---------------------------------------------------------------------------

const PRESETS = [
  {
    name: 'Strict-Transport-Security', label: 'HSTS',
    help: `Tells browsers to use HTTPS for this site from now on, even if someone types http://. Only enable once
      HTTPS works; with "subdomains" every subdomain must support HTTPS too.`,
    options: [
      { value: '', label: 'Off' },
      { value: 'max-age=31536000', label: '1 year' },
      { value: 'max-age=31536000; includeSubDomains', label: '1 year, include subdomains' },
      { value: 'max-age=63072000; includeSubDomains; preload', label: '2 years, subdomains, preload list' },
    ],
  },
  {
    name: 'X-Content-Type-Options', label: 'Stop MIME sniffing',
    help: 'Browsers must trust the Content-Type the server sends instead of guessing — blocks a class of script-injection tricks.',
    options: [{ value: '', label: 'Off' }, { value: 'nosniff', label: 'nosniff' }],
  },
  {
    name: 'X-Frame-Options', label: 'Framing',
    help: 'Whether other sites may show this one inside a frame. DENY prevents clickjacking; SAMEORIGIN allows only this site.',
    options: [{ value: '', label: 'Allowed (no header)' }, { value: 'DENY', label: 'DENY — never' }, { value: 'SAMEORIGIN', label: 'SAMEORIGIN — this site only' }],
  },
  {
    name: 'Referrer-Policy', label: 'Referrer policy',
    help: 'How much of this page\'s URL browsers send to other sites when a visitor follows a link.',
    options: [
      { value: '', label: 'Browser default' },
      { value: 'strict-origin-when-cross-origin', label: 'Origin only to other sites' },
      { value: 'same-origin', label: 'Only to this site' },
      { value: 'no-referrer', label: 'Never' },
    ],
  },
];

function HeadersSection({ site, edit }) {
  const res = readHeaders(site.body, 'header');
  const req = readHeaders(site.body, 'request_header');
  const presetNames = new Set([...PRESETS.map((p) => p.name.toLowerCase()), 'server']);
  const isPreset = (r) => presetNames.has(r.name.toLowerCase()) && (r.op === 'set' || (r.name.toLowerCase() === 'server' && r.op === 'delete'));
  const custom = res.rows.filter((r) => !isPreset(r));
  const saveRes = (rows) => edit((it) => writeHeaders(it.body, rows, 'header'));
  const setPreset = (name, row) => {
    const rows = res.rows.filter((r) => r.name.toLowerCase() !== name.toLowerCase() || !isPreset(r));
    saveRes(row ? [...rows, row] : rows);
  };
  const get = (name) => res.rows.find((r) => r.name.toLowerCase() === name.toLowerCase() && isPreset(r));

  return (
    <Section
      id="headers"
      title="Headers"
      count={res.rows.length + req.rows.length}
      help="Headers Caddy adds to, changes on or removes from traffic for this whole site."
    >
      {!res.simple && (
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
          This site has header rules that use find-and-replace or deferral. They are kept, but the list below cannot
          edit them safely — use All directives.
        </div>
      )}
      <fieldset disabled={!res.simple} className="plain-fieldset">
        <div className="f-grid">
          {PRESETS.map((p) => (
            <div key={p.name} className={`f-field${get(p.name) ? ' is-set' : ''}`}>
              <Label field={{ label: p.label, help: p.help, dir: 'header', example: `${p.name}: ${p.options[1].value}` }} />
              <select
                className="input"
                value={get(p.name)?.value ?? ''}
                onChange={(e) => setPreset(p.name, e.target.value ? { op: 'set', name: p.name, value: e.target.value } : null)}
              >
                {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                {get(p.name) && !p.options.some((o) => o.value === get(p.name).value) && (
                  <option value={get(p.name).value}>{get(p.name).value}</option>
                )}
              </select>
            </div>
          ))}
          <div className={`f-field f-flag${get('Server') ? ' is-set' : ''}`}>
            <label className="check">
              <input type="checkbox" checked={Boolean(get('Server'))} onChange={(e) => setPreset('Server', e.target.checked ? { op: 'delete', name: 'Server', value: '' } : null)} />
              <span>Hide the Server header</span>
            </label>
            <Help text="Stop announcing the web server software (Caddy) in every response. Cosmetic, but a common hardening checklist item." dir="header" example="-Server" />
          </div>
        </div>
        <div className="f-field wide" style={{ marginTop: 12 }}>
          <Label
            field={{
              label: 'Other response headers',
              help: `Any header sent back to visitors. Set replaces the value, Add appends another, Default only fills it in
                when the app sent none, Remove deletes it (a trailing * removes a whole family, e.g. X-Debug-*).`,
              example: 'Content-Security-Policy  default-src \'self\'',
              dir: 'header',
            }}
          />
          <HeaderRows rows={custom} onChange={(rows) => saveRes([...res.rows.filter(isPreset), ...rows])} />
        </div>
      </fieldset>

      <fieldset disabled={!req.simple} className="plain-fieldset">
        <div className="f-field wide" style={{ marginTop: 12 }}>
          <Label
            field={{
              label: 'Request headers (sent on to your app)',
              help: `Headers changed on incoming requests before any handler sees them. For headers only the upstream
                should get, use "Send to upstream" under the reverse proxy instead.`,
              example: 'X-Forwarded-Prefix  /app',
              dir: 'request_header',
            }}
          />
          {!req.simple && <span className="faint" style={{ fontSize: 12 }}>Uses rules this list cannot edit — see All directives.</span>}
          <HeaderRows rows={req.rows} onChange={(rows) => edit((it) => writeHeaders(it.body, rows, 'request_header'))} />
        </div>
      </fieldset>
    </Section>
  );
}

function HeaderRows({ rows, onChange }) {
  const [draft, setDraft] = useState({ op: 'set', name: '', value: '' });
  const set = (i, patch) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const row = (r, onPatch, extra) => (
    <div className="hdr-row">
      <select className="input" value={r.op} onChange={(e) => onPatch({ op: e.target.value })} title={HEADER_OPS.find((o) => o.id === r.op)?.help}>
        {HEADER_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <DraftInput className="input mono" value={r.name} placeholder="Header-Name" onChange={(v) => onPatch({ name: v })} />
      <DraftInput
        className="input mono"
        value={r.op === 'delete' ? '' : r.value}
        disabled={r.op === 'delete'}
        placeholder={r.op === 'delete' ? '(removed)' : 'value'}
        onChange={(v) => onPatch({ value: v })}
      />
      {extra}
    </div>
  );
  return (
    <div className="rows-field">
      {rows.map((r, i) => (
        <div key={i}>{row(r, (p) => set(i, p), <button type="button" className="btn sm" title="Remove" onClick={() => onChange(rows.filter((_, k) => k !== i))}>✕</button>)}</div>
      ))}
      {row(draft, (p) => setDraft({ ...draft, ...p }), (
        <button
          type="button"
          className="btn sm"
          disabled={!draft.name.trim()}
          onClick={() => {
            onChange([...rows, { ...draft, name: draft.name.trim() }]);
            setDraft({ op: 'set', name: '', value: '' });
          }}
        >
          Add
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Compression
// ---------------------------------------------------------------------------

function CompressionSection({ site, edit }) {
  const n = site.body.find((x) => isDir(x, 'encode') && !hasMatcher(x));
  const formats = n ? (argsOf(n).length ? argsOf(n) : ['zstd', 'gzip']) : [];
  const minLen = n?.body?.find((x) => isDir(x, 'minimum_length'));
  const change = (fn) =>
    edit((it) => {
      const cur = it.body.find((x) => isDir(x, 'encode') && !hasMatcher(x));
      fn(it, cur);
    });
  const setFormats = (list) =>
    change((it, cur) => {
      if (!list.length) {
        if (cur) it.body = it.body.filter((x) => x !== cur);
        return;
      }
      if (cur) cur.tokens = ['encode', ...list];
      else it.body.splice(leadCount(it.body), 0, directive(['encode', ...list]));
    });
  return (
    <Section
      id="compression"
      title="Compression"
      count={n ? 1 : 0}
      help={`Compress text responses (HTML, CSS, JS, JSON) so they download faster. Images, video and
        already-compressed files are skipped automatically.`}
    >
      <div className="f-grid">
        <div className={`f-field${n ? ' is-set' : ''}`}>
          <Label field={{ label: 'Formats', help: 'zstd is fastest and supported by current browsers; gzip covers every browser. Keep both.', dir: 'encode', example: 'encode zstd gzip' }} />
          <div className="checks">
            {['zstd', 'gzip'].map((fmt) => (
              <label key={fmt} className="check">
                <input
                  type="checkbox"
                  checked={formats.includes(fmt)}
                  onChange={(e) => setFormats(['zstd', 'gzip'].filter((x) => (x === fmt ? e.target.checked : formats.includes(x))))}
                />
                <span>{fmt}</span>
              </label>
            ))}
          </div>
        </div>
        {n && (
          <div className="f-field">
            <Label field={{ label: 'Only compress responses larger than', help: 'Tiny responses gain nothing from compression.', dir: 'minimum_length', placeholder: '512', example: '1024' }} />
            <DraftInput
              className="input mono"
              value={minLen ? argsOf(minLen)[0] : ''}
              placeholder="512 bytes"
              onChange={(v) =>
                change((it, cur) => {
                  if (!cur) return;
                  cur.body = (cur.body ?? []).filter((x) => !isDir(x, 'minimum_length'));
                  if (v.trim()) cur.body.push(directive(['minimum_length', quote(v.trim())]));
                  if (!cur.body.length) cur.body = null;
                })
              }
            />
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
//  Logging
// ---------------------------------------------------------------------------

function LoggingSection({ site, edit, snippets }) {
  const imports = importsOf(site.body);
  const ownLog = site.body.some((n) => isDir(n, 'log'));
  const write = writerFor(edit, siteRoot, { top: true });
  return (
    <Section
      id="logging"
      title="Logging & snippets"
      count={imports.length + countSet(site, [SITE_FIELDS.logSkip])}
      help="Snippets pull shared configuration into this site; the logging snippet is what feeds the statistics in this interface."
    >
      <div className="vstack" style={{ gap: 10 }}>
        {snippets.length > 0 ? (
          <div className="f-field wide">
            <Label field={{ label: 'Snippets to import', help: 'Reusable blocks defined on the Global & snippets page. A site that should appear in the statistics must import the one containing the JSON access log.', dir: 'import', example: 'import logging' }} />
            <div className="checks">
              {snippets.map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={imports.includes(s)}
                    onChange={(e) =>
                      edit((it) => {
                        if (e.target.checked) it.body.unshift(directive(['import', quote(s)]));
                        else it.body = it.body.filter((n) => !(isDir(n, 'import') && unquote(n.tokens[1]) === s));
                      })
                    }
                  />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <span className="faint" style={{ fontSize: 12.5 }}>No snippets defined.</span>
        )}
        {imports.filter((x) => !snippets.includes(x)).map((x) => (
          <div key={x} className="faint" style={{ fontSize: 12 }}>Also imports <code>{x}</code> (a file, or a snippet defined elsewhere).</div>
        ))}
        {ownLog && <div className="faint" style={{ fontSize: 12 }}>This site also has its own <code>log</code> block — edit it under All directives.</div>}
        <Field root={site} field={SITE_FIELDS.logSkip} onWrite={(v) => write(SITE_FIELDS.logSkip, v)} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
//  Advanced + anything the forms do not cover
// ---------------------------------------------------------------------------

const SIMPLE_MANAGED = new Set([
  'import', 'tls', 'bind', 'encode', 'header', 'request_header', 'basic_auth', 'basicauth', 'forward_auth',
  'request_body', 'log_skip', 'skip_log', 'templates', 'metrics', 'vars',
]);

function unmanaged(site) {
  const allow = findAllowlist(site.body);
  const rules = new Set(readRules(site).map((r) => r.node));
  const ca = catchAll(site);
  const nodes = [...site.body, ...(ca ? ca.body : [])];
  return nodes.filter((n) => {
    if (n.type !== 'directive' || n === ca) return false;
    if (allow && (n === allow.matcherNode || n === allow.handler)) return false;
    if (rules.has(n)) return false;
    const name = n.tokens[0];
    if (HANDLER_DIRS.includes(name) && !hasMatcher(n)) return false;
    if (SIMPLE_MANAGED.has(name) && (!hasMatcher(n) || ['basic_auth', 'basicauth'].includes(name))) return false;
    return true;
  });
}

function AdvancedSection({ site, edit, showDirectives }) {
  const write = writerFor(edit, siteRoot, { top: true });
  const fields = [SITE_FIELDS.templates, SITE_FIELDS.metrics, SITE_FIELDS.vars];
  const other = unmanaged(site);
  return (
    <Section id="advanced" title="Advanced" count={countSet(site, fields)} help="Less common options, and anything in this site that the forms above do not cover.">
      <FieldGrid root={site} fields={fields} onWrite={write} />
      <div className="f-field wide" style={{ marginTop: 12 }}>
        <Label
          field={{
            label: 'Configured elsewhere',
            help: `Directives in this site that have no form above — they stay exactly as written. Open All directives
              to change them.`,
          }}
        />
        {other.length ? (
          <div className="hstack" style={{ gap: 6 }}>
            {other.map((n, i) => (
              <button key={i} type="button" className="chip" onClick={showDirectives} title="Edit under All directives">
                <span className="mono truncate" style={{ maxWidth: 320 }}>{n.tokens.map(unquote).join(' ')}{n.body ? ' { … }' : ''}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="faint" style={{ fontSize: 12.5 }}>Nothing — every directive in this site is covered by the forms above.</span>
        )}
      </div>
    </Section>
  );
}
