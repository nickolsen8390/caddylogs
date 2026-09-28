// Entry point. APP_MODE selects what this process runs:
//   all    — (default) the whole app in one container: this process serves
//            the web UI and API, and runs the ingester as a child process
//   web    — HTTP API + UI only
//   ingest — log tailing, enrichment, aggregation, retention only
//
// The two halves only ever talk through the SQLite database, so they can run
// as separate containers (web + ingest) or together (all). In `all` the
// ingester still gets a process of its own: its batch writes, rollups and
// hourly maintenance are synchronous, and sharing an event loop with the web
// server would freeze the dashboard while they run.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { logger } from './util/log.js';
import { getDb, closeDb } from './db.js';

const log = logger('main');

const mode = config.mode;
const runWeb = mode === 'web' || mode === 'all';
const runIngest = mode === 'ingest';
const superviseIngest = mode === 'all';

if (!['all', 'web', 'ingest'].includes(mode)) {
  console.error(`[config] FATAL: APP_MODE must be all, web or ingest (got "${mode}").`);
  process.exit(1);
}
validateConfig({ needsAuth: runWeb });

let server = null;
let ingestor = null;
let child = null;
let shuttingDown = false;

async function main() {
  // Opening the database creates or migrates the schema. Doing it before the
  // ingester starts means two processes never race to migrate it.
  getDb();
  log.info('starting', { mode, node: process.version });

  if (runIngest) {
    const { Ingestor } = await import('./ingest/index.js');
    ingestor = new Ingestor();
    await ingestor.start();
  }
  if (runWeb) {
    const { startWeb } = await import('./web/server.js');
    server = await startWeb();
  }
  if (superviseIngest) startIngestChild();
}

// ---------------------------------------------------------------------------
//  The ingester as a supervised child process (APP_MODE=all)
// ---------------------------------------------------------------------------

let restarts = 0;
let startedAt = 0;

function startIngestChild() {
  startedAt = Date.now();
  child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, APP_MODE: 'ingest' },
    stdio: 'inherit',
  });
  log.info('ingester started', { pid: child.pid });

  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;
    // Restart it, backing off if it keeps failing (a misconfigured log
    // directory, say) — the web UI stays up meanwhile, and the Health page
    // shows that nothing is being read.
    if (Date.now() - startedAt > 60_000) restarts = 0;
    const delay = Math.min(60_000, 1000 * 2 ** restarts);
    restarts++;
    log.error('ingester exited; restarting', { code, signal, inMs: delay, attempt: restarts });
    setTimeout(() => {
      if (!shuttingDown) startIngestChild();
    }, delay).unref();
  });
}

function stopIngestChild() {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
//  Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const timer = setTimeout(() => {
    log.warn('shutdown timed out, exiting');
    child?.kill('SIGKILL');
    process.exit(1);
  }, 15000);
  timer.unref();
  try {
    // Docker signals only this process (PID 1): pass it on, and wait, so the
    // ingester can flush its batch and save its read positions.
    const ingestDone = stopIngestChild();
    if (server) await server.close();
    if (ingestor) await ingestor.stop();
    await ingestDone;
    closeDb();
  } catch (err) {
    log.error('error during shutdown', { err: String(err) });
  }
  clearTimeout(timer);
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { err: String(err), stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err: String(err), stack: err?.stack });
  void shutdown('uncaughtException', 1);
});

main().catch((err) => {
  log.error('failed to start', { err: String(err), stack: err?.stack });
  child?.kill('SIGTERM');
  process.exit(1);
});
