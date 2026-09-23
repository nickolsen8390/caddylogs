import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCaddy } from './CaddyLayout.jsx';
import { importsOf, quote, siteLabel, unquote } from '../../lib/caddyfile.js';
import { Banner, Chip, Empty, Panel } from '../../components/ui.jsx';
import { FieldGrid, Group, Section } from '../../components/caddyform.jsx';
import { countSet, writeField } from '../../lib/caddyedit.js';
import { GLOBAL_GROUPS } from '../../lib/caddyschema.js';
import { DirectiveTree, PromptModal } from '../../components/caddy.jsx';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export default function GlobalOptions() {
  const { model, parseError, canEdit, update, updateItem } = useCaddy();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(null);

  if (parseError) {
    return (
      <Banner level="error" title="The Caddyfile could not be parsed">
        {parseError.message}. <Link to="/caddy/raw">Fix it in the Caddyfile editor</Link>.
      </Banner>
    );
  }

  const globalIdx = model.items.findIndex((x) => x.type === 'global');
  const blocks = model.items.map((it, index) => ({ it, index })).filter((x) => x.it.type === 'snippet' || x.it.type === 'route');
  const sites = model.items.filter((x) => x.type === 'site');
  const usedBy = (name) => sites.filter((s) => importsOf(s.body).includes(name) || s.body.some((n) => n.type === 'directive' && n.tokens[0] === 'invoke' && unquote(n.tokens[1]) === name));
  const names = new Set(blocks.map((b) => b.it.name));

  return (
    <div className="vstack" style={{ gap: 14 }}>
      <GlobalPanel
        item={globalIdx >= 0 ? model.items[globalIdx] : null}
        canEdit={canEdit}
        onCreate={() =>
          update((m) => {
            if (m.items[0]) m.items[0] = { ...m.items[0], gap: [''], raw: m.items[0].raw };
            m.items.unshift({ type: 'global', body: [], gap: [], leading: [], raw: null });
            return m;
          })
        }
        onRemove={() =>
          update((m) => {
            m.items.splice(globalIdx, 1);
            if (m.items[0]) m.items[0] = { ...m.items[0], gap: [] };
            return m;
          })
        }
        onChange={(body) => updateItem(globalIdx, (it) => { it.body = body; })}
        onField={(f, v) => updateItem(globalIdx, (it) => { writeField(it, f, v); })}
      />

      <div className="hstack">
        <h2 style={{ margin: 0, fontSize: 14 }}>Snippets</h2>
        <span className="faint" style={{ fontSize: 12 }}>
          Reusable blocks. A site pulls one in with <code>import name</code>.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={!canEdit} onClick={() => setAdding(true)}>+ Add snippet</button>
      </div>

      {blocks.length === 0 && <Panel><Empty>No snippets defined.</Empty></Panel>}

      {blocks.map(({ it, index }) => {
        const users = usedBy(it.name);
        return (
          <Panel
            key={index}
            title={
              <span className="hstack" style={{ gap: 8 }}>
                <span className="mono">{it.type === 'route' ? `&(${it.name})` : `(${it.name})`}</span>
                {it.type === 'route' && <Chip>named route</Chip>}
                <span className="faint" style={{ fontWeight: 400 }} title={users.map(siteLabel).join('\n')}>
                  used by {users.length} site{users.length === 1 ? '' : 's'}
                </span>
              </span>
            }
            actions={
              canEdit && (
                <span className="hstack" style={{ gap: 4 }}>
                  <button className="btn sm" onClick={() => setRenaming({ index, name: it.name })}>Rename</button>
                  <button
                    className="btn sm danger"
                    onClick={() => {
                      const warn = users.length
                        ? `${users.length} site(s) import "${it.name}"; Caddy will refuse the config until those imports are removed too. Delete anyway?`
                        : `Delete snippet "${it.name}"?`;
                      if (window.confirm(warn)) update((m) => { m.items.splice(index, 1); return m; });
                    }}
                  >
                    Delete
                  </button>
                </span>
              )
            }
          >
            <DirectiveTree
              nodes={it.body}
              readOnly={!canEdit}
              context="snippet"
              onChange={(body) => updateItem(index, (x) => { x.body = body; })}
            />
          </Panel>
        );
      })}

      {adding && (
        <PromptModal
          title="Add a snippet"
          label="Name (letters, digits, - _ .)"
          placeholder="security_headers"
          confirm="Add"
          validate={(v) => (!NAME_RE.test(v.trim()) ? 'Use letters, digits, dashes, dots and underscores.' : names.has(v.trim()) ? 'That name is taken.' : null)}
          onClose={() => setAdding(false)}
          onSubmit={(name) => {
            setAdding(false);
            update((m) => {
              // After the global block and existing snippets, before the first site.
              let at = 0;
              while (at < m.items.length && ['global', 'snippet', 'route', 'comment'].includes(m.items[at].type)) at++;
              m.items.splice(at, 0, { type: 'snippet', name, body: [], gap: at === 0 ? [] : [''], leading: [], raw: null });
              if (m.items[at + 1] && !m.items[at + 1].gap?.length) m.items[at + 1] = { ...m.items[at + 1], gap: [''] };
              return m;
            });
          }}
        />
      )}

      {renaming && (
        <PromptModal
          title={`Rename snippet "${renaming.name}"`}
          label="New name — imports in every site are updated too"
          initial={renaming.name}
          confirm="Rename"
          validate={(v) => (!NAME_RE.test(v.trim()) ? 'Use letters, digits, dashes, dots and underscores.' : v.trim() !== renaming.name && names.has(v.trim()) ? 'That name is taken.' : null)}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            const { index, name: old } = renaming;
            setRenaming(null);
            if (name === old) return;
            update((m) => {
              m.items = m.items.map((x, k) => {
                if (k === index) return { ...x, name, raw: null, rawIncludesLeading: false };
                if (x.type !== 'site' && x.type !== 'snippet' && x.type !== 'route') return x;
                let changed = false;
                const body = x.body.map((n) => {
                  if (n.type === 'directive' && (n.tokens[0] === 'import' || n.tokens[0] === 'invoke') && unquote(n.tokens[1]) === old) {
                    changed = true;
                    return { ...n, tokens: [n.tokens[0], quote(name), ...n.tokens.slice(2)] };
                  }
                  return n;
                });
                return changed ? { ...x, body, raw: null, rawIncludesLeading: false } : x;
              });
              return m;
            });
          }}
        />
      )}
    </div>
  );
}

