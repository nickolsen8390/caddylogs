// Embedding in a portal's frame, with sign-in done by the portal.
//
// Active only when this page is in a frame (window.parent !== window) and
// EMBED_ORIGINS lists the pages allowed to frame it (the server reports them
// with /api/auth/me). The protocol, fixed by the portal:
//
//   to the parent, every message with source: "caddylogs"
//     { type: "login-required" }                 the Sign in screen is showing
//     { type: "logged-in", user }                after a successful sign-in
//     { type: "login-failed", status, message }  after a failed sign-in the
//                                                parent started
//     { type: "navigated", path }                on first load and every route
//                                                change (pathname + search)
//   from the parent
//     { source: "embedder", type: "login", username, password }
//         accepted only from window.parent, from an allowed origin, while the
//         Sign in screen is showing (Login.jsx)
//
// Each message is posted once per allowed origin as the target origin; the
// browser delivers only the one that matches the parent. Never "*", and never
// document.referrer: this app sends no referrer.

const framed = typeof window !== 'undefined' && window.parent !== window;
let origins = [];

/** Set from /api/auth/me. */
export function setEmbedOrigins(list) {
  origins = Array.isArray(list) ? list.filter((o) => typeof o === 'string') : [];
}

/** True when this page is framed and framing is configured. */
export const embedded = () => framed && origins.length > 0;

/** Post a protocol message to the parent (no-op unless embedded). */
export function tellParent(message) {
  if (!embedded()) return;
  const payload = { source: 'caddylogs', ...message };
  for (const origin of origins) {
    try {
      window.parent.postMessage(payload, origin);
    } catch {
      /* an origin the browser cannot parse: skip it */
    }
  }
}

/**
 * Listen for the parent's sign-in request. `handler({ username, password })`
 * runs only for a message from window.parent, from an allowed origin, shaped
 * as the protocol says. Returns the function that stops listening.
 */
export function onParentLogin(handler) {
  if (!embedded()) return () => {};
  const listener = (event) => {
    if (event.source !== window.parent) return;
    if (!origins.includes(event.origin)) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.source !== 'embedder' || d.type !== 'login') return;
    if (typeof d.username !== 'string' || typeof d.password !== 'string') return;
    if (!d.username || !d.password) return;
    handler({ username: d.username, password: d.password });
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/**
 * Why a sign-in that succeeded left no session in this frame — the browser
 * did not keep or send the session cookie. Plain text, for the parent.
 */
export function cookieRefusedMessage() {
  if (window.location.protocol !== 'https:') {
    return (
      'Signed in, but the browser will not keep the session in this frame. Caddy Log Interface ' +
      'is served over plain HTTP and the portal is on another site, and a cookie can only cross ' +
      'sites as SameSite=None; Secure, which needs HTTPS. Open Caddy Log Interface over https://, ' +
      'or frame it from a page on the same site.'
    );
  }
  return (
    'Signed in, but the browser did not keep the session cookie in this frame — it is blocking ' +
    'cookies in frames from other sites (third-party cookies). Allow cookies for this site in ' +
    'the browser, or frame it from a page on the same site.'
  );
}
