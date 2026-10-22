// Settings changed from the interface rather than .env: how long individual
// requests are kept, and how large the database may grow. Saved in the
// database and applied within about ten minutes, without a restart.

import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { Banner, Loading, Panel, Stat } from '../components/ui.jsx';
import { bytes, compact, dateTime, keptFor, num, relative } from '../lib/format.js';

const GB = 1024; // MB

/** Form state from saved settings. */
function formOf(s) {
  const hours = s.rawRetentionHours;
  const days = hours > 0 && hours % 24 === 0;
  return {
    mode: hours > 0 ? 'time' : 'full',
    amount: hours > 0 ? String(days ? hours / 24 : hours) : '48',
    unit: hours > 0 && days ? 'days' : 'hours',
    limited: s.maxDbSizeMb > 0,
    sizeGb: s.maxDbSizeMb > 0 ? String(+(s.maxDbSizeMb / GB).toFixed(2)) : '10',
  };
}

/** Settings to save, from the form; null fields could not be read. */
function settingsOf(f) {
  const amount = Number(f.amount);
  const hours = f.mode === 'full' ? 0 : Math.round(amount * (f.unit === 'days' ? 24 : 1));
  const size = f.limited ? Math.round(Number(f.sizeGb) * GB) : 0;
  return {
    rawRetentionHours: Number.isFinite(hours) ? hours : null,
    maxDbSizeMb: Number.isFinite(size) ? size : null,
  };
}

