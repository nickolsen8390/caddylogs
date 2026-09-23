// Form controls for the Caddy settings pages. Each field in caddyschema.js is
// rendered by <Field>, with its help available from the ? next to its label.

import { useEffect, useId, useRef, useState } from 'react';
import { checkValue, isEmptyValue, readField } from '../lib/caddyedit.js';

// ---------------------------------------------------------------------------
//  Help tooltip
// ---------------------------------------------------------------------------

/**
 * A ? button that shows help on hover or keyboard focus (and on click, for
 * touch screens). `dir` names the Caddyfile directive the option writes, so
 * people learning Caddy can connect the form to the file.
 */
export function Help({ text, example, placeholder, dir }) {
  const id = useId();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState('right');
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    setSide(r && r.left > window.innerWidth - 340 ? 'left' : 'right');
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.parentElement?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (!text) return null;
  const dirs = Array.isArray(dir) ? dir[0] : dir;
  return (
    <span className="help" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        ref={ref}
        className="help-btn"
        aria-label="Help"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          open ? setOpen(false) : show();
        }}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className={`help-pop ${side}`}>
          <span>{text}</span>
          {placeholder && <span className="help-meta"><strong>Default:</strong> {placeholder}</span>}
          {example && <span className="help-meta"><strong>Example:</strong> <code>{example}</code></span>}
          {dirs && <span className="help-meta"><strong>Caddyfile:</strong> <code>{dirs}</code></span>}
        </span>
      )}
    </span>
  );
}

export function Label({ field, htmlFor, children }) {
  return (
    <span className="f-label">
      <label htmlFor={htmlFor}>{children ?? field.label}</label>
      <Help text={field.help} example={field.example} placeholder={helpDefault(field)} dir={field.dir ?? field.directive} />
    </span>
  );
}

/** Placeholders double as the default, unless they are only a prompt. */
function helpDefault(f) {
  if (f.defaultText) return f.defaultText;
  if (!f.placeholder || f.type === 'rows') return null;
  if (/^(e\.g\.|none$|anything$)/i.test(f.placeholder)) return null;
  return f.placeholder;
}

// ---------------------------------------------------------------------------
//  Inputs
// ---------------------------------------------------------------------------

/**
 * Text input that keeps what is typed while it has focus. The model
 * normalises values (quoting, splitting words), so echoing it straight back
 * would, for example, swallow a space before the next word is typed.
 */
