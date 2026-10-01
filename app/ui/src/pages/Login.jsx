import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';

const MESSAGES = {
  invalid_credentials: 'Incorrect username or password.',
  too_many_attempts: 'Too many failed attempts from this address. Try again shortly.',
  rate_limited: 'Too many requests. Slow down and try again.',
};

/** What each secure-context failure means, and what to do about it. */
const INSECURE_CAUSES = {
  forwarded_proto_not_https: {
    title: 'Your proxy says the browser connected over plain HTTP',
    body: (
      <>
        The reverse proxy forwarded <code>X-Forwarded-Proto: http</code>, so this page is not a
        secure context and the browser would discard the <code>Secure</code> session cookie.
        Reach the site as <code>https://</code>. If HTTPS itself is not working for an
        internal-only hostname, Caddy cannot get a public certificate for it — add{' '}
        <code>tls internal</code> to that site block.
      </>
    ),
  },
  no_forwarded_proto: {
    title: 'No X-Forwarded-Proto header arrived',
    body: (
      <>
        Caddy sets this automatically on <code>reverse_proxy</code>, so its absence usually means
        the browser reached the app directly on its published port rather than through the proxy.
        Use the proxied hostname.
      </>
    ),
  },
  untrusted_proxy: {
    title: 'The proxy is not in TRUSTED_PROXIES',
    body: (
      <>
        <code>X-Forwarded-Proto</code> arrived but was ignored, because a client that could set
        that header itself would otherwise be able to defeat this check. Add the peer address
        shown below to <code>TRUSTED_PROXIES</code> in <code>.env</code>.
      </>
    ),
  },
  trust_proxy_disabled: {
    title: 'TRUST_PROXY is disabled',
    body: (
      <>
        Proxy headers are being ignored entirely. Set <code>TRUST_PROXY=true</code> in{' '}
        <code>.env</code> when running behind a reverse proxy.
      </>
    ),
  },
};

/**
 * Your password was right, but the session cookie could not survive. Shown in
 * full — with what the server actually observed — because the alternative is
 * an unexplained bounce back to this page, the least debuggable failure here.
 */
function InsecureContextHelp({ reason, observed }) {
  const cause = INSECURE_CAUSES[reason];
  return (
    <div className="banner error" role="alert" style={{ marginBottom: 14, textAlign: 'left' }}>
      <span aria-hidden="true">⛔</span>
      <div>
        <div className="banner-title">
          {cause?.title ?? 'Signed in, but the session cannot be stored'}
        </div>
        <p style={{ margin: '6px 0' }}>
          {cause?.body ?? (
            <>
              <code>COOKIE_SECURE=true</code> marks the session cookie <code>Secure</code>, and
              browsers discard <code>Secure</code> cookies on insecure origins.
            </>
          )}
        </p>

        {observed && (
          <dl className="kv" style={{ margin: '10px 0', fontSize: 11.5 }}>
            <dt>Proxy address</dt>
            <dd className="mono">
              {observed.peer ?? 'unknown'}{' '}
              <span className="faint">({observed.peerTrusted ? 'trusted' : 'not trusted'})</span>
            </dd>
            <dt>X-Forwarded-Proto</dt>
            <dd className="mono">{observed.forwardedProto ?? 'absent'}</dd>
          </dl>
        )}

        <p style={{ margin: '6px 0 0' }} className="dim">
          Alternatively, set <code>COOKIE_SECURE=false</code> in <code>.env</code> and run{' '}
          <code>docker compose up -d</code>. The cookie then still travels over TLS if your proxy
          provides it — it simply is not flagged <code>Secure</code>. Reasonable on a trusted,
          IP-restricted network; not on the open internet.
        </p>
      </div>
    </div>
  );
}

/**
 * @param {object} p
 * @param {number} [p.rememberDays] lifetime of a "keep me signed in" session; 0 hides the option
 */
export default function Login({ onSuccess, rememberDays = 0 }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [insecure, setInsecure] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/auth/login', {
        username,
        password,
        remember: rememberDays > 0 && remember,
      });
      onSuccess(res);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'insecure_context') {
        setInsecure({ reason: err.body?.reason, observed: err.body?.observed });
        setError(null);
      } else {
        setError(MESSAGES[code] ?? 'Sign-in failed. Please try again.');
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 16 }}>
          <span className="brand-mark">C</span>
          <span>Caddy Log Interface</span>
        </div>
        <h1>Sign in</h1>
        <p className="sub">Access is restricted to configured users.</p>

        {insecure && <InsecureContextHelp reason={insecure.reason} observed={insecure.observed} />}

        {error && (
          <div className="banner error" role="alert" style={{ marginBottom: 14 }}>
            <span aria-hidden="true">⛔</span>
            <div>{error}</div>
          </div>
        )}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="input"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {rememberDays > 0 && (
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Keep me signed in
            </label>
            <span className="field-hint faint">
              Stay signed in for {rememberDays === 1 ? '1 day' : `${rememberDays} days`}, even when
              idle. Don’t use this on a shared computer.
            </span>
          </div>
        )}

        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
