// Shell for the Caddy configuration pages.
//
// Every page edits one shared *draft* — the full Caddyfile text. Structured
// editors parse it, change the model, and serialize it back; the raw editor
// edits it directly. Nothing reaches Caddy until "Review & apply", which shows
// the diff, has Caddy validate it, then applies and reloads in one step.
//
// The draft survives moving between these pages (and a page refresh, via
// sessionStorage) as long as the file on disk has not changed underneath it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { parse, serialize, touched } from '../../lib/caddyfile.js';
import { Banner, Chip, Loading, Panel } from '../../components/ui.jsx';
import { DiffView, DirectiveSuggestions, Modal, diffCount } from '../../components/caddy.jsx';
import { relative } from '../../lib/format.js';

const CaddyCtx = createContext(null);
export const useCaddy = () => useContext(CaddyCtx);

const DRAFT_KEY = 'cli.caddy.draft';

function readSavedDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}
function writeSavedDraft(v) {
  try {
    if (v) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: the draft just won't survive a refresh */
  }
}

/** Line number from a Caddy error such as "Caddyfile:12 - Error during parsing". */
export function errorLine(message) {
  const m = /(?:Caddyfile|^|\s):(\d+)\b/.exec(String(message ?? ''));
  return m ? Number(m[1]) : null;
}

