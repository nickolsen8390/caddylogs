import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorLine, useCaddy } from './CaddyLayout.jsx';
import { api } from '../../lib/api.js';
import { parse, serialize, touched } from '../../lib/caddyfile.js';
import { Banner, Panel, Tabs } from '../../components/ui.jsx';
import { CodeEditor } from '../../components/caddy.jsx';
import { JsonView } from '../../components/JsonView.jsx';

export default function RawEditor() {
  const { draft, setDraft, parseError, canEdit, base, status } = useCaddy();
  const [params] = useSearchParams();
  const jump = Number(params.get('line')) || null;
  const [view, setView] = useState('file');
  const [check, setCheck] = useState(null);
  const [running, setRunning] = useState(null);

  const validate = async () => {
    setCheck({ state: 'running' });
    try {
      setCheck({ state: 'done', ...(await api.post('/api/caddy/validate', { text: draft })) });
    } catch (err) {
      setCheck({ state: 'done', ok: false, error: err.body?.message ?? err.message });
    }
  };

  const format = () => {
    try {
      const m = parse(draft);
      m.items = m.items.map((it) => (it.type === 'comment' ? it : { ...touched(it), indent: '\t' }));
      setDraft(serialize(m));
    } catch {
      /* the parse error is already on screen */
    }
  };

  const loadRunning = async () => {
    setRunning({ state: 'loading' });
    try {
      const res = await api.get('/api/caddy/running');
      setRunning({ state: 'done', config: res.config });
    } catch (err) {
      setRunning({ state: 'done', error: err.body?.message ?? err.message });
    }
  };

  const localLine = parseError?.line ?? null;
  const caddyLine = check?.state === 'done' && !check.ok ? errorLine(check.error) : null;

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <Tabs
          tabs={[
            { id: 'file', label: 'Caddyfile' },
            { id: 'running', label: 'Running config (JSON)' },
          ]}
          active={view}
          onChange={(v) => {
            setView(v);
            if (v === 'running' && !running) loadRunning();
          }}
        />
      </div>

      {view === 'file' ? (
        <Panel
          title={<span className="mono">{status?.file?.path ?? 'Caddyfile'}</span>}
          actions={
            <span className="hstack" style={{ gap: 6 }}>
              <button className="btn sm" onClick={format} disabled={!canEdit || Boolean(parseError)} title="Re-indent every block with tabs, like `caddy fmt`">
                Format
              </button>
              <button className="btn sm" onClick={validate} disabled={check?.state === 'running'}>
                {check?.state === 'running' ? 'Validating…' : 'Validate with Caddy'}
              </button>
              <button className="btn sm" onClick={() => setDraft(base.text)} disabled={!canEdit || draft === base.text}>
                Revert
              </button>
            </span>
          }
        >
          <div className="vstack" style={{ gap: 10 }}>
            {parseError && (
              <Banner level="error" title="Syntax problem">
                {parseError.message}. The structured pages are unavailable until this is fixed.
              </Banner>
            )}
            {check?.state === 'done' &&
              (check.ok ? (
                <Banner level="info" title="Caddy accepts this configuration">
                  {check.warnings?.length
                    ? check.warnings.map((w, i) => <div key={i}>{w.line ? `line ${w.line}: ` : ''}{w.message}</div>)
                    : 'No warnings.'}
                </Banner>
              ) : (
                <Banner level={check.unreachable ? 'warn' : 'error'} title={check.unreachable ? 'Caddy is not reachable' : 'Caddy rejected this configuration'}>
                  <pre className="err-pre">{check.error}</pre>
                </Banner>
              ))}
            <CodeEditor
              value={draft}
              onChange={(v) => {
                setDraft(v);
                if (check) setCheck(null);
              }}
              readOnly={!canEdit}
              errorLine={localLine ?? caddyLine ?? jump}
              jumpTo={jump}
            />
            <span className="faint" style={{ fontSize: 11.5 }}>
              Edits here and on the other pages are the same draft. Nothing reaches Caddy until you review and apply.
              Relative <code>import</code> paths resolve inside the Caddy container; use absolute paths.
            </span>
          </div>
        </Panel>
      ) : (
        <Panel
          title="What Caddy is running now"
          flush
          actions={<button className="btn sm" onClick={loadRunning}>Refresh</button>}
        >
          {running?.state === 'loading' && <div className="empty">Loading…</div>}
          {running?.error && <div style={{ padding: 12 }}><Banner level="error">{running.error}</Banner></div>}
          {running?.config !== undefined && running?.state === 'done' && !running.error && <JsonView value={running.config} />}
        </Panel>
      )}
    </>
  );
}