export function DraftInput({ value, onChange, className = 'input', ...rest }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <input
      {...rest}
      className={className}
      value={focused ? draft : value}
      spellCheck={false}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

function TextField({ field, value, onChange, id }) {
  const problem = checkValue(field.kind, value);
  const listId = field.suggestions ? `${id}-dl` : undefined;
  return (
    <>
      <DraftInput
        id={id}
        className={`input${field.mono === false ? '' : ' mono'}`}
        value={value}
        placeholder={field.placeholder}
        list={listId}
        onChange={onChange}
      />
      {listId && (
        <datalist id={listId}>
          {field.suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
      {problem && <span className="field-warn">{problem}</span>}
    </>
  );
}

function SelectField({ field, value, onChange, id }) {
  const [head, ...rest] = String(value ?? '').split(/\s+/).filter(Boolean);
  const opt = field.options.find((o) => o.value === (head ?? ''));
  const known = Boolean(opt) || !value;
  return (
    <div className="hstack" style={{ flexWrap: 'nowrap', gap: 6 }}>
      <select
        id={id}
        className="input"
        style={{ flex: 1, minWidth: 0 }}
        value={known ? head ?? '' : '__custom'}
        onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}
      >
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {!known && <option value="__custom">{value} (custom)</option>}
      </select>
      {opt?.param && (
        <DraftInput
          className="input mono"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={opt.param}
          value={rest.join(' ')}
          onChange={(v) => onChange(`${head} ${v}`.trim())}
        />
      )}
    </div>
  );
}

function ListField({ field, value, onChange, id }) {
  const text = value.join(' ');
  const problems = field.kind ? value.map((v) => checkValue(field.kind, v)).filter(Boolean) : [];
  return (
    <>
      <DraftInput
        id={id}
        className="input mono"
        value={text}
        placeholder={field.placeholder}
        onChange={(v) => onChange(v.split(/[\s,]+/).filter(Boolean))}
      />
      <span className="field-hint faint">Separate several with spaces.</span>
      {problems[0] && <span className="field-warn">{problems[0]}</span>}
    </>
  );
}

function ChecksField({ field, value, onChange }) {
  return (
    <div className="checks">
      {field.options.map((o) => (
        <label key={o.value} className="check">
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? field.options.map((x) => x.value).filter((v) => v === o.value || value.includes(v))
                  : value.filter((v) => v !== o.value)
              )
            }
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function RowsField({ field, value, onChange }) {
  const cols = field.columns;
  const [draft, setDraft] = useState(() => cols.map(() => ''));
  const set = (i, k, v) => onChange(value.map((row, x) => (x === i ? row.map((c, y) => (y === k ? v : c)) : row)));
  const add = () => {
    if (!draft.some((c) => c.trim()) && !cols.every((c) => c.optional)) return;
    onChange([...value, draft]);
    setDraft(cols.map(() => ''));
  };
  const grid = { gridTemplateColumns: `${cols.map((c) => (c.rest ? 'minmax(0,2fr)' : 'minmax(0,1fr)')).join(' ')} auto` };
  return (
    <div className="rows-field">
      {value.map((row, i) => (
        <div key={i} className="rows-row" style={grid}>
          {cols.map((c, k) => (
            <DraftInput key={k} className="input mono" value={row[k] ?? ''} placeholder={c.placeholder} onChange={(v) => set(i, k, v)} />
          ))}
          <button type="button" className="btn sm" title="Remove" onClick={() => onChange(value.filter((_, x) => x !== i))}>✕</button>
        </div>
      ))}
      <div className="rows-row rows-new" style={grid}>
        {cols.map((c, k) => (
          <input
            key={k}
            className="input mono"
            value={draft[k]}
            placeholder={c.placeholder}
            spellCheck={false}
            onChange={(e) => setDraft(draft.map((x, y) => (y === k ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        ))}
        <button type="button" className="btn sm" onClick={add}>Add</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  One field from the schema
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {object|null} p.root   the block the field reads from (null: nothing yet)
 * @param {object} p.field       schema entry
 * @param {(value:any)=>void} p.onWrite
 */
export function Field({ root, field, onWrite, wide }) {
  const id = useId();
  let value;
  try {
    value = root ? readField(root, field) : emptyOf(field);
  } catch {
    value = emptyOf(field);
  }
  const set = !isEmptyValue(field, value);

  if (field.type === 'flag') {
    return (
      <div className={`f-field f-flag${set ? ' is-set' : ''}`}>
        <label className="check">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onWrite(e.target.checked)} />
          <span>{field.label}</span>
        </label>
        <Help text={field.help} example={field.example} dir={field.dir} />
      </div>
    );
  }

  let control;
  if (field.type === 'select') control = <SelectField field={field} value={value} onChange={onWrite} id={id} />;
  else if (field.type === 'list' || field.listLike) control = <ListField field={field} value={value} onChange={onWrite} id={id} />;
  else if (field.type === 'checks') control = <ChecksField field={field} value={value} onChange={onWrite} />;
  else if (field.type === 'rows') control = <RowsField field={field} value={value} onChange={onWrite} />;
  else control = <TextField field={field} value={value} onChange={onWrite} id={id} />;

  return (
    <div className={`f-field${set ? ' is-set' : ''}${wide || field.type === 'rows' ? ' wide' : ''}`}>
      <Label field={field} htmlFor={id} />
      {control}
    </div>
  );
}

function emptyOf(f) {
  if (f.type === 'flag') return false;
  if (['list', 'checks', 'rows'].includes(f.type) || f.listLike) return [];
  return '';
}

export function FieldGrid({ root, fields, onWrite }) {
  return (
    <div className="f-grid">
      {fields.map((f) => (
        <Field key={f.id} root={root} field={f} onWrite={(v) => onWrite(f, v)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Sections
// ---------------------------------------------------------------------------

/** A top-level settings section: a panel whose body can be collapsed. */
export function Section({ id, title, help, count, children, defaultOpen = true, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel f-section" id={id ? `sec-${id}` : undefined}>
      <header className="panel-head f-section-head">
        <button type="button" className="f-collapse" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="f-caret">{open ? '▾' : '▸'}</span>
          <h2>{title}</h2>
        </button>
        <Help text={help} />
        {count > 0 && <span className="chip ok">{count} set</span>}
        <span className="spacer" />
        {actions}
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}

/** A group of related options inside a section, collapsed until it is used. */
export function Group({ title, help, count, children, defaultOpen }) {
  // Opened or closed by the user from then on; never snaps shut mid-edit.
  const [open, setOpen] = useState(() => defaultOpen ?? count > 0);
  return (
    <details className="f-group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="f-group-title">{title}</span>
        <Help text={help} />
        {count > 0 && <span className="chip ok">{count} set</span>}
      </summary>
      <div className="f-group-body">{children}</div>
    </details>
  );
}
