// API client. Carries the CSRF token issued with the session and raises a
// typed error on 401 so the app can drop straight back to the login screen.

let csrfToken = null;

export function setCsrf(token) {
  csrfToken = token;
}

export class ApiError extends Error {
  /** @param {object|null} body the full JSON error payload, when there was one */
  constructor(status, code, message, body = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    // Some errors carry diagnostic detail (see the insecure-context response);
    // keeping the body means the UI can explain rather than just complain.
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });

  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error, data?.error, data);
  }
  return data;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
};

/** Turn an object into a query string, dropping empty values. */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
