// Form-level editing of Caddyfile blocks.
//
// Every option on the settings pages is described by a *field* (see
// caddyschema.js): which directive it lives in, what kind of value it takes,
// and its help text. This module is the one place that knows how to read such
// a field out of a block and write it back, so the forms stay declarative.
//
// Writes mutate the working copy they are given (the page hands each edit a
// fresh clone). A write only touches the directive it owns: its comments,
// sub-blocks and everything around it are left alone, and blocks the write
// created are removed again once they are empty.

import { directive, isMatcherToken, quote, unquote } from './caddyfile.js';

export const isDir = (n, name) =>
  n?.type === 'directive' && (Array.isArray(name) ? name.includes(n.tokens[0]) : n.tokens[0] === name);
/**
 * Whether a directive is limited to some requests. `*` means all requests,
 * and for directives whose single argument is their target (`redir /new`,
 * `root /srv`) a lone path is that target, not a matcher.
 */
const TARGET_FIRST = new Set(['redir', 'rewrite', 'root', 'respond', 'try_files']);
export function hasMatcher(n) {
  const t = n.tokens[1];
  if (!t || !isMatcherToken(t) || t === '*') return false;
  return !(TARGET_FIRST.has(n.tokens[0]) && n.tokens.length === 2);
}
export const argsOf = (n) => n.tokens.slice(1).map(unquote);
const primaryName = (dir) => (Array.isArray(dir) ? dir[0] : dir);

export const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
//  Scopes: a field may live in a nested block, e.g. reverse_proxy > transport
//  http > dial_timeout. A path step is { name, head = [], any = false }:
//  `head` must equal the block's arguments exactly unless `any` is set.
// ---------------------------------------------------------------------------

function stepMatches(n, step) {
  if (!isDir(n, step.name)) return false;
  if (step.any) return true;
  const args = argsOf(n);
  const head = step.head ?? [];
  return args.length === head.length && head.every((h, i) => args[i] === h);
}

/** The node at `path` under `root`, creating it (and its parents) if asked. */
export function resolve(root, path, create = false) {
  let node = root;
  for (const step of path ?? []) {
    if (!node.body) {
      if (!create) return null;
      node.body = [];
    }
    let next = node.body.find((n) => stepMatches(n, step));
    if (!next) {
      if (!create) return null;
      next = directive([step.name, ...(step.head ?? []).map(quote)], []);
      node.body.push(next);
    }
    if (!next.body && create) next.body = [];
    node = next;
  }
  return node;
}

/** Remove blocks along `path` that the last write left empty. */
function prune(root, path, rootNullable) {
  const chain = [root];
  let node = root;
  for (const step of path ?? []) {
    node = node?.body?.find((n) => stepMatches(n, step));
    if (!node) break;
    chain.push(node);
  }
  for (let i = chain.length - 1; i >= 1; i--) {
    const n = chain[i];
    if (n.body && n.body.length === 0) {
      const step = path[i - 1];
      const bare = n.tokens.length === 1 + (step.head?.length ?? 0) && !n.comment;
      if (bare) chain[i - 1].body = chain[i - 1].body.filter((x) => x !== n);
      else n.body = null;
    }
  }
  if (rootNullable && root.body && root.body.length === 0) root.body = null;
}

/**
 * Directives that configure the site as a whole are kept together near the
 * top: after imports, tls, log, encode and header lines.
 */
export function leadCount(body) {
  let k = 0;
  while (
    k < body.length &&
    (body[k].type === 'comment' ||
      (body[k].type === 'directive' && ['import', 'tls', 'log', 'encode', 'header', 'bind'].includes(body[k].tokens[0])))
  ) k++;
  return k;
}

/**
 * Replace every node matching `pred` with `nodes`, at the position of the
 * first one removed (or at `fallback` when there were none).
 */