function GlobalPanel({ item, canEdit, onCreate, onRemove, onChange, onField }) {
  if (!item) {
    return (
      <Panel title="Global options">
        <div className="vstack" style={{ gap: 8 }}>
          <span className="faint">
            No global options block. Caddy's defaults apply: automatic HTTPS for every public name, certificates from
            Let's Encrypt or ZeroSSL.
          </span>
          <div>
            <button className="btn sm" disabled={!canEdit} onClick={onCreate}>+ Add global options</button>
          </div>
        </div>
      </Panel>
    );
  }
  const hasAdmin = item.body.some((x) => x.type === 'directive' && x.tokens[0] === 'admin');

  return (
    <Section
      id="global"
      title="Global options"
      help="Settings for Caddy as a whole and defaults for every site. A site's own settings override these."
      actions={canEdit && <button className="btn sm danger" onClick={() => window.confirm('Remove the whole global options block?') && onRemove()}>Remove block</button>}
    >
      {hasAdmin && (
        <Banner level="warn">
          The <code>admin</code> option is set here. This interface reloads Caddy through its admin endpoint, and will
          refuse any change that turns it off or moves it away from the address in <code>CADDY_ADMIN</code>.
        </Banner>
      )}
      <fieldset disabled={!canEdit} className="plain-fieldset">
        <div className="vstack" style={{ gap: 10 }}>
          {GLOBAL_GROUPS.map((g) => (
            <Group key={g.id} title={g.title} help={g.help} count={countSet(item, g.fields)} defaultOpen>
              <FieldGrid root={item} fields={g.fields} onWrite={onField} />
            </Group>
          ))}
          <Group title="All global options" help="Every line of the global block, including options without a form above." count={0}>
            <DirectiveTree nodes={item.body} readOnly={!canEdit} context="global" onChange={onChange} />
          </Group>
        </div>
      </fieldset>
    </Section>
  );
}
