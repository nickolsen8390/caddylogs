// Caddy configuration API. Runs behind the session + CSRF checks in server.js.
//
// Applying a change is, in order:
//   1. the file has not changed since the editor loaded it (else 409)
//   2. Caddy adapts the new text               (syntax / directive errors)
//   3. the result keeps the admin endpoint     (so we can never lock ourselves out)
//   4. Caddy loads it                          (Caddy rolls back by itself on failure)
//   5. the file is written                     (only once Caddy has accepted it)
//   6. the version is recorded in history
//
// Loading before writing means the file on disk is always a config Caddy has
// accepted, so a restart can never come up with a broken one.

import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import * as admin from '../caddy/admin.js';
import {
  MAX_CADDYFILE_BYTES, fileStatus, getVersion, hashText, listHistory,
  readCaddyfile, recordBaseline, recordVersion, writeCaddyfile,
} from '../caddy/store.js';

const log = logger('caddy');

const canEdit = (req) =>
  !config.caddy.editors.length || config.caddy.editors.includes(req.session?.username);

// One change at a time: two tabs applying at once must not interleave.
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const stripMode = (a) => String(a ?? '').replace(/\|[0-7]+$/, '');

/** Refuse configs that would disconnect this interface from Caddy. */
function adminGuard(json) {
  const a = json?.admin;
  if (!a) return null;
  if (a.disabled) {
    return 'This configuration turns Caddy\'s admin endpoint off (`admin off`). ' +
      'The interface would no longer be able to reload Caddy, so it was not applied.';
  }
  if (a.listen && stripMode(a.listen) !== stripMode(config.caddy.admin)) {
    return `This configuration moves Caddy's admin endpoint to "${a.listen}", but this interface ` +
      `reaches it at "${config.caddy.admin}". Applying it would lock the interface out. Remove the ` +
      '`admin` global option (the address is set by CADDY_ADMIN in docker-compose.yml) or change ' +
      'CADDY_ADMIN_ADDRESS to match.';
  }
  return null;
}

