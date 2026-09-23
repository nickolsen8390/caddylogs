import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCaddy } from './CaddyLayout.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { bytes, dateTime, relative } from '../../lib/format.js';
import { Banner, Chip, Empty, Loading, Panel } from '../../components/ui.jsx';
import { DiffView } from '../../components/caddy.jsx';

const ACTIONS = {
  apply: { label: 'applied', tone: 'ok' },
  restore: { label: 'restored', tone: 'info' },
  save: { label: 'saved (not reloaded)', tone: 'warn' },
  baseline: { label: 'previous version', tone: undefined },
};

export default function History() {
  const { base, canEdit, dirty, setDraft } = useCaddy();
  const navigate = useNavigate();
  const { data, error } = useApi(`/api/caddy/history?v=${base?.hash ?? ''}`);
  const [selected, setSelected] = useState(null);
  const [version, setVersion] = useState(null);

  const open = async (id) => {
    setSelected(id);
    setVersion(null);
    try {
      setVersion(await api.get(`/api/caddy/history/${id}`));
    } catch (err) {
      setVersion({ error: err.message });
    }
  };

  if (error) return <Banner level="error">Could not load history: {error.message}</Banner>;
  if (!data) return <Panel><Loading rows={5} /></Panel>;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 380px) minmax(0, 1fr)', alignItems: 'start' }}>
      <Panel title="Versions" flush>
        {data.rows.length ? (
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <table className="data">
              <tbody>
                {data.rows.map((r) => {
                  const a = ACTIONS[r.action] ?? { label: r.action };
                  const current = r.hash === base?.hash;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => open(r.id)}
                      style={{ cursor: 'pointer' }}
                      className={selected === r.id ? 'row-selected' : undefined}
                    >
                      <td>
                        <div className="hstack" style={{ gap: 6 }}>
                          <strong>#{r.id}</strong>
                          <Chip tone={a.tone}>{a.label}</Chip>
                          {current && <Chip tone="ok">current</Chip>}
                        </div>
                        <div className="faint" style={{ fontSize: 11.5 }} title={dateTime(r.ts)}>
                          {relative(r.ts)}
                          {r.username ? ` · ${r.username}` : ''} · {bytes(r.size)}
                        </div>
                        {r.message && <div style={{ fontSize: 12 }}>{r.message}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No changes have been made through this interface yet.</Empty>
        )}
      </Panel>

      <Panel
        title={selected ? `Version #${selected} compared with the current Caddyfile` : 'Select a version'}
        actions={
          version?.text != null &&
          version.hash !== base.hash && (
            <button
              className="btn sm primary"
              disabled={!canEdit}
              onClick={() => {
                if (dirty && !window.confirm('This replaces your unapplied changes. Continue?')) return;
                setDraft(version.text, { restored: version.id });
                navigate('/caddy/raw');
              }}
            >
              Restore this version…
            </button>
          )
        }
      >
        {!selected ? (
          <Empty>Pick a version on the left to see how it differs from what is on disk now.</Empty>
        ) : !version ? (
          <Loading rows={4} />
        ) : version.error ? (
          <Banner level="error">{version.error}</Banner>
        ) : (
          <div className="vstack" style={{ gap: 8 }}>
            <span className="faint" style={{ fontSize: 12 }}>
              Red lines are in version #{version.id} only; green lines are in the current file only. Restoring loads the
              version into the editor, where you review and apply it like any other change.
            </span>
            <DiffView before={version.text} after={base.text} maxHeight="60vh" />
          </div>
        )}
      </Panel>
    </div>
  );
}
