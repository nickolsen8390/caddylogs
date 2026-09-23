// Caddyfile parser and serializer.
//
// Designed for editing, not for execution: Caddy itself remains the authority
// on what a config means (every change is validated by its /adapt endpoint
// before it is applied). What this module guarantees is a faithful round trip:
//
//   serialize(parse(text)) === text
//
// for any file that has not been edited, and — because every top-level block
// keeps the exact source it was parsed from — editing one site re-formats that
// one site and leaves every other byte of the file alone. Comments survive
// structured edits, including a site that has been commented out, which is
// recognised as a *disabled* site and can be switched back on.
//
// Model
//   File  { eol, items: Item[], trailing: string[] }
//   Item  { type: 'global'|'snippet'|'route'|'site'|'comment',
//           gap: string[]        blank lines before it, verbatim
//           leading: string[]    comment lines directly above it
//           raw: string|null     exact source; null once edited
//           body: Node[]         (not for 'comment')
//           name                 snippet / named-route name
//           addresses: string[]  site addresses (source tokens)
//           disabled: boolean    site that is commented out
//           braceless: boolean   the single-site-without-braces form
//           lines: string[]      ('comment' only) }
//   Node  { type: 'directive', tokens: string[], body: Node[]|null,
//           comment: string|null, gap: boolean }
//       | { type: 'comment', text, gap }
//
// Tokens are stored in *source form* (quotes and escapes included) so they
// print back exactly; use unquote()/quote() at the UI boundary.

// ---------------------------------------------------------------------------
//  Token helpers
// ---------------------------------------------------------------------------

/** The value a source token stands for: quotes removed, escapes resolved. */
export function unquote(tok) {
  if (tok == null) return '';
  if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') {
    return tok.slice(1, -1).replace(/\\(.)/gs, (_, c) => (c === '"' ? '"' : `\\${c}`));
  }
  if (tok.length >= 2 && tok[0] === '`' && tok[tok.length - 1] === '`') return tok.slice(1, -1);
  return tok;
}

/** Source form for a value: quoted only when it would not survive bare. */
export function quote(value) {
  const v = String(value ?? '');
  if (v === '') return '""';
  if (v.startsWith('<<') && v.includes('\n')) return v; // heredoc, already source
  const needs =
    /[\s"]/.test(v) || v[0] === '#' || v[0] === '`' || v === '{' || v === '}' || v.startsWith('<<');
  if (!needs) return v;
  if (v.includes('\n') && !v.includes('`')) return `\`${v}\``;
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
//  Lexer — mirrors caddyconfig/caddyfile/lexer.go, but keeps comments and the
//  exact source text of every token.
// ---------------------------------------------------------------------------

export class CaddyfileError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

/** @returns {{text:string, line:number, endLine:number, comment?:true}[]} */
export function tokenize(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    const start = i;
    const startLine = line;

    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      out.push({ text: src.slice(start, i).replace(/\r$/, ''), line: startLine, endLine: startLine, comment: true });
      continue;
    }

    if (ch === '"' || ch === '`') {
      const q = ch;
      i++;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (q === '"' && c === '\\' && i + 1 < n) {
          if (src[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (c === '\n') line++;
        i++;
        if (c === q) { closed = true; break; }
      }
      if (!closed) throw new CaddyfileError('unterminated quoted string', startLine);
      out.push({ text: src.slice(start, i), line: startLine, endLine: line });
      continue;
    }

    // Bare word. A quote or '#' in the middle of a word is literal, as in Caddy.
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '\\' && i + 1 < n && src[i + 1] !== '\n' && src[i + 1] !== '\r') { i += 2; continue; }
      i++;
    }
    let text = src.slice(start, i);

    // Heredoc: <<MARKER at the end of a line, closed by a line whose first
    // word is MARKER. Anything after the closing marker is lexed normally.
    const hd = /^<<([A-Za-z0-9_-]+)$/.exec(text);
    if (hd) {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
      if (j >= n || src[j] === '\n') {
        const marker = hd[1];
        let pos = j;
        let found = false;
        while (pos < n) {
          pos++; // past '\n'
          line++;
          const eolAt = src.indexOf('\n', pos);
          const end = eolAt === -1 ? n : eolAt;
          const content = src.slice(pos, end);
          const m = /^([ \t]*)(\S+)/.exec(content);
          if (m && m[2] === marker) {
            i = pos + m[1].length + marker.length;
            found = true;
            break;
          }
          pos = end;
          if (eolAt === -1) break;
        }
        if (!found) throw new CaddyfileError(`heredoc <<${marker} is never closed`, startLine);
        text = src.slice(start, i);
      }
    }
    out.push({ text, line: startLine, endLine: line });
  }
  return out;
}