export default function CaddyLayout({ ctx }) {
  const { onUnauthorized } = ctx;
  const navigate = useNavigate();
  const status = useApi('/api/caddy/status', { refreshMs: 30_000, onUnauthorized });
  const [base, setBase] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraftState] = useState(null);
  const [restoredFrom, setRestoredFrom] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [toast, setToast] = useState(null);

  const loadBase = useCallback(
    async ({ keepDraft = false } = {}) => {
      try {
        const cfg = await api.get('/api/caddy/config');
        setBase(cfg);
        const saved = keepDraft ? readSavedDraft() : null;
        if (saved && saved.baseHash === cfg.hash) {
          setDraftState(saved.text);
          setRestoredFrom(saved.restoredFrom ?? null);
        } else {
          setDraftState(cfg.text);
          setRestoredFrom(null);
          writeSavedDraft(null);
        }
        setLoadError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        setLoadError(err);
      }
    },
    [onUnauthorized]
  );

  useEffect(() => {
    loadBase({ keepDraft: true });
  }, [loadBase]);

  const dirty = base != null && draft != null && draft !== base.text;

  useEffect(() => {
    if (!base || draft == null) return;
    writeSavedDraft(dirty ? { baseHash: base.hash, text: draft, restoredFrom } : null);
  }, [draft, base, dirty, restoredFrom]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const parsed = useMemo(() => {
    if (draft == null) return { model: null, error: null };
    try {
      return { model: parse(draft), error: null };
    } catch (err) {
      return { model: null, error: err };
    }
  }, [draft]);

  /** Replace the draft. `restored` tags it as a restore of a history version. */
  const setDraft = useCallback((text, opts) => {
    setDraftState(text);
    if (opts && 'restored' in opts) setRestoredFrom(opts.restored);
  }, []);

  /** Structured edit: fn receives a freshly parsed model to mutate or replace. */
  const update = useCallback((fn) => {
    setDraftState((prev) => {
      const model = parse(prev);
      const next = fn(model) ?? model;
      return serialize(next);
    });
  }, []);

  /** Edit one top-level item; it is re-emitted in canonical form. */
  const updateItem = useCallback(
    (index, fn) =>
      update((m) => {
        const it = touched(m.items[index]);
        const replaced = fn(it);
        m.items[index] = replaced ?? it;
        return m;
      }),
    [update]
  );

  const status_ = status.data;
  const canEdit = Boolean(status_?.enabled && status_?.canEdit && status_?.file?.readable);

  const value = {
    base,
    draft,
    setDraft,
    update,
    updateItem,
    model: parsed.model,
    parseError: parsed.error,
    dirty,
    canEdit,
    status: status_,
    reloadStatus: status.reload,
    review: () => setReviewing(true),
    notify: setToast,
  };

  if (status_ && !status_.enabled) {
    return (
      <Banner level="info" title="Caddy management is turned off">
        Set <code>CADDY_MANAGE=true</code> in <code>.env</code> and mount the Caddyfile directory and admin socket
        (see <code>docker-compose.yml</code>) to edit Caddy's configuration here.
      </Banner>
    );
  }

  return (
    <CaddyCtx.Provider value={value}>
      <DirectiveSuggestions />
      <StatusBanners status={status_} loadError={loadError} onReloaded={() => { status.reload(); setToast({ level: 'ok', text: 'Caddy reloaded from the file on disk.' }); }} />

      <div className="caddy-head">
        <nav className="tabs caddy-tabs">
          <NavLink to="/caddy" end>Sites</NavLink>
          <NavLink to="/caddy/global">Global &amp; snippets</NavLink>
          <NavLink to="/caddy/raw">Caddyfile</NavLink>
          <NavLink to="/caddy/history">History</NavLink>
        </nav>
        <span className="spacer" />
        <CaddyStatusChip status={status_} />
      </div>

      {dirty && (
        <UnsavedBar
          base={base.text}
          draft={draft}
          canEdit={canEdit}
          restoredFrom={restoredFrom}
          onDiscard={() => {
            if (window.confirm('Discard all unapplied changes?')) {
              setDraft(base.text, { restored: null });
              writeSavedDraft(null);
            }
          }}
          onReview={() => setReviewing(true)}
        />
      )}

      {toast && (
        <div className={`toast ${toast.level}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {!base && !loadError ? (
        <Panel><Loading rows={6} /></Panel>
      ) : base ? (
        <Outlet />
      ) : null}

      {reviewing && base && (
        <ReviewModal
          base={base}
          draft={draft}
          restoredFrom={restoredFrom}
          adminReachable={status_?.admin?.reachable}
          onClose={() => setReviewing(false)}
          onReloadLatest={async () => {
            setReviewing(false);
            writeSavedDraft(null);
            await loadBase();
          }}
          onApplied={async (res) => {
            setReviewing(false);
            writeSavedDraft(null);
            await loadBase();
            status.reload();
            setToast({
              level: 'ok',
              text: res.reloaded
                ? 'Applied. Caddy validated the new configuration and reloaded with no downtime.'
                : 'Saved to the Caddyfile. Caddy was not reachable, so it will pick this up when it starts.',
            });
          }}
          onJump={(line) => {
            setReviewing(false);
            navigate(`/caddy/raw?line=${line}`);
          }}
        />
      )}
    </CaddyCtx.Provider>
  );
}

function CaddyStatusChip({ status }) {
  if (!status) return null;
  if (!status.admin.reachable) return <Chip tone="bad" title={status.admin.error}>Caddy unreachable</Chip>;
  if (status.drift) return <Chip tone="warn">running config differs from file</Chip>;
  return (
    <Chip tone="ok" title={`Admin API: ${status.adminAddress}`}>
      Caddy running{status.last ? ` · last change ${relative(status.last.ts)}` : ''}
    </Chip>
  );
}

function StatusBanners({ status, loadError, onReloaded }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (loadError) {
    if (loadError.code === 'no_caddyfile') {
      return (
        <Banner level="error" title="No Caddyfile found">
          Expected it at <code>{loadError.body?.path}</code> inside the container. Check that the Caddyfile directory is
          mounted (<code>CADDY_CONF_PATH</code> in <code>.env</code>) and contains a file named <code>Caddyfile</code>.
        </Banner>
      );
    }
    return <Banner level="error">Could not read the Caddyfile: {String(loadError.body?.error ?? loadError.message)}</Banner>;
  }
  if (!status) return null;

  const out = [];
  if (!status.admin.reachable) {
    out.push(
      <Banner key="admin" level="error" title="Caddy's admin API is not reachable">
        {status.admin.error} Changes cannot be validated or applied until it is. If Caddy is down because of a bad
        config, you can still fix the file and save it without reloading from the review screen.
      </Banner>
    );
  } else if (status.drift) {
    out.push(
      <Banner key="drift" level="warn" title="Caddy is not running what the Caddyfile says">
        {status.fileError ? (
          <>The Caddyfile on disk does not load: <code>{status.fileError}</code>. Caddy is still running an older configuration.</>
        ) : (
          <>The file was changed outside this interface without a reload, or Caddy started from a different config.</>
        )}{' '}
        {!status.fileError && status.canEdit && (
          <button
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api.post('/api/caddy/reload');
                onReloaded();
              } catch (e) {
                setErr(e.body?.message ?? e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Reloading…' : 'Reload Caddy from the file'}
          </button>
        )}
        {err && <div className="field-error">{err}</div>}
      </Banner>
    );
  }
  if (status.file && !status.file.dirWritable && !status.file.writable) {
    out.push(
      <Banner key="ro" level="warn" title="The Caddyfile is read-only to this container">
        <code>{status.file.path}</code> cannot be written, so changes cannot be saved. Make the Caddyfile directory
        writable by <code>PUID:PGID</code> (see README).
      </Banner>
    );
  }
  if (!status.canEdit) {
    out.push(
      <Banner key="ro-user" level="info">
        You can view Caddy's configuration, but only users listed in <code>CADDY_EDITORS</code> can change it.
      </Banner>
    );
  }
  return out;
}

function UnsavedBar({ base, draft, canEdit, onDiscard, onReview, restoredFrom }) {
  const { add, del } = useMemo(() => diffCount(base, draft), [base, draft]);
  return (
    <div className="unsaved-bar">
      <span className="status-dot" style={{ background: 'var(--amber)' }} />
      <span>
        <strong>Unapplied changes</strong>{' '}
        <span className="faint">
          {restoredFrom ? `restoring version #${restoredFrom} · ` : ''}
          <span style={{ color: 'var(--green)' }}>+{add}</span> <span style={{ color: 'var(--red)' }}>−{del}</span> lines
        </span>
      </span>
      <span className="spacer" />
      <button className="btn sm" onClick={onDiscard}>Discard</button>
      <button className="btn sm primary" onClick={onReview} disabled={!canEdit}>
        Review &amp; apply
      </button>
    </div>
  );
}

function ReviewModal({ base, draft, restoredFrom, adminReachable, onClose, onApplied, onReloadLatest, onJump }) {
  const [validation, setValidation] = useState({ state: 'running' });
  const [message, setMessage] = useState('');
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setValidation({ state: 'running' });
    api
      .post('/api/caddy/validate', { text: draft })
      .then((res) => {
        if (id === seq.current) setValidation({ state: 'done', ...res });
      })
      .catch((err) => {
        if (id === seq.current) setValidation({ state: 'done', ok: false, error: err.body?.message ?? err.message });
      });
  }, [draft]);

  async function apply({ force = false, fileOnly = false } = {}) {
    setApplying(true);
    setFailure(null);
    try {
      const res = await api.post('/api/caddy/apply', {
        text: draft,
        baseHash: base.hash,
        message: message.trim() || null,
        force,
        fileOnly,
        restoredFrom,
      });
      onApplied(res);
    } catch (err) {
      setFailure({ code: err.code, status: err.status, message: err.body?.message ?? err.message });
    } finally {
      setApplying(false);
    }
  }

  const v = validation;
  const line = errorLine(v.error) ?? errorLine(failure?.message);
  const unreachable = v.unreachable || failure?.code === 'caddy_unreachable' || adminReachable === false;

  return (
    <Modal
      title="Review & apply changes"
      wide
      onClose={applying ? undefined : onClose}
      footer={
        <>
          <input
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            placeholder="Describe the change (optional, kept in history)"
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button className="btn" onClick={onClose} disabled={applying}>Keep editing</button>
          {unreachable ? (
            <button
              className="btn danger"
              disabled={applying}
              title="Caddy cannot validate this. It will be read when Caddy next starts."
              onClick={() => {
                if (window.confirm('Caddy is not reachable, so this cannot be validated. Save the file anyway? Caddy will read it when it next starts.')) {
                  apply({ fileOnly: true });
                }
              }}
            >
              Save file without reloading
            </button>
          ) : (
            <button className="btn primary" disabled={applying || v.state !== 'done' || !v.ok} onClick={() => apply()}>
              {applying ? 'Applying…' : 'Apply & reload Caddy'}
            </button>
          )}
        </>
      }
    >
      <div className="vstack" style={{ gap: 12 }}>
        {v.state === 'running' ? (
          <div className="hstack"><span className="spinner" /> Caddy is validating the new configuration…</div>
        ) : v.ok ? (
          <Banner level="info" title="Caddy accepts this configuration">
            {v.warnings?.length ? (
              <ul className="warn-list">
                {v.warnings.map((w, i) => (
                  <li key={i}>
                    {w.line ? <button className="linklike" onClick={() => onJump(w.line)}>line {w.line}</button> : null}
                    {w.directive ? <code> {w.directive}</code> : null} {w.message}
                  </li>
                ))}
              </ul>
            ) : (
              'No warnings.'
            )}
          </Banner>
        ) : (
          <Banner level={v.unreachable ? 'warn' : 'error'} title={v.unreachable ? 'Caddy is not reachable' : 'Caddy rejected this configuration'}>
            <pre className="err-pre">{v.error}</pre>
            {line && <button className="btn sm" onClick={() => onJump(line)}>Show line {line} in the editor</button>}
          </Banner>
        )}

        {failure && (
          <Banner level="error" title={failure.code === 'conflict' ? 'The Caddyfile changed on disk' : 'Not applied'}>
            {failure.code === 'conflict' ? (
              <>
                Someone (or something) changed the Caddyfile since you started editing. Applying now would overwrite
                their change.
                <div className="hstack" style={{ marginTop: 8 }}>
                  <button className="btn sm" onClick={onReloadLatest}>Load the latest version (discard my edits)</button>
                  <button className="btn sm danger" onClick={() => apply({ force: true })}>Overwrite it with mine</button>
                </div>
              </>
            ) : (
              <>
                <pre className="err-pre">{failure.message}</pre>
                {failure.code === 'load_failed' && (
                  <div className="faint">Caddy kept running the previous configuration; nothing was changed.</div>
                )}
              </>
            )}
          </Banner>
        )}

        <DiffView before={base.text} after={draft} />
      </div>
    </Modal>
  );
}