export default function Settings({ ctx }) {
  // Polled only while a restore from log files is under way.
  const [polling, setPolling] = useState(false);
  const { data, error, reload } = useApi('/api/settings', {
    onUnauthorized: ctx?.onUnauthorized,
    refreshMs: polling ? 3000 : 0,
  });
  useEffect(() => {
    setPolling(['queued', 'running'].includes(data?.restore?.state));
  }, [data]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (data?.settings && !form) setForm(formOf(data.settings));
  }, [data, form]);

  if (error) return <Banner level="error">Could not load settings: {String(error.message)}</Banner>;
  if (!data || !form) return <Panel><Loading rows={6} /></Panel>;

  const { usage, canEdit, defaults } = data;
  const next = settingsOf(form);
  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };
  const changed =
    next.rawRetentionHours !== data.settings.rawRetentionHours || next.maxDbSizeMb !== data.settings.maxDbSizeMb;

  // How much one day of stored requests takes at the current rate, to help
  // choose a size, and how much history a size would hold.
  const perDay = usage.requestsPerHour && usage.bytesPerRequest
    ? usage.requestsPerHour * 24 * usage.bytesPerRequest
    : null;
  const fitsDays = perDay && next.maxDbSizeMb ? (next.maxDbSizeMb * 1_048_576) / perDay : null;

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      const res = await api.post('/api/settings', next);
      setForm(formOf(res.settings));
      setResult({ ok: true });
      reload();
    } catch (err) {
      setResult({
        ok: false,
        problems: err instanceof ApiError ? err.body?.problems : null,
        message: err instanceof ApiError && err.status === 403
          ? 'You are not allowed to change settings (CADDY_EDITORS).'
          : String(err.message),
      });
    } finally {
      setSaving(false);
    }
  }

  const problems = result?.problems ?? {};
  const last = data.history?.length ? data.history.reduce((a, b) => (b.updated_at > a.updated_at ? b : a)) : null;

  return (
    <form onSubmit={save}>
      {!canEdit && (
        <Banner level="info">
          These settings are read-only for you. Only the users listed in <code>CADDY_EDITORS</code> can
          change them.
        </Banner>
      )}

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Database" value={bytes(usage.usedBytes)}
              sub={usage.fileBytes > usage.usedBytes * 1.1 ? `file ${bytes(usage.fileBytes)}, the rest reusable` : 'data held'} />
        <Stat label="Stored requests" value={compact(usage.storedRequests)}
              sub={usage.oldestRequest ? `back to ${relative(usage.oldestRequest)}` : 'none yet'} />
        <Stat label="Request rate" value={usage.requestsPerHour ? `${compact(usage.requestsPerHour)}/h` : '—'}
              sub="averaged over the stored requests" />
        <Stat label="One day of requests" value={perDay ? bytes(perDay) : '—'}
              sub="roughly, at that rate" />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <Panel title="Stored requests">
          <p className="dim" style={{ marginTop: 0, fontSize: 12.5 }}>
            Every request Caddy logs is stored individually, with its original log line, for the
            live view, searching and drill-downs. Statistics are kept separately and reach further
            back (<code>RETENTION_DAYS</code> in .env).
          </p>
          <div className="vstack" style={{ gap: 10 }}>
            <label className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="radio" name="mode" checked={form.mode === 'time'} disabled={!canEdit}
                     onChange={() => set({ mode: 'time' })} />
              Keep for
              <input className="input" type="number" min="1" step="any" style={{ width: 90 }}
                     value={form.amount} disabled={!canEdit || form.mode !== 'time'}
                     onChange={(e) => set({ amount: e.target.value })} aria-label="Retention amount" />
              <select className="input" style={{ width: 'auto' }} value={form.unit}
                      disabled={!canEdit || form.mode !== 'time'}
                      onChange={(e) => set({ unit: e.target.value })} aria-label="Retention unit">
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </label>
            <label className="hstack" style={{ gap: 8 }}>
              <input type="radio" name="mode" checked={form.mode === 'full'} disabled={!canEdit}
                     onChange={() => set({ mode: 'full', limited: true })} />
              Keep until the database reaches its size limit
            </label>
            <span className="faint" style={{ fontSize: 11.5 }}>
              The second keeps as much history as the size limit allows, the oldest requests making
              way for new ones. Either way, the size limit wins.
            </span>
            {problems.rawRetentionHours && <Banner level="error">{problems.rawRetentionHours}</Banner>}
          </div>
        </Panel>

        <Panel title="Database size limit">
          <div className="vstack" style={{ gap: 10 }}>
            <label className="hstack" style={{ gap: 8 }}>
              <input type="checkbox" checked={form.limited} disabled={!canEdit}
                     onChange={(e) => set({ limited: e.target.checked })} />
              Limit the database to
              {/* step="any": with min 0.25 and a step of 0.5, the browser only
                  accepted 0.25, 0.75, 1.25… and refused 5. */}
              <input className="input" type="number" min={data.limits.minDbSizeMb / GB} step="any"
                     style={{ width: 90 }} value={form.sizeGb} disabled={!canEdit || !form.limited}
                     onChange={(e) => set({ sizeGb: e.target.value })} aria-label="Size limit in GB" />
              GB
            </label>
            <span className="faint" style={{ fontSize: 11.5 }}>
              When the database reaches the limit, the oldest stored requests are deleted first,
              whatever the retention above says — then, only if those are down to their last hour,
              the oldest days of statistics.
              {fitsDays ? ` At the current rate this limit holds about ${fitsDays >= 2 ? `${num(fitsDays)} days` : `${num(fitsDays * 24)} hours`} of requests.` : ''}
            </span>
            {problems.maxDbSizeMb && <Banner level="error">{problems.maxDbSizeMb}</Banner>}
            <Banner level="warn" title="A large database is a slower one">
              More history means more to read. Searching requests, the address pages and the live
              view's history all slow down as stored requests grow, and once the database is much
              larger than the memory the server can spare for its file cache, most reads come from
              disk. A few gigabytes keeps the interface quick for most sites; go larger only for
              history you will use.
            </Banner>
          </div>
        </Panel>
      </div>

      <div style={{ marginBottom: 14 }}>
        <RestorePanel data={data} canEdit={canEdit} unsaved={changed} onStarted={reload} />
      </div>

      {result?.ok === false && !Object.keys(problems).length && (
        <Banner level="error">Could not save: {result.message}</Banner>
      )}
      {result?.ok && (
        <Banner level="info">
          Saved. Pruning to the new settings starts within ten minutes; the file itself does not
          shrink when data is deleted, as the space is reused (see README, "Shrinking the
          database file").
        </Banner>
      )}

      <div className="hstack" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {last
            ? `Last changed ${dateTime(last.updated_at)}${last.username ? ` by ${last.username}` : ''}.`
            : 'Not changed here yet: these are the values from .env'}
          {' '}Defaults from .env: kept {keptFor(defaults.rawRetentionHours) ?? 'until the size limit'},{' '}
          {defaults.maxDbSizeMb ? `limit ${bytes(defaults.maxDbSizeMb * 1_048_576)}` : 'no size limit'}.
        </span>
        {canEdit && (
          <div className="hstack" style={{ gap: 6 }}>
            <button type="button" className="btn sm" disabled={!changed || saving}
                    onClick={() => set(formOf(data.settings))}>
              Undo changes
            </button>
            <button type="submit" className="btn sm primary" disabled={!changed || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

/**
 * Putting back stored requests that an earlier, shorter retention deleted,
 * from the log files still on disk (src/ingest/restore.js).
 */
function RestorePanel({ data, canEdit, unsaved, onStarted }) {
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState(null);
  const s = data.restore;
  const busy = s?.state === 'queued' || s?.state === 'running';

  async function start() {
    setStarting(true);
    setProblem(null);
    try {
      await api.post('/api/settings/restore', {});
      onStarted();
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 409 ? 'A restore is already running.' : String(err.message));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Panel title="Restore stored requests from log files">
      <p className="dim" style={{ marginTop: 0, fontSize: 12.5 }}>
        Requests deleted under an earlier, shorter retention may still be in Caddy's log files
        {data.logDir ? <> (<code>{data.logDir}</code> in the container)</> : null}. This reads them
        again and puts back the requests older than the oldest one stored — as far back as the
        retention above allows, and stopping short of the size limit. Their statistics were counted
        when they first arrived, so nothing is counted twice. It runs in the background; the
        interface stays usable.
      </p>
      {s && (
        <p style={{ fontSize: 12.5 }}>
          {s.state === 'queued' && 'Starting…'}
          {s.state === 'running' &&
            `Restoring… ${num(s.filesDone)} of ${num(s.files)} files read, ${num(s.restored)} requests put back so far.`}
          {s.state === 'done' && (
            <>
              Last restore {relative(s.finished)}: {num(s.restored)} requests put back from{' '}
              {num(s.filesDone)} log files
              {s.oldest ? <>, reaching back to {dateTime(s.oldest)}</> : null}
              {s.message ? <> — {s.message}</> : null}.
            </>
          )}
          {s.state === 'failed' && <span style={{ color: 'var(--red)' }}>Last restore failed: {s.message}</span>}
        </p>
      )}
      {problem && <Banner level="error">{problem}</Banner>}
      {canEdit && (
        <div className="hstack" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={start} disabled={busy || starting || unsaved}>
            {busy ? 'Restoring…' : 'Restore from log files'}
          </button>
          {unsaved && <span className="faint" style={{ fontSize: 11.5 }}>Save the retention first.</span>}
        </div>
      )}
    </Panel>
  );
}