/** Deterministic JSON so two equivalent configs compare equal. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function adminFailure(reply, err) {
  if (err instanceof admin.CaddyAdminError && err.kind !== 'rejected') {
    return reply.code(503).send({ error: 'caddy_unreachable', message: err.message });
  }
  return null;
}

export async function registerCaddyApi(app) {
  const rl = { config: { rateLimit: { max: config.auth.apiRateLimit, timeWindow: '1 minute' } } };
  const textBody = {
    ...rl,
    bodyLimit: MAX_CADDYFILE_BYTES * 2 + 64 * 1024,
  };

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/caddy/') || req.url.startsWith('/api/caddy/status')) return;
    if (!config.caddy.enabled) return reply.code(404).send({ error: 'caddy_disabled' });
    if (req.method !== 'GET' && !canEdit(req)) return reply.code(403).send({ error: 'forbidden' });
  });

  app.get('/api/caddy/status', rl, async (req) => {
    if (!config.caddy.enabled) return { enabled: false };
    const file = fileStatus();
    const out = {
      enabled: true,
      canEdit: canEdit(req),
      adminAddress: admin.adminLabel,
      admin: { reachable: false, error: null },
      file,
      drift: null,
      fileError: null,
      last: listHistory(1)[0] ?? null,
    };
    let running;
    try {
      running = await admin.runningConfig();
      out.admin.reachable = true;
    } catch (err) {
      out.admin.error = err.message;
    }
    if (file.readable) {
      const cur = readCaddyfile();
      Object.assign(file, { hash: cur.hash, mtime: cur.mtime, size: cur.size });
      // Drift: is Caddy running what the file says? Differs when the file was
      // edited without a reload, or Caddy is running an older config because
      // the file failed to load at startup.
      if (out.admin.reachable) {
        try {
          const { json } = await admin.adapt(cur.text);
          out.drift = stable(json) !== stable(running);
        } catch (err) {
          out.drift = true;
          out.fileError = err.message;
        }
      }
    }
    return out;
  });

  app.get('/api/caddy/config', rl, async (req, reply) => {
    try {
      return readCaddyfile();
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'no_caddyfile', path: config.caddy.caddyfile });
      if (err.code === 'EACCES') return reply.code(500).send({ error: 'caddyfile_unreadable', path: config.caddy.caddyfile });
      throw err;
    }
  });

  app.get('/api/caddy/running', rl, async (req, reply) => {
    try {
      return { config: await admin.runningConfig() };
    } catch (err) {
      return adminFailure(reply, err) ?? reply.code(502).send({ error: 'caddy_error', message: err.message });
    }
  });

  const textSchema = {
    body: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', maxLength: MAX_CADDYFILE_BYTES },
        baseHash: { type: ['string', 'null'], maxLength: 64 },
        message: { type: ['string', 'null'], maxLength: 500 },
        force: { type: 'boolean' },
        fileOnly: { type: 'boolean' },
        restoredFrom: { type: ['integer', 'null'] },
      },
    },
  };

  // Validation is an expected outcome either way, so it answers 200 with a
  // verdict rather than an error status.
  app.post('/api/caddy/validate', { ...textBody, schema: textSchema }, async (req) => {
    try {
      const { json, warnings } = await admin.adapt(req.body.text);
      const guard = adminGuard(json);
      if (guard) return { ok: false, error: guard };
      return { ok: true, warnings, sites: countSites(json) };
    } catch (err) {
      if (err instanceof admin.CaddyAdminError && err.kind !== 'rejected') {
        return { ok: false, unreachable: true, error: err.message };
      }
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/caddy/apply', { ...textBody, schema: textSchema }, (req, reply) =>
    serialized(async () => {
      const { text, baseHash, message, force, fileOnly, restoredFrom } = req.body;
      const user = req.session.username;

      let current = null;
      try {
        current = readCaddyfile();
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (current && !force && baseHash !== current.hash) {
        return reply.code(409).send({ error: 'conflict', current: { hash: current.hash, mtime: current.mtime } });
      }
      const action = restoredFrom ? 'restore' : 'apply';
      const note = message || (restoredFrom ? `Restored version #${restoredFrom}` : null);

      // Recovery path: Caddy is down (quite possibly because of the file), so
      // there is nothing to validate against or reload. Save only, on request.
      if (fileOnly) {
        let reachable = true;
        try {
          await admin.runningConfig();
        } catch {
          reachable = false;
        }
        if (reachable) return reply.code(400).send({ error: 'caddy_reachable' });
        if (current) recordBaseline(current.text, user);
        writeCaddyfile(text);
        recordVersion({ text, username: user, action: 'save', message: note });
        log.warn('Caddyfile saved without validation (Caddy unreachable)', { user });
        return { ok: true, reloaded: false, hash: hashText(text) };
      }

      let adapted;
      try {
        adapted = await admin.adapt(text);
      } catch (err) {
        return adminFailure(reply, err) ?? reply.code(422).send({ error: 'invalid', message: err.message });
      }
      const guard = adminGuard(adapted.json);
      if (guard) return reply.code(422).send({ error: 'invalid', message: guard });

      if (current) recordBaseline(current.text, user);

      try {
        await admin.load(text);
      } catch (err) {
        log.warn('Caddy rejected the new configuration', { user, err: err.message });
        return adminFailure(reply, err) ?? reply.code(422).send({ error: 'load_failed', message: err.message });
      }

      try {
        writeCaddyfile(text);
      } catch (err) {
        // Caddy is running the new config but the file still has the old one.
        // Put Caddy back so the two agree, then report.
        let rolledBack = false;
        if (current) {
          try {
            await admin.load(current.text);
            rolledBack = true;
          } catch {
            /* reported below */
          }
        }
        log.error('could not write the Caddyfile', { err: err.message, rolledBack });
        return reply.code(500).send({
          error: 'write_failed',
          message: `Caddy accepted the change, but ${config.caddy.caddyfile} could not be written (${err.code ?? err.message}). ` +
            (rolledBack ? 'Caddy was switched back to the previous configuration.' : 'Caddy is still running the NEW configuration.'),
        });
      }

      recordVersion({ text, username: user, action, message: note });
      log.info('Caddy configuration applied', { user, action, bytes: Buffer.byteLength(text) });
      const saved = readCaddyfile();
      return { ok: true, reloaded: true, hash: saved.hash, mtime: saved.mtime, warnings: adapted.warnings };
    })
  );

  // Load the file as it is on disk — for when it was edited outside the UI.
  app.post('/api/caddy/reload', rl, (req, reply) =>
    serialized(async () => {
      let current;
      try {
        current = readCaddyfile();
      } catch (err) {
        return reply.code(404).send({ error: 'no_caddyfile', message: err.message });
      }
      try {
        await admin.load(current.text);
      } catch (err) {
        return adminFailure(reply, err) ?? reply.code(422).send({ error: 'load_failed', message: err.message });
      }
      recordBaseline(current.text, req.session.username);
      log.info('Caddy reloaded from the Caddyfile on disk', { user: req.session.username });
      return { ok: true };
    })
  );

  // Hash a password for `basic_auth`, so the site editor never writes one in
  // plain text. bcrypt is Caddy's default algorithm; cost 12 keeps a login
  // check around a quarter of a second.
  app.post(
    '/api/caddy/hash-password',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', minLength: 1, maxLength: 72 } },
        },
      },
    },
    async (req) => ({ hash: await bcrypt.hash(req.body.password, 12) })
  );

  app.get('/api/caddy/history', rl, async () => ({
    rows: listHistory(config.caddy.historyKeep),
  }));

  app.get('/api/caddy/history/:id', rl, async (req, reply) => {
    const row = getVersion(parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });
}

function countSites(json) {
  const servers = json?.apps?.http?.servers ?? {};
  let routes = 0;
  for (const s of Object.values(servers)) routes += s.routes?.length ?? 0;
  return { servers: Object.keys(servers).length, routes };
}
