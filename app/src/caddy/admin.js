// Client for Caddy's admin API.
//
// Only three endpoints are used:
//   POST /adapt   Caddyfile -> JSON, without touching the running server.
//                 This is the validator: it is Caddy's own parser, so
//                 anything it accepts, Caddy accepts.
//   POST /load    apply a config. If it fails to provision, Caddy rolls back
//                 to the previous config itself, with no downtime.
//   GET  /config/ the running config, to detect drift from the file on disk.

import http from 'node:http';
import { config } from '../config.js';

export class CaddyAdminError extends Error {
  /**
   * @param {'unreachable'|'rejected'|'timeout'|'protocol'} kind
   */
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Parse an admin address in Caddy's own notation:
 *   unix//run/caddy/admin.sock   (optionally with a |mode suffix, ignored)
 *   http://127.0.0.1:2019  |  127.0.0.1:2019  |  localhost:2019
 */
export function parseAdminAddress(addr) {
  const a = String(addr || '').trim();
  const unix = /^unix\/(\/.+?)(\|[0-7]+)?$/.exec(a);
  if (unix) return { socketPath: unix[1], label: `unix socket ${unix[1]}` };
  const url = new URL(/^[a-z]+:\/\//i.test(a) ? a : `http://${a}`);
  return {
    host: url.hostname,
    port: Number(url.port) || 2019,
    label: `${url.hostname}:${Number(url.port) || 2019}`,
  };
}

const target = parseAdminAddress(config.caddy.admin);
export const adminLabel = target.label;

function request(method, path, { body, contentType, timeoutMs = config.caddy.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      // Caddy skips Host enforcement on unix sockets; over TCP it expects the
      // loopback name it is listening on.
      Host: target.socketPath ? '127.0.0.1' : `${target.host}:${target.port}`,
      Accept: 'application/json',
    };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(body, 'utf8');
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = payload.length;
    }
    const req = http.request(
      {
        method,
        path,
        headers,
        ...(target.socketPath ? { socketPath: target.socketPath } : { host: target.host, port: target.port }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text.trim()) {
            try {
              json = JSON.parse(text);
            } catch {
              /* non-JSON body; kept as text */
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, json, text });
          } else {
            const msg = json?.error || text.trim() || `HTTP ${res.statusCode}`;
            reject(new CaddyAdminError('rejected', msg, res.statusCode));
          }
        });
        res.on('error', (err) => reject(new CaddyAdminError('protocol', err.message)));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new CaddyAdminError('timeout', `Caddy did not answer within ${timeoutMs} ms`));
    });
    req.on('error', (err) => {
      if (err instanceof CaddyAdminError) return reject(err);
      reject(new CaddyAdminError('unreachable', describeConnectError(err)));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function describeConnectError(err) {
  switch (err.code) {
    case 'ENOENT':
      return `No admin socket at ${target.socketPath}. Is the caddy container running, with CADDY_ADMIN set and the run directory shared?`;
    case 'EACCES':
      return `Permission denied on ${target.socketPath}. The socket must be writable by this container's user (see CADDY_ADMIN in docker-compose.yml).`;
    case 'ECONNREFUSED':
      return `Connection refused by ${target.label}. Caddy is not running, or its admin endpoint is elsewhere.`;
    default:
      return `${err.code ?? 'error'}: ${err.message}`;
  }
}

/** Validate a Caddyfile. Resolves {json, warnings}; rejects with Caddy's message. */
export async function adapt(text) {
  const res = await request('POST', '/adapt', { body: text, contentType: 'text/caddyfile' });
  return { json: res.json?.result ?? null, warnings: res.json?.warnings ?? [] };
}

/** Apply a Caddyfile. Caddy rolls back on its own if this rejects. */
export async function load(text) {
  const res = await request('POST', '/load', { body: text, contentType: 'text/caddyfile' });
  // /load reports adapter warnings in its body when there are any.
  return { warnings: Array.isArray(res.json) ? res.json : res.json?.warnings ?? [] };
}

export async function runningConfig() {
  const res = await request('GET', '/config/', { timeoutMs: 5000 });
  return res.json;
}