export function replaceNodes(body, pred, nodes, fallback = body.length) {
  let at = -1;
  const kept = [];
  body.forEach((n) => {
    if (pred(n)) {
      if (at < 0) at = kept.length;
      return;
    }
    kept.push(n);
  });
  if (at < 0) at = Math.min(fallback, kept.length);
  kept.splice(at, 0, ...nodes);
  body.length = 0;
  body.push(...kept);
}

// ---------------------------------------------------------------------------
//  Fields
// ---------------------------------------------------------------------------

/** Nodes a field owns inside its scope. */
function owned(body, f) {
  return (body ?? []).filter((n) => isDir(n, f.dir) && (f.pred ? f.pred(n) : true));
}

export function readField(root, f) {
  if (f.read) return f.read(root);
  const scope = f.path ? resolve(root, f.path) : root;
  const nodes = owned(scope?.body, f);
  const n = nodes[0];
  switch (f.type) {
    case 'flag':
      return Boolean(n);
    case 'list':
    case 'checks':
      return n ? argsOf(n) : [];
    case 'rows':
      return nodes.map((x) => rowCells(x, f.columns));
    default:
      return n ? argsOf(n).join(' ') : '';
  }
}

function rowCells(n, columns) {
  const a = argsOf(n);
  return columns.map((c, i) => (c.rest ? a.slice(i).join(' ') : a[i] ?? ''));
}

function rowTokens(cells, columns) {
  const out = [];
  columns.forEach((c, i) => {
    const v = cells[i] ?? '';
    if (c.rest && c.split) out.push(...words(v).map(quote));
    else out.push(quote(v));
  });
  // Optional trailing cells that are empty are simply left off.
  while (out.length && out[out.length - 1] === '""' && columns[out.length - 1]?.optional) out.pop();
  return out;
}

export function isEmptyValue(f, v) {
  if (f.type === 'flag') return !v;
  if (Array.isArray(v)) return v.length === 0;
  return String(v ?? '').trim() === '';
}

/**
 * Write a field's value. `opts.top` places a new directive with the site-wide
 * settings instead of at the end; `opts.rootNullable` lets the root's own
 * block disappear when it empties (a `reverse_proxy { }` with nothing left).
 */
export function writeField(root, f, value, opts = {}) {
  if (f.write) {
    f.write(root, value);
    if (opts.rootNullable && root.body && root.body.length === 0) root.body = null;
    return;
  }
  const empty = isEmptyValue(f, value);
  const scope = f.path ? resolve(root, f.path, !empty) : root;
  if (!scope) return;
  scope.body ??= [];
  const body = scope.body;
  const existing = owned(body, f);
  const name = primaryName(f.dir);
  let nodes;

  switch (f.type) {
    case 'flag':
      nodes = value ? (existing.length ? [existing[0]] : [directive([name])]) : [];
      break;
    case 'list':
    case 'checks':
      nodes = value.length ? [withTokens(existing[0], [name, ...value.map(quote)])] : [];
      break;
    case 'rows':
      nodes = value.map((cells, i) => {
        const prev = existing[i];
        const same = prev && rowCells(prev, f.columns).every((c, k) => c === (cells[k] ?? ''));
        return same ? prev : withTokens(prev, [name, ...(f.prefix ?? []), ...rowTokens(cells, f.columns)]);
      });
      break;
    default: {
      const v = String(value ?? '').trim();
      nodes = v ? [withTokens(existing[0], [name, ...(f.multi ? words(v).map(quote) : [quote(v)])])] : [];
    }
  }
  const fallback = opts.top && !f.path ? leadCount(body) : body.length;
  replaceNodes(body, (n) => existing.includes(n), nodes, fallback);
  prune(root, f.path, opts.rootNullable);
}

/** Reuse a node (keeping its comment and sub-block) with new tokens. */
function withTokens(prev, tokens) {
  if (!prev) return directive(tokens);
  return { ...prev, tokens };
}

