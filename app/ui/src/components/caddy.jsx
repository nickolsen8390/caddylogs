// Building blocks for the Caddy configuration pages.

import { useEffect, useMemo, useRef, useState } from 'react';
import { directive, quote, tokenize, unquote } from '../lib/caddyfile.js';
import { diffLines, diffStats, hunks } from '../lib/diff.js';

// ---------------------------------------------------------------------------
//  Modal
// ---------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal panel${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="panel-head">
          <h2>{title}</h2>
          <span className="spacer" />
          {onClose && (
            <button className="btn sm" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Small modal asking for one line of text. */
export function PromptModal({ title, label, initial = '', placeholder, confirm = 'OK', onSubmit, onClose, validate }) {
  const [value, setValue] = useState(initial);
  const problem = validate ? validate(value) : null;
  const submit = (e) => {
    e?.preventDefault();
    if (!problem && value.trim()) onSubmit(value.trim());
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={Boolean(problem) || !value.trim()}>
            {confirm}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="field">
        <label>{label}</label>
        <input className="input" autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
        {problem && <span className="field-error">{problem}</span>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Code editor: a textarea with a line-number gutter. Tab inserts a tab.
// ---------------------------------------------------------------------------

export function CodeEditor({ value, onChange, readOnly = false, errorLine = null, height = '62vh', jumpTo = null }) {
  const taRef = useRef(null);
  const gutterRef = useRef(null);
  const count = useMemo(() => value.split('\n').length, [value]);

  useEffect(() => {
    if (!jumpTo || !taRef.current) return;
    const ta = taRef.current;
    const lines = ta.value.split('\n');
    const idx = lines.slice(0, jumpTo - 1).reduce((s, l) => s + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(idx, idx + (lines[jumpTo - 1]?.length ?? 0));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (jumpTo - 5) * lh);
  }, [jumpTo]);

  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || readOnly || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
    onChange?.(ta.value);
  };

  return (
    <div className="code-editor" style={{ height }}>
      <div className="code-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={errorLine === i + 1 ? 'err' : undefined}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="code-text"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Diff
// ---------------------------------------------------------------------------

export function DiffView({ before, after, context = 3, maxHeight = '52vh' }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(lines);
  const shown = useMemo(() => hunks(lines, context), [lines, context]);
  if (!stats.add && !stats.del) return <div className="empty">No differences.</div>;
  return (
    <div className="vstack" style={{ gap: 6 }}>
      <div className="hstack" style={{ fontSize: 12 }}>
        <span style={{ color: 'var(--green)' }}>+{stats.add}</span>
        <span style={{ color: 'var(--red)' }}>−{stats.del}</span>
        <span className="faint">lines</span>
      </div>
      <div className="diff" style={{ maxHeight }}>
        {shown.map((l, k) =>
          l.type === 'skip' ? (
            <div key={k} className="diff-skip">⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
          ) : (
            <div key={k} className={`diff-line ${l.type}`}>
              <span className="ln">{l.a ?? ''}</span>
              <span className="ln">{l.b ?? ''}</span>
              <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              <span className="txt">{l.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export const diffCount = (a, b) => diffStats(diffLines(a, b));

// ---------------------------------------------------------------------------
//  Editable list of short strings (addresses, upstreams, IP ranges)
// ---------------------------------------------------------------------------

export function ListEditor({ values, onChange, placeholder, addLabel = 'Add', validate, mono = true }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return;
    if (validate && parts.some((p) => validate(p))) return;
    onChange([...values, ...parts]);
    setDraft('');
  };
  const draftProblem = draft.trim() && validate ? draft.split(/[\s,]+/).filter(Boolean).map(validate).find(Boolean) : null;
  return (
    <div className="vstack" style={{ gap: 6 }}>
      {values.map((v, i) => (
        <div key={i} className="hstack" style={{ flexWrap: 'nowrap' }}>
          <input
            className={`input${mono ? ' mono' : ''}`}
            style={{ flex: 1 }}
            value={v}
            onChange={(e) => onChange(values.map((x, k) => (k === i ? e.target.value : x)))}
          />
          <button className="btn sm" title="Remove" onClick={() => onChange(values.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="hstack" style={{ flexWrap: 'nowrap' }}>
        <input
          className={`input${mono ? ' mono' : ''}`}
          style={{ flex: 1 }}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn sm" onClick={add} disabled={!draft.trim() || Boolean(draftProblem)}>
          {addLabel}
        </button>
      </div>
      {draftProblem && <span className="field-error">{draftProblem}</span>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span>{label}</span>
        {hint && <span className="faint toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
//  Directive tree: edits any block, to any depth. This is what makes every
//  Caddyfile construct editable, including the ones no form knows about.
// ---------------------------------------------------------------------------

// Suggestions by enclosing directive. Anything may be typed; these are hints.
const SUGGEST = {
  site: [
    'abort', 'acme_server', 'basic_auth', 'bind', 'encode', 'error', 'file_server', 'forward_auth',
    'fs', 'handle', 'handle_errors', 'handle_path', 'header', 'import', 'intercept', 'invoke', 'log',
    'log_append', 'log_skip', 'map', 'method', 'metrics', 'php_fastcgi', 'push', 'redir',
    'request_body', 'request_header', 'respond', 'reverse_proxy', 'rewrite', 'root', 'route',
    'templates', 'tls', 'tracing', 'try_files', 'uri', 'vars',
  ],
  global: [
    'debug', 'email', 'acme_ca', 'acme_ca_root', 'acme_dns', 'acme_eab', 'auto_https', 'cert_issuer',
    'default_bind', 'default_sni', 'fallback_sni', 'grace_period', 'http_port', 'https_port',
    'key_type', 'local_certs', 'log', 'ocsp_stapling', 'on_demand_tls', 'order', 'persist_config',
    'preferred_chains', 'renew_interval', 'servers', 'skip_install_trust', 'storage', 'storage_clean_interval',
  ],
  reverse_proxy: [
    'to', 'lb_policy', 'lb_retries', 'lb_try_duration', 'lb_try_interval', 'health_uri', 'health_port',
    'health_interval', 'health_timeout', 'health_status', 'health_headers', 'fail_duration', 'max_fails',
    'unhealthy_status', 'unhealthy_latency', 'flush_interval', 'header_up', 'header_down', 'transport',
    'buffer_requests', 'buffer_responses', 'trusted_proxies', 'handle_response', 'replace_status',
    'request_buffers', 'response_buffers', 'stream_timeout', 'stream_close_delay', 'dynamic',
  ],
  transport: [
    'tls', 'tls_insecure_skip_verify', 'tls_server_name', 'tls_trust_pool', 'dial_timeout',
    'dial_fallback_delay', 'read_timeout', 'write_timeout', 'response_header_timeout', 'keepalive',
    'keepalive_idle_conns', 'versions', 'max_conns_per_host', 'read_buffer', 'write_buffer', 'proxy_protocol',
  ],
  tls: ['protocols', 'ciphers', 'curves', 'alpn', 'load', 'ca', 'ca_root', 'dns', 'resolvers', 'propagation_timeout', 'on_demand', 'client_auth', 'issuer', 'get_certificate', 'key_type', 'eab'],
  log: ['output', 'format', 'level', 'include', 'exclude', 'hostnames', 'sampling', 'no_hostname'],
  output: ['roll_size', 'roll_keep', 'roll_keep_for', 'roll_local_time', 'roll_uncompressed', 'mode'],
  encode: ['gzip', 'zstd', 'minimum_length', 'match'],
  file_server: ['browse', 'hide', 'index', 'root', 'precompressed', 'status', 'disable_canonical_uris', 'pass_thru', 'fs'],
  header: ['defer'],
  basic_auth: [],
  servers: ['name', 'listener_wrappers', 'timeouts', 'trusted_proxies', 'client_ip_headers', 'metrics', 'max_header_size', 'enable_full_duplex', 'log_credentials', 'protocols', 'strict_sni_host', 'keepalive_interval'],
  timeouts: ['read_body', 'read_header', 'write', 'idle'],
  matcher: ['client_ip', 'remote_ip', 'expression', 'file', 'header', 'header_regexp', 'host', 'method', 'not', 'path', 'path_regexp', 'protocol', 'query', 'vars', 'vars_regexp'],
};
SUGGEST.handle = SUGGEST.site;
SUGGEST.handle_path = SUGGEST.site;
SUGGEST.handle_errors = SUGGEST.site;
SUGGEST.route = SUGGEST.site;
SUGGEST.snippet = SUGGEST.site;
SUGGEST.not = SUGGEST.matcher;

const contextOf = (name) => {
  if (name.startsWith('@')) return 'matcher';
  return SUGGEST[name] ? name : 'other';
};

export function DirectiveSuggestions() {
  return (
    <>
      {Object.entries(SUGGEST).map(([ctx, names]) => (
        <datalist key={ctx} id={`caddy-dl-${ctx}`}>
          {names.map((n) => <option key={n} value={n} />)}
        </datalist>
      ))}
    </>
  );
}

function TokenInput({ value, onChange, onCommitEmpty, list, className = '', placeholder, autoFocus }) {
  if (value.includes('\n')) {
    return (
      <textarea
        className={`tok tok-multi ${className}`}
        value={value}
        rows={Math.min(8, value.split('\n').length)}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    );
  }
  return (
    <input
      className={`tok ${className}`}
      value={value}
      list={list}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      size={Math.max(2, Math.min(60, value.length + 1))}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (!value && onCommitEmpty) onCommitEmpty();
      }}
    />
  );
}

/** Input for a new argument: committed on Enter or blur, dropped if empty. */
function NewToken({ onDone: done }) {
  const [v, setV] = useState('');
  // Enter unmounts the input, which can fire blur as well; finish only once.
  const finished = useRef(false);
  const onDone = (value) => {
    if (finished.current) return;
    finished.current = true;
    done(value);
  };
  return (
    <input
      className="tok"
      autoFocus
      value={v}
      placeholder="value"
      spellCheck={false}
      size={Math.max(6, v.length + 1)}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onDone('');
      }}
      onBlur={() => onDone(v)}
    />
  );
}

function AddLine({ context, onAdd, compact }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const add = () => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('#')) {
      onAdd({ type: 'comment', text: t, gap: false });
      setText('');
      return;
    }
    try {
      const toks = tokenize(t).filter((x) => !x.comment).map((x) => x.text);
      const opens = toks[toks.length - 1] === '{';
      const words = opens ? toks.slice(0, -1) : toks;
      if (!words.length) return;
      if (words.includes('{') || words.includes('}')) throw new Error('add nested blocks one line at a time');
      onAdd(directive(words, opens ? [] : null));
      setText('');
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className={`dadd${compact ? ' compact' : ''}`}>
      <input
        className="input mono"
        value={text}
        list={`caddy-dl-${context}`}
        placeholder={'+ add a line, e.g.  header X-Frame-Options DENY   (end with { for a block, # for a comment)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
      <button className="btn sm" onClick={add} disabled={!text.trim()}>Add</button>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function DirectiveTree({ nodes, onChange, context = 'site', readOnly = false }) {
  const replace = (i, nd) => onChange(nodes.map((x, k) => (k === i ? nd : x)));
  const remove = (i) => onChange(nodes.filter((_, k) => k !== i));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= nodes.length) return;
    const c = nodes.slice();
    [c[i], c[j]] = [c[j], c[i]];
    onChange(c);
  };
  const insertAt = (i, nd) => {
    const c = nodes.slice();
    c.splice(i, 0, nd);
    onChange(c);
  };

  return (
    <div className="dtree">
      {!nodes.length && <div className="faint dempty">Empty block.</div>}
      {nodes.map((nd, i) => (
        <div key={i} className={nd.gap && i > 0 ? 'dgap' : undefined}>
          {nd.type === 'comment' ? (
            <div className="drow dcomment-row">
              <span className="dcaret-spacer" />
              <input
                className="tok dcomment-input"
                value={nd.text}
                readOnly={readOnly}
                spellCheck={false}
                onChange={(e) => {
                  const v = e.target.value;
                  replace(i, { ...nd, text: v.startsWith('#') ? v : `# ${v}` });
                }}
              />
              <span className="spacer" />
              {!readOnly && <RowActions i={i} n={nodes.length} onMove={move} onRemove={remove} />}
            </div>
          ) : (
            <DirectiveRow
              node={nd}
              context={context}
              readOnly={readOnly}
              onChange={(n) => replace(i, n)}
              actions={
                !readOnly && (
                  <RowActions
                    i={i}
                    n={nodes.length}
                    onMove={move}
                    onRemove={remove}
                    onDuplicate={() => insertAt(i + 1, JSON.parse(JSON.stringify(nd)))}
                  />
                )
              }
            />
          )}
        </div>
      ))}
      {!readOnly && <AddLine context={context} onAdd={(nd) => insertAt(nodes.length, nd)} compact={nodes.length > 0} />}
    </div>
  );
}

function RowActions({ i, n, onMove, onRemove, onDuplicate }) {
  return (
    <span className="dactions">
      <button className="dbtn" title="Move up" disabled={i === 0} onClick={() => onMove(i, -1)}>↑</button>
      <button className="dbtn" title="Move down" disabled={i === n - 1} onClick={() => onMove(i, 1)}>↓</button>
      {onDuplicate && <button className="dbtn" title="Duplicate" onClick={onDuplicate}>⧉</button>}
      <button className="dbtn danger" title="Delete" onClick={() => onRemove(i)}>✕</button>
    </span>
  );
}

function DirectiveRow({ node, context, onChange, actions, readOnly }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const name = node.tokens[0] ?? '';

  const setTok = (k, v) => {
    const t = node.tokens.slice();
    t[k] = quote(v);
    onChange({ ...node, tokens: t });
  };
  const dropTok = (k) => onChange({ ...node, tokens: node.tokens.filter((_, x) => x !== k) });

  return (
    <div className="dnode">
      <div className="drow">
        {node.body ? (
          <button className="dcaret" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="dcaret-spacer" />
        )}
        <TokenInput
          className="dname"
          value={unquote(name)}
          list={`caddy-dl-${context}`}
          onChange={(v) => setTok(0, v)}
          placeholder="directive"
        />
        {node.tokens.slice(1).map((t, k) => (
          <TokenInput key={k} value={unquote(t)} onChange={(v) => setTok(k + 1, v)} onCommitEmpty={() => dropTok(k + 1)} />
        ))}
        {!readOnly &&
          (adding ? (
            <NewToken
              onDone={(v) => {
                setAdding(false);
                if (v) onChange({ ...node, tokens: [...node.tokens, quote(v)] });
              }}
            />
          ) : (
            <button className="dbtn" title="Add an argument" onClick={() => setAdding(true)}>+</button>
          ))}
        {node.body && !open && <span className="faint">{`{ ${node.body.length} }`}</span>}
        {node.comment && <span className="dcomment">{node.comment}</span>}
        <span className="spacer" />
        {!readOnly && (
          <button
            className="dbtn"
            title={node.body ? 'Remove this block (its contents are deleted)' : 'Give this directive a { } block'}
            onClick={() => {
              if (node.body?.length && !window.confirm(`Remove the block under "${unquote(name)}" and everything in it?`)) return;
              onChange({ ...node, body: node.body ? null : [] });
            }}
          >
            {node.body ? '−{ }' : '+{ }'}
          </button>
        )}
        {actions}
      </div>
      {node.body && open && (
        <div className="dchildren">
          <DirectiveTree
            nodes={node.body}
            context={contextOf(unquote(name))}
            readOnly={readOnly}
            onChange={(b) => onChange({ ...node, body: b })}
          />
        </div>
      )}
    </div>
  );
}
