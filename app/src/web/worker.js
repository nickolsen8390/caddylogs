// A report worker (pool.js): runs reports.js on its own read-only database
// connection, one at a time, for the web server's thread.

import { parentPort } from 'node:worker_threads';
import { openReadOnly } from '../db.js';
import { REPORTS, ReportError } from './reports.js';

openReadOnly();

parentPort.on('message', ({ name, query, params }) => {
  try {
    parentPort.postMessage({ body: REPORTS[name](query, params ?? {}) });
  } catch (err) {
    parentPort.postMessage(
      err instanceof ReportError
        ? { status: { statusCode: err.statusCode, body: err.body } }
        : { error: { message: String(err?.message ?? err), stack: err?.stack } }
    );
  }
});