/** How many of `fields` currently hold a value — shown on section headers. */
export function countSet(root, fields) {
  let n = 0;
  for (const f of fields) {
    if (!root || f.type === 'custom') continue;
    try {
      if (!isEmptyValue(f, readField(root, f))) n++;
    } catch {
      /* a field that cannot read this shape simply does not count */
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
//  Where a site's request handling lives
// ---------------------------------------------------------------------------

/** The bare `handle { }` a site is wrapped in when it has an IP allowlist. */
export function catchAll(site) {
  return site.body.find((n) => isDir(n, 'handle') && n.tokens.length === 1 && n.body);
}

/** The block holding the site's handlers: the catch-all handle, or the site. */
export function container(site) {
  return catchAll(site)?.body ?? site.body;
}

export const HANDLER_DIRS = ['reverse_proxy', 'php_fastcgi', 'file_server', 'root', 'try_files', 'redir', 'respond'];

export const MODES = [
  { id: 'proxy', label: 'Reverse proxy', help: 'Forward every request to one or more backend servers (upstreams) and return their responses. The usual choice for web apps, APIs and other services.' },
  { id: 'static', label: 'Static files', help: 'Serve files from a directory inside the Caddy container: websites built as plain HTML, downloads, single-page apps.' },
  { id: 'php', label: 'PHP application', help: 'Serve a PHP app (WordPress, Nextcloud, Laravel…) through a PHP-FPM server, with static files served directly.' },
  { id: 'redirect', label: 'Redirect', help: 'Send every visitor to another address, e.g. an old domain to a new one.' },
  { id: 'respond', label: 'Fixed response', help: 'Answer every request with the same status code and text, without a backend. Useful for maintenance pages, health endpoints or blocking a name.' },
  { id: 'none', label: 'Nothing yet', help: 'This site has no main handler. Requests that no path rule handles get an empty 200 response.' },
];

/** What the site mainly does, from its unmatched handlers. */
export function siteMode(site) {
  const c = container(site);
  const has = (name) => c.some((n) => isDir(n, name) && !hasMatcher(n));
  if (has('php_fastcgi')) return 'php';
  if (has('reverse_proxy')) return 'proxy';
  if (has('file_server')) return 'static';
  if (has('redir')) return 'redirect';
  if (has('respond')) return 'respond';
  return 'none';
}

/** The main (unmatched) node of a handler directive in the site's container. */
export function mainNode(site, name) {
  return container(site).find((n) => isDir(n, name) && !hasMatcher(n)) ?? null;
}

export function setMode(site, mode) {
  const c = container(site);
  const keep = c.filter((n) => !(n.type === 'directive' && HANDLER_DIRS.includes(n.tokens[0]) && !hasMatcher(n)));
  const add = {
    proxy: [directive(['reverse_proxy', 'localhost:8080'])],
    static: [directive(['root', '*', '/srv']), directive(['file_server'])],
    php: [directive(['root', '*', '/var/www/html']), directive(['php_fastcgi', 'localhost:9000']), directive(['file_server'])],
    redirect: [directive(['redir', quote('https://example.com{uri}'), 'permanent'])],
    respond: [directive(['respond', quote('OK'), '200'])],
    none: [],
  }[mode];
  c.length = 0;
  c.push(...keep, ...add);
}

// ---------------------------------------------------------------------------
//  Response / request headers
//
//  The form manages `header` lines that apply to the whole site (no matcher),
//  whether written one per line or grouped in a `header { }` block. Anything
//  more elaborate (find/replace, defer) makes the editor read-only.
// ---------------------------------------------------------------------------

export const HEADER_OPS = [
  { id: 'set', prefix: '', label: 'Set', help: 'Set the header, replacing any value the app sent.' },
  { id: 'add', prefix: '+', label: 'Add', help: 'Add another value, keeping any the app sent.' },
  { id: 'default', prefix: '?', label: 'Default', help: 'Set it only if the app did not send this header itself.' },
  { id: 'delete', prefix: '-', label: 'Remove', help: 'Remove the header. A trailing * removes every header starting with the name.' },
];

function parseHeaderEntry(tokens) {
  const [field, ...rest] = tokens.map(unquote);
  if (!field || rest.length > 1) return null;
  const op = HEADER_OPS.find((o) => o.prefix && field.startsWith(o.prefix)) ?? HEADER_OPS[0];
  return { op: op.id, name: field.slice(op.prefix.length), value: rest[0] ?? '' };
}

export function readHeaders(body, dir = 'header') {
  const rows = [];
  let simple = true;
  for (const n of body) {
    if (!isDir(n, dir) || hasMatcher(n)) continue;
    if (n.body) {
      if (n.tokens.length > 1) simple = false;
      for (const e of n.body) {
        if (e.type !== 'directive') continue;
        const r = e.body ? null : parseHeaderEntry(e.tokens);
        if (r) rows.push(r);
        else simple = false;
      }
    } else {
      const r = parseHeaderEntry(n.tokens.slice(1));
      if (r) rows.push(r);
      else simple = false;
    }
  }
  return { rows, simple };
}

export function writeHeaders(body, rows, dir = 'header') {
  const nodes = rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const op = HEADER_OPS.find((o) => o.id === r.op) ?? HEADER_OPS[0];
      const field = quote(op.prefix + r.name.trim());
      return directive(op.id === 'delete' || r.value === '' ? [dir, field] : [dir, field, quote(r.value)]);
    });
  replaceNodes(body, (n) => isDir(n, dir) && !hasMatcher(n), nodes, leadCount(body));
}

// ---------------------------------------------------------------------------
//  Path rules: simple things done for part of the site.
// ---------------------------------------------------------------------------

export const RULE_TYPES = [
  { id: 'redirect', label: 'Redirect', help: 'Send requests for this path to another URL.' },
  { id: 'rewrite', label: 'Rewrite', help: 'Change the path internally before it is handled; the visitor never sees the new path.' },
  { id: 'respond', label: 'Fixed response', help: 'Answer this path with a status code (and optional text) without a backend.' },
  { id: 'block', label: 'Block (drop)', help: 'Close the connection without any response. Good for paths scanners probe.' },
  { id: 'proxy', label: 'Proxy elsewhere', help: 'Send this path to a different backend than the rest of the site.' },
  { id: 'files', label: 'Serve files', help: 'Serve this path from a directory inside the Caddy container.' },
];

const isPath = (t) => typeof t === 'string' && t.startsWith('/');

/** Recognise one node as a rule, or return null. */
function ruleOf(n) {
  if (n.type !== 'directive' || !isPath(n.tokens[1]) || !hasMatcher(n)) return null;
  const [name, path, ...rest] = n.tokens.map(unquote);
  if (n.body && !['handle', 'handle_path'].includes(name)) return null;
  if (name === 'redir' && !n.body && rest.length >= 1 && rest.length <= 2) return { type: 'redirect', path, target: rest[0], code: rest[1] ?? '' };
  if (name === 'rewrite' && !n.body && rest.length === 1) return { type: 'rewrite', path, target: rest[0] };
  if (name === 'abort' && !n.body && rest.length === 0) return { type: 'block', path };
  if (name === 'respond' && !n.body && rest.length <= 2) {
    if (rest.length === 1 && /^\d{3}$/.test(rest[0])) return { type: 'respond', path, status: rest[0], body: '' };
    return { type: 'respond', path, body: rest[0] ?? '', status: rest[1] ?? '' };
  }
  if ((name === 'handle' || name === 'handle_path') && rest.length === 0 && n.body) {
    const strip = name === 'handle_path';
    const inner = n.body.filter((x) => x.type === 'directive');
    if (inner.length === 1 && isDir(inner[0], 'reverse_proxy') && !hasMatcher(inner[0])) {
      return { type: 'proxy', path, strip, target: argsOf(inner[0]).join(' '), node: n };
    }
    if (inner.length === 2 && isDir(inner[0], 'root') && isDir(inner[1], 'file_server') && !inner[1].body && inner[1].tokens.length === 1) {
      const r = argsOf(inner[0]);
      return { type: 'files', path, strip, target: r[r.length - 1] ?? '' };
    }
  }
  return null;
}

export function readRules(site) {
  return container(site)
    .map((n) => ({ n, r: ruleOf(n) }))
    .filter((x) => x.r)
    .map(({ n, r }) => ({ ...r, node: n }));
}

function ruleNode(r, prev) {
  const p = quote(r.path || '/');
  switch (r.type) {
    case 'redirect':
      return directive(['redir', p, quote(r.target || '/'), ...(r.code ? [r.code] : [])]);
    case 'rewrite':
      return directive(['rewrite', p, quote(r.target || '/')]);
    case 'block':
      return directive(['abort', p]);
    case 'respond':
      return directive(['respond', p, ...(r.body ? [quote(r.body)] : []), ...(r.status ? [r.status] : r.body ? [] : ['404'])]);
    case 'proxy': {
      const name = r.strip ? 'handle_path' : 'handle';
      const ups = words(r.target).map(quote);
      // Keep any proxy options configured on the existing rule.
      const old = prev?.r?.type === 'proxy' ? prev.node.body.find((x) => isDir(x, 'reverse_proxy')) : null;
      const rp = old ? { ...old, tokens: ['reverse_proxy', ...(ups.length ? ups : ['localhost:8080'])] } : directive(['reverse_proxy', ...(ups.length ? ups : ['localhost:8080'])]);
      return directive([name, p], [rp]);
    }
    case 'files':
      return directive([r.strip ? 'handle_path' : 'handle', p], [directive(['root', '*', quote(r.target || '/srv')]), directive(['file_server'])]);
    default:
      return null;
  }
}

export function writeRules(site, rules) {
  const c = container(site);
  const current = c.map((n) => ({ n, r: ruleOf(n) })).filter((x) => x.r);
  const nodes = rules.map((r, i) => {
    const prev = current[i] ? { node: current[i].n, r: current[i].r } : null;
    if (prev && sameRule(prev.r, r)) return prev.node;
    return ruleNode(r, prev);
  }).filter(Boolean);
  // New rules go before the main handler so they read in evaluation order.
  const firstHandler = c.findIndex((n) => n.type === 'directive' && HANDLER_DIRS.includes(n.tokens[0]) && !hasMatcher(n));
  replaceNodes(c, (n) => current.some((x) => x.n === n), nodes, firstHandler < 0 ? c.length : firstHandler);
}

function sameRule(a, b) {
  const keys = ['type', 'path', 'target', 'code', 'status', 'body', 'strip'];
  return keys.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

// ---------------------------------------------------------------------------
//  Validation hints (advisory: Caddy has the final word when you apply)
// ---------------------------------------------------------------------------

const DURATION = /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d))+$/;
const SIZE = /^\d+(\.\d+)?\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i;
const PLACEHOLDER = /^\{[^}]+\}$/;

export function checkValue(kind, v) {
  const s = String(v ?? '').trim();
  if (!s || PLACEHOLDER.test(s)) return null;
  if (kind === 'duration' && !DURATION.test(s) && s !== '0' && s !== '-1') return 'Use a duration such as 500ms, 30s, 5m or 1h.';
  if (kind === 'size' && !SIZE.test(s)) return 'Use a size such as 512KB, 10MB or 1GiB.';
  if (kind === 'number' && !/^-?\d+$/.test(s)) return 'Use a whole number.';
  if (kind === 'port' && !(/^\d+$/.test(s) && +s > 0 && +s < 65536)) return 'Use a port number between 1 and 65535.';
  if (kind === 'status' && !/^[1-5]\d\d$|^[1-5]xx$/i.test(s)) return 'Use an HTTP status code such as 200, 404 or 5xx.';
  if (kind === 'url' && !/^(https?:\/\/|\/|\{)/.test(s)) return 'Start with https://, http:// or /.';
  return null;
}
