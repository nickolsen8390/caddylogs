import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCaddy } from './CaddyLayout.jsx';
import { describeSite } from './Sites.jsx';
import SiteSettings from './SiteSettings.jsx';
import { formatItem, parseItem, siteLabel, unquote } from '../../lib/caddyfile.js';
import { Banner, Chip, Panel, Tabs } from '../../components/ui.jsx';
import { CodeEditor, DirectiveTree } from '../../components/caddy.jsx';

const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'directives', label: 'All directives' },
  { id: 'source', label: 'Source' },
];

export default function SiteEditor() {
  const { idx } = useParams();
  const index = Number(idx);
  const { model, parseError, canEdit, updateItem, update } = useCaddy();
  const navigate = useNavigate();
  const [tab, setTab] = useState('settings');

  if (parseError) {
    return (
      <Banner level="error" title="The Caddyfile could not be parsed">
        {parseError.message}. <Link to="/caddy/raw">Fix it in the Caddyfile editor</Link>.
      </Banner>
    );
  }
  const site = model?.items[index];
  if (!site || site.type !== 'site') {
    return (
      <Banner level="warn">
        That site no longer exists in the draft. <Link to="/caddy">Back to sites</Link>
      </Banner>
    );
  }

  /** Mutate a working copy of this site. */
  const edit = (fn) => updateItem(index, (it) => fn(it) ?? it);
  const others = new Set(
    model.items
      .filter((x, k) => x.type === 'site' && k !== index)
      .flatMap((x) => x.addresses.map((a) => unquote(a).toLowerCase()))
  );
  const d = describeSite(site);

  return (
    <>
      <div className="hstack" style={{ marginBottom: 12 }}>
        <Link to="/caddy" className="btn sm">← Sites</Link>
        <h2 className="mono" style={{ margin: 0, fontSize: 15, fontWeight: 640 }}>{siteLabel(site)}</h2>
        {site.disabled ? <Chip tone="warn">disabled</Chip> : <Chip tone="ok">enabled</Chip>}
        <span className="faint mono" style={{ fontSize: 12 }}>{d.text}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={!canEdit} onClick={() => edit((it) => { it.disabled = !it.disabled; })}>
          {site.disabled ? 'Enable' : 'Disable'}
        </button>
        <button
          className="btn sm danger"
          disabled={!canEdit}
          onClick={() => {
            if (!window.confirm(`Delete ${siteLabel(site)}? (You can review before it is applied.)`)) return;
            update((m) => {
              m.items.splice(index, 1);
              return m;
            });
            navigate('/caddy');
          }}
        >
          Delete site
        </button>
      </div>

      {site.disabled && (
        <Banner level="warn">
          This site is commented out in the Caddyfile, so Caddy ignores it. You can still edit it; enable it to serve it.
        </Banner>
      )}

      <div style={{ marginBottom: 14 }}>
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
      </div>

      {tab === 'settings' && (
        <SiteSettings
          site={site}
          edit={edit}
          others={others}
          canEdit={canEdit}
          snippets={model.items.filter((x) => x.type === 'snippet').map((x) => x.name)}
          showDirectives={() => setTab('directives')}
        />
      )}

      {tab === 'directives' && (
        <Panel title="Directives" actions={<span className="faint" style={{ fontSize: 11.5 }}>Everything in this site block, in file order. Edits here can express anything the Caddyfile can.</span>}>
          <DirectiveTree
            nodes={site.body}
            readOnly={!canEdit}
            onChange={(body) => edit((it) => { it.body = body; })}
          />
        </Panel>
      )}

      {tab === 'source' && <SiteSource site={site} canEdit={canEdit} onApply={(parsed) => edit((it) => ({ ...parsed, gap: it.gap, disabled: it.disabled }))} />}
    </>
  );
}

// --- source ------------------------------------------------------------------------

function SiteSource({ site, canEdit, onApply }) {
  const original = useMemo(
    () => (site.disabled ? formatItem({ ...site, disabled: false, leading: site.leading }) : site.raw ?? formatItem(site)),
    [site]
  );
  const [text, setText] = useState(original);
  const [error, setError] = useState(null);
  useEffect(() => {
    setText(original);
    setError(null);
  }, [original]);

  let parsed = null;
  let liveError = null;
  try {
    parsed = parseItem(text);
    if (parsed.type !== 'site') liveError = 'This must be a site block.';
  } catch (err) {
    liveError = err.message;
  }

  return (
    <Panel
      title="Site block source"
      actions={
        <span className="hstack">
          <button className="btn sm" disabled={text === original} onClick={() => setText(original)}>Revert</button>
          <button
            className="btn sm primary"
            disabled={!canEdit || text === original || Boolean(liveError)}
            onClick={() => {
              try {
                onApply(parseItem(text));
                setError(null);
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            Update draft
          </button>
        </span>
      }
    >
      <div className="vstack" style={{ gap: 8 }}>
        <span className="faint" style={{ fontSize: 12 }}>
          Edit this site as Caddyfile text. {site.disabled && 'It is shown uncommented; it stays disabled until you enable it.'}
        </span>
        {(liveError || error) && text !== original && <div className="field-error">{liveError || error}</div>}
        <CodeEditor value={text} onChange={setText} readOnly={!canEdit} height="48vh" errorLine={parsedLine(liveError)} />
      </div>
    </Panel>
  );
}

const parsedLine = (msg) => {
  const m = /^line (\d+):/.exec(msg ?? '');
  return m ? Number(m[1]) : null;
};