/** Group tokens into logical lines: {words, comment, line, endLine}. */
function logicalLines(tokens) {
  const lines = [];
  let cur = null;
  for (const t of tokens) {
    if (!cur || t.line > cur.endLine) {
      cur = { words: [], comment: null, line: t.line, endLine: t.endLine };
      lines.push(cur);
    }
    if (t.comment) cur.comment = t.text;
    else cur.words.push(t.text);
    cur.endLine = Math.max(cur.endLine, t.endLine);
  }
  return lines;
}

/**
 * Split lines so that '{' only ever ends a line and '}' is always alone.
 * Caddy wants that layout anyway; accepting the compact one-line form here
 * means pasted snippets like `handle { respond 403 }` still parse.
 */
function normalizeBraces(lines) {
  const out = [];
  for (const l of lines) {
    const frags = [];
    let words = [];
    for (const w of l.words) {
      if (w === '{') {
        words.push(w);
        frags.push(words);
        words = [];
      } else if (w === '}') {
        if (words.length) frags.push(words);
        frags.push(['}']);
        words = [];
      } else {
        words.push(w);
      }
    }
    if (words.length) frags.push(words);
    if (!frags.length) {
      out.push({ ...l }); // comment-only line
      continue;
    }
    // A trailing comment belongs to the last fragment of its source line.
    frags.forEach((f, k) => out.push({ ...l, words: f, comment: k === frags.length - 1 ? l.comment : null }));
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Block bodies
// ---------------------------------------------------------------------------

function parseBody(lines, pos, closeRequired, openLine) {
  const nodes = [];
  let prevEnd = pos > 0 ? lines[pos - 1].endLine : 0;
  while (pos < lines.length) {
    const l = lines[pos];
    const gap = l.line > prevEnd + 1 && nodes.length > 0;
    if (l.words.length === 1 && l.words[0] === '}') {
      if (l.comment) nodes.push({ type: 'comment', text: l.comment, gap: false });
      return { nodes, pos: pos + 1, endLine: l.endLine };
    }
    if (!l.words.length) {
      nodes.push({ type: 'comment', text: l.comment, gap });
      prevEnd = l.endLine;
      pos++;
      continue;
    }
    const opens = l.words[l.words.length - 1] === '{';
    const tokens = opens ? l.words.slice(0, -1) : l.words.slice();
    if (!tokens.length) throw new CaddyfileError('block opened without a directive', l.line);
    const node = { type: 'directive', tokens, body: null, comment: l.comment, gap };
    if (opens) {
      const inner = parseBody(lines, pos + 1, true, l.line);
      node.body = inner.nodes;
      pos = inner.pos;
      prevEnd = inner.endLine;
    } else {
      pos++;
      prevEnd = l.endLine;
    }
    nodes.push(node);
  }
  if (closeRequired) throw new CaddyfileError('block is never closed (missing "}")', openLine);
  return { nodes, pos, endLine: prevEnd };
}

// ---------------------------------------------------------------------------
//  Top level
// ---------------------------------------------------------------------------

const ADDRESS_LINE = /^#(?=\S)(?!#)(.*\S)\s*\{\s*$/;

/**
 * Parse a whole Caddyfile.
 * @returns {{eol:string, items:object[], trailing:string[]}}
 */
export function parse(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const src = text.replace(/\r\n/g, '\n');
  const srcLines = src.split('\n');
  // A final newline yields a trailing '' — that is the file's EOL, not a line.
  const endsWithNewline = src.endsWith('\n');
  if (endsWithNewline) srcLines.pop();

  const lines = normalizeBraces(logicalLines(tokenize(src)));
  const items = [];
  let pos = 0;
  let sawNonComment = false;

  while (pos < lines.length) {
    const l = lines[pos];
    const start = l.line;

    if (!l.words.length) {
      // Run of comment-only lines; split later into comments/disabled sites.
      const run = [];
      while (pos < lines.length && !lines[pos].words.length && (run.length === 0 || lines[pos].line === run[run.length - 1].line + 1)) {
        run.push(lines[pos]);
        pos++;
      }
      items.push({ type: 'comment', start: run[0].line, end: run[run.length - 1].line });
      continue;
    }

    // Global options: a bare '{' as the very first block.
    if (!sawNonComment && l.words.length === 1 && l.words[0] === '{') {
      const inner = parseBody(lines, pos + 1, true, l.line);
      items.push({ type: 'global', body: inner.nodes, start, end: inner.endLine, headComment: l.comment });
      pos = inner.pos;
      sawNonComment = true;
      continue;
    }
    sawNonComment = true;

    const first = l.words[0];
    const snip = /^\((.+)\)$/.exec(first);
    const route = /^&\((.+)\)$/.exec(first);
    if ((snip || route) && l.words.length === 2 && l.words[1] === '{') {
      const inner = parseBody(lines, pos + 1, true, l.line);
      items.push({
        type: snip ? 'snippet' : 'route',
        name: (snip || route)[1],
        body: inner.nodes,
        start,
        end: inner.endLine,
        headComment: l.comment,
      });
      pos = inner.pos;
      continue;
    }
    if (l.words[0] === '}') throw new CaddyfileError('unexpected "}"', l.line);

    // Site: addresses may continue across lines while a line ends with ','.
    const addrWords = [];
    let p = pos;
    let opened = false;
    let headComment = null;
    for (;;) {
      const cur = lines[p];
      if (!cur) break;
      const w = cur.words;
      const last = w[w.length - 1];
      if (last === '{') {
        addrWords.push(...w.slice(0, -1));
        headComment = cur.comment;
        opened = true;
        p++;
        break;
      }
      addrWords.push(...w);
      p++;
      if (!(last && last.endsWith(',')) || !lines[p] || !lines[p].words.length) break;
    }
    const addresses = splitAddresses(addrWords);
    if (!addresses.length) throw new CaddyfileError('site block has no address', l.line);

    if (opened) {
      const inner = parseBody(lines, p, true, l.line);
      items.push({ type: 'site', addresses, body: inner.nodes, start, end: inner.endLine, headComment });
      pos = inner.pos;
    } else {
      // Caddy allows exactly one site with no braces; its body is the rest.
      const hasOtherBlocks = items.some((it) => it.type === 'site');
      if (hasOtherBlocks) {
        throw new CaddyfileError('site address must be followed by "{"', l.line);
      }
      const inner = parseBody(lines, p, false, l.line);
      if (inner.pos < lines.length) throw new CaddyfileError('unexpected "}"', lines[inner.pos].line);
      items.push({ type: 'site', addresses, body: inner.nodes, start, end: srcLines.length, braceless: true, headComment: null });
      pos = inner.pos;
    }
  }

  // Attach verbatim source, blank-line gaps and comment text.
  const file = { eol, items: [], trailing: [] };
  let cursor = 1; // next unconsumed source line (1-based)
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.type === 'site' && it.braceless) it.end = lastNonBlank(srcLines, it.end);
    const gap = srcLines.slice(cursor - 1, it.start - 1);
    it.gap = gap;
    it.raw = srcLines.slice(it.start - 1, it.end).join('\n');
    if (it.type === 'comment') it.lines = srcLines.slice(it.start - 1, it.end);
    else it.indent = inferIndent(srcLines.slice(it.start, it.end));
    cursor = it.end + 1;
    file.items.push(it);
  }
  file.trailing = srcLines.slice(cursor - 1);
  file.endsWithNewline = endsWithNewline;

  file.items = attachLeading(splitDisabled(file.items));
  for (const it of file.items) {
    delete it.start;
    delete it.end;
  }
  return file;
}

