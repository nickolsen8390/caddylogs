// Entry point. APP_MODE selects which half of the stack this process runs:
//   web    — HTTP API + UI (the published port)
//   ingest — log tailing, enrichment, aggregation, retention
//   all    — both in one process (handy for local testing)

import { config, validateConfig } from './config.js';
import { logger } from './util/log.js';
import { getDb, closeDb } from './db.js';

const log = logger('main');

const mode = config.mode;
const runWeb = mode === 'web' || mode === 'all';
const runIngest = mode === 'ingest' || mode === 'all';

validateConfig({ needsAuth: runWeb });

let server = null;
let ingestor = null;

async function main() {
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
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const timer = setTimeout(() => {
    log.warn('shutdown timed out, exiting');
    process.exit(1);
  }, 15000);
  timer.unref();
  try {
    if (server) await server.close();
    if (ingestor) await ingestor.stop();
    closeDb();
  } catch (err) {
    log.error('error during shutdown', { err: String(err) });
  }
  clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { err: String(err), stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err: String(err), stack: err?.stack });
  void shutdown('uncaughtException');
});

main().catch((err) => {
  log.error('failed to start', { err: String(err), stack: err?.stack });
  process.exit(1);
});