/**
 * The indentation unit a block was written with (first indented line), so an
 * edited block is re-emitted in its own style and its diff shows only what
 * actually changed. Defaults to a tab, as `caddy fmt` does.
 */
function inferIndent(lines) {
  for (const l of lines) {
    const m = /^([ \t]+)\S/.exec(l);
    if (!m) continue;
    const ws = m[1];
    if (/^\t+$/.test(ws)) return '\t';
    if (/^ +$/.test(ws)) return ws;
    return '\t';
  }
  return '\t';
}

function lastNonBlank(lines, end) {
  let e = end;
  while (e > 0 && !lines[e - 1].trim()) e--;
  return e;
}

function splitAddresses(words) {
  const out = [];
  for (const w of words) {
    for (const part of w.split(',')) if (part) out.push(part);
  }
  return out;
}

/**
 * Carve commented-out site blocks out of comment runs. A disabled site is a
 * run of lines each starting with '#', whose first line is `#address {` with
 * no space after the '#' — the shape an editor's "comment out" produces, and
 * distinct from prose or documentation examples, which are written `# ...`.
 */
function splitDisabled(items) {
  const out = [];
  for (const it of items) {
    if (it.type !== 'comment') {
      out.push(it);
      continue;
    }
    const lines = it.lines;
    let pending = [];
    let pendingGap = it.gap;
    const flushComment = () => {
      if (pending.length) {
        out.push({ type: 'comment', lines: pending, gap: pendingGap, raw: pending.join('\n') });
        pendingGap = [];
      }
      pending = [];
    };
    let k = 0;
    while (k < lines.length) {
      const trimmed = lines[k].replace(/^[ \t]+/, '');
      if (ADDRESS_LINE.test(trimmed)) {
        const block = tryDisabled(lines, k);
        if (block) {
          flushComment();
          out.push({ ...block.site, gap: pendingGap, raw: lines.slice(k, block.end).join('\n'), disabled: true });
          pendingGap = [];
          k = block.end;
          continue;
        }
      }
      pending.push(lines[k]);
      k++;
    }
    flushComment();
  }
  return out;
}

function tryDisabled(lines, from) {
  let depth = 0;
  const stripped = [];
  for (let k = from; k < lines.length; k++) {
    const s = lines[k].replace(/^[ \t]*#/, '');
    stripped.push(s);
    try {
      for (const t of tokenize(s)) {
        if (t.comment) continue;
        if (t.text === '{') depth++;
        else if (t.text === '}') depth--;
      }
    } catch {
      return null;
    }
    if (depth <= 0) {
      if (depth < 0) return null;
      try {
        const f = parse(stripped.join('\n'));
        const sites = f.items.filter((x) => x.type !== 'comment');
        if (sites.length !== 1 || sites[0].type !== 'site' || sites[0].braceless) return null;
        const site = { ...sites[0] };
        delete site.gap;
        delete site.raw;
        return { site: { ...site, leading: [] }, end: k + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A comment run directly above a block (no blank line) belongs to it. */
function attachLeading(items) {
  const out = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    it.leading = it.leading ?? [];
    const next = items[k + 1];
    if (it.type === 'comment' && next && next.type !== 'comment' && next.gap.length === 0) {
      next.leading = [...it.lines];
      next.gap = it.gap;
      next.raw = `${it.lines.join('\n')}\n${next.raw}`;
      next.rawIncludesLeading = true;
      continue;
    }
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Serializer
// ---------------------------------------------------------------------------

function nodeLines(nodes, depth, out, unit) {
  const ind = unit.repeat(depth);
  nodes.forEach((nd, idx) => {
    if (nd.gap && idx > 0) out.push('');
    if (nd.type === 'comment') {
      out.push(ind + nd.text);
      return;
    }
    let head = nd.tokens.join(' ');
    if (nd.body) head += ' {';
    if (nd.comment) head += ` ${nd.comment}`;
    out.push(ind + head);
    if (nd.body) {
      nodeLines(nd.body, depth + 1, out, unit);
      out.push(`${ind}}`);
    }
  });
}

function blockHead(it) {
  switch (it.type) {
    case 'global': return '{';
    case 'snippet': return `(${it.name}) {`;
    case 'route': return `&(${it.name}) {`;
    case 'site': return `${it.addresses.join(', ')} {`;
    default: return '';
  }
}

/** Canonical text of one top-level item (without its leading gap). */
export function formatItem(it) {
  if (it.type === 'comment') return it.lines.join('\n');
  const out = [...(it.leading ?? [])];
  const body = [];
  const head = blockHead(it) + (it.headComment ? ` ${it.headComment}` : '');
  body.push(head);
  nodeLines(it.body, 1, body, it.indent || '\t');
  body.push('}');
  if (it.disabled) {
    for (const l of body) out.push(l ? `#${l}` : '#');
  } else {
    out.push(...body);
  }
  return out.join('\n');
}

export function serialize(file) {
  const out = [];
  file.items.forEach((it, idx) => {
    const gap = it.gap ?? (idx === 0 ? [] : ['']);
    out.push(...gap);
    if (it.raw != null && !(it.leading?.length && !it.rawIncludesLeading)) {
      out.push(it.raw);
    } else {
      out.push(formatItem(it));
    }
  });
  out.push(...(file.trailing ?? []));
  let text = out.join('\n');
  if (file.endsWithNewline !== false) text += '\n';
  return file.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** Parse a single block given as text (used by per-block raw editing). */
export function parseItem(text) {
  const f = parse(text);
  const blocks = f.items.filter((x) => x.type !== 'comment');
  if (blocks.length !== 1) {
    throw new CaddyfileError(blocks.length ? 'expected exactly one block' : 'no block found');
  }
  const it = blocks[0];
  // Comment lines above the block stay with it.
  if (f.items[0] !== it && f.items[0].type === 'comment') {
    it.leading = [...f.items[0].lines, ...(it.leading ?? [])];
  }
  it.raw = null;
  it.gap = [];
  delete it.rawIncludesLeading;
  return it;
}

// ---------------------------------------------------------------------------
//  Editing helpers. All of these return new objects (the UI treats the model
//  as immutable) and clear `raw` on whatever they touch.
// ---------------------------------------------------------------------------

export const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

/** Mark an item edited: it will be re-emitted in canonical form. */
export function touched(it) {
  const copy = clone(it);
  copy.raw = null;
  delete copy.rawIncludesLeading;
  return copy;
}

export const directive = (tokens, body = null, extra = {}) => ({
  type: 'directive',
  tokens: tokens.map((t) => (typeof t === 'string' ? t : String(t))),
  body,
  comment: null,
  gap: false,
  ...extra,
});

/** Depth-first walk over directives. `fn(node, parentList, index, depth)`. */
export function walk(nodes, fn, depth = 0) {
  if (!nodes) return;
  nodes.forEach((nd, idx) => {
    if (nd.type !== 'directive') return;
    fn(nd, nodes, idx, depth);
    if (nd.body) walk(nd.body, fn, depth + 1);
  });
}

export function findAll(nodes, name) {
  const out = [];
  walk(nodes, (nd) => {
    if (nd.tokens[0] === name) out.push(nd);
  });
  return out;
}

export const siteLabel = (it) => it.addresses.map(unquote).join(', ');

/**
 * Host name an address refers to, if it names one: strips scheme, port and
 * path. Wildcards and bare ports return null.
 */
export function addressHost(addr) {
  let a = unquote(addr).trim();
  a = a.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  a = a.split('/')[0];
  if (a.startsWith('[')) return null; // IPv6 literal
  a = a.replace(/:\d+$/, '');
  if (!a || a.startsWith(':') || a.includes('*') || a.includes('{')) return null;
  return a.toLowerCase();
}

// --- reverse proxy -------------------------------------------------------

/** Every reverse_proxy in the site, wherever it is nested. */
export function proxies(body) {
  return findAll(body, 'reverse_proxy');
}

/** Upstream tokens of a reverse_proxy: its args after an optional matcher, plus `to` subdirectives. */
export function upstreamsOf(nd) {
  const args = nd.tokens.slice(1);
  const ups = args.filter((a, i) => !(i === 0 && isMatcherToken(a)));
  for (const sub of nd.body ?? []) {
    if (sub.type === 'directive' && sub.tokens[0] === 'to') ups.push(...sub.tokens.slice(1));
  }
  return ups;
}

export function isMatcherToken(t) {
  return t === '*' || t.startsWith('@') || (t.startsWith('/') && !t.startsWith('//'));
}

// --- imports --------------------------------------------------------------

export function importsOf(body) {
  return body
    .filter((n) => n.type === 'directive' && n.tokens[0] === 'import')
    .map((n) => unquote(n.tokens[1] ?? ''));
}

// --- IP allowlist ----------------------------------------------------------
//
// Recognises the pattern recommended in Caddyfile.example:
//
//     @name not remote_ip <ranges...>
//     handle @name {
//         respond 403
//     }
//
// `client_ip` is accepted as well as `remote_ip`.

export function findAllowlist(body) {
  for (const nd of body) {
    if (nd.type !== 'directive') continue;
    const [m, not, kind, ...ranges] = nd.tokens;
    if (!m?.startsWith('@') || not !== 'not' || !['remote_ip', 'client_ip'].includes(kind) || nd.body) continue;
    const handler = body.find(
      (h) => h.type === 'directive' && (h.tokens[0] === 'handle' || h.tokens[0] === 'respond' || h.tokens[0] === 'abort') && h.tokens[1] === m
    );
    return { matcher: m, kind, ranges, matcherNode: nd, handler };
  }
  return null;
}

/**
 * Directives that stay at the site's top level when the allowlist wraps the
 * rest in a catch-all `handle`: site-wide settings, and handlers Caddy orders
 * before `handle` anyway, so they behave the same either way.
 */
const SITE_LEVEL = new Set([
  'tls', 'log', 'import', 'bind', 'encode', 'header', 'request_header', 'skip_log', 'log_skip',
  'log_append', 'log_name', 'fs', 'vars', 'map', 'tracing', 'request_body', 'basic_auth',
  'basicauth', 'forward_auth', 'handle_errors', 'templates',
]);

/**
 * Turn the allowlist on (with `ranges`) or off (`ranges` = null). Enabling it
 * on a site that is not structured with `handle` blocks moves the site's
 * handlers into a catch-all `handle`, because Caddy sorts top-level
 * directives by its own order and a bare `respond` would not reliably run
 * first.
 *
 * Path-matched `handle`/`handle_path` blocks are moved inside the catch-all
 * too: Caddy sorts same-named directives with the longest path matcher first,
 * so `handle /api/*` left at the top level would run before `handle @blocked`
 * and bypass the allowlist. Returns a new body.
 */
export function setAllowlist(body, ranges, kind = 'remote_ip') {
  const b = clone(body);
  const found = findAllowlist(b);

  if (!ranges || !ranges.length) {
    if (!found) return b;
    return b.filter((n) => n !== found.matcherNode && n !== found.handler);
  }

  if (found) {
    found.matcherNode.tokens = [found.matcher, 'not', found.kind, ...ranges];
    if (!found.handler) b.splice(b.indexOf(found.matcherNode) + 1, 0, block403(found.matcher));
    return b;
  }

  const name = uniqueMatcher(b, '@blocked');
  const matcher = directive([name, 'not', kind, ...ranges]);
  const deny = block403(name);

  const lead = [];
  const moved = [];
  for (const n of b) {
    if (n.type === 'comment') {
      (moved.length ? moved : lead).push(n);
      continue;
    }
    const head = n.tokens[0];
    if (SITE_LEVEL.has(head) || head.startsWith('@')) lead.push(n);
    else if (head === 'handle' && n.tokens.length === 1 && n.body) moved.push(...n.body); // unwrap a bare catch-all
    else moved.push(n);
  }
  const out = [...lead, { ...matcher, gap: lead.length > 0 }, deny];
  if (moved.length) {
    out.push(directive(['handle'], moved.map((n, i) => ({ ...n, gap: i === 0 ? false : n.gap })), { gap: true }));
  }
  return out;
}

function block403(name) {
  return directive(['handle', name], [directive(['respond', '403'])]);
}

function uniqueMatcher(body, base) {
  const used = new Set();
  walk(body, (n) => {
    if (n.tokens[0].startsWith('@')) used.add(n.tokens[0]);
  });
  if (!used.has(base)) return base;
  for (let k = 2; ; k++) if (!used.has(`${base}${k}`)) return `${base}${k}`;
}

// --- TLS --------------------------------------------------------------------

/**
 * Summarise how the site's `tls` directive gets a certificate, from its
 * arguments (options in its block are independent of this):
 *   auto | internal | email | files | custom
 */
export function tlsMode(body) {
  const t = body.find((n) => n.type === 'directive' && n.tokens[0] === 'tls');
  if (!t) return { mode: 'auto' };
  const args = t.tokens.slice(1).map(unquote);
  if (!args.length) return { mode: 'auto', node: t };
  if (args[0] === 'internal' && args.length === 1) return { mode: 'internal', node: t };
  if (args.length === 1 && args[0].includes('@')) return { mode: 'email', email: args[0], node: t };
  if (args.length === 2) return { mode: 'files', cert: args[0], key: args[1], node: t };
  return { mode: 'custom', node: t };
}

// ---------------------------------------------------------------------------
//  Templates for new sites
// ---------------------------------------------------------------------------

export function newSite({ addresses, kind, target, imports = [], allow = [], flush = false, extra = {} }) {
  let body = imports.map((name) => directive(['import', quote(name)]));
  const handler = [];
  if (kind === 'proxy') {
    const ups = String(target || '').split(/[\s,]+/).filter(Boolean).map(quote);
    handler.push(directive(['reverse_proxy', ...ups], flush ? [directive(['flush_interval', '-1'])] : null));
  } else if (kind === 'files') {
    handler.push(directive(['root', '*', quote(target || '/srv')]));
    handler.push(directive(['file_server'], extra.browse ? [directive(['browse'])] : null));
  } else if (kind === 'redirect') {
    handler.push(directive(['redir', quote(target || 'https://example.com{uri}'), extra.permanent ? 'permanent' : 'temporary'].filter(Boolean)));
  } else if (kind === 'respond') {
    handler.push(directive(['respond', quote(target || 'OK'), String(extra.status || 200)]));
  }
  body = [...body, ...handler];
  if (handler.length && imports.length) handler[0].gap = true;
  if (allow.length) body = setAllowlist(body, allow);
  return {
    type: 'site',
    addresses: addresses.map(quote),
    body,
    gap: [''],
    leading: [],
    raw: null,
    disabled: false,
  };
}
