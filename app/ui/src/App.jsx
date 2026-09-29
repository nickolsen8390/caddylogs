import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, setCsrf } from './lib/api.js';
import { useLocalState } from './lib/useApi.js';
import { Icon, Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Domains from './pages/Domains.jsx';
import DomainDetail from './pages/DomainDetail.jsx';
import LogStream from './pages/LogStream.jsx';
import Requests from './pages/Requests.jsx';
import IpDetail from './pages/IpDetail.jsx';
import Health from './pages/Health.jsx';
import CaddyLayout from './pages/caddy/CaddyLayout.jsx';
import CaddySites from './pages/caddy/Sites.jsx';
import CaddySiteEditor from './pages/caddy/SiteEditor.jsx';
import CaddyGlobal from './pages/caddy/GlobalOptions.jsx';
import CaddyRaw from './pages/caddy/RawEditor.jsx';
import CaddyHistory from './pages/caddy/History.jsx';

const TITLES = [
  [/^\/$/, 'Dashboard'],
  [/^\/domains$/, 'Domains'],
  [/^\/domains\//, 'Domain detail'],
  [/^\/requests/, 'Request explorer'],
  [/^\/ip\//, 'Source address'],
  [/^\/logs/, 'Live logs'],
  [/^\/health/, 'System health'],
  [/^\/caddy\/sites\//, 'Caddy · edit site'],
  [/^\/caddy\/global/, 'Caddy · global options & snippets'],
  [/^\/caddy\/raw/, 'Caddy · Caddyfile'],
  [/^\/caddy\/history/, 'Caddy · history'],
  [/^\/caddy/, 'Caddy · sites'],
];

/** Optional parts of the interface; the server says which are switched on. */
const DEFAULT_FEATURES = { caddy: true, notoolkit: true };

export default function App() {
  const [auth, setAuth] = useState({ state: 'checking', username: null, features: DEFAULT_FEATURES });
  // Slide-in navigation on narrow screens; ignored where the sidebar is fixed.
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useLocalState('cli.theme', 'dark');
  const [range, setRange] = useLocalState('cli.range', '24h');
  const location = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const check = useCallback(async () => {
    try {
      const me = await api.get('/api/auth/me');
      if (me?.authenticated) {
        setCsrf(me.csrf);
        setAuth({ state: 'in', username: me.username, features: { ...DEFAULT_FEATURES, ...me.features } });
      } else {
        setAuth((a) => ({ ...a, state: 'out', username: null }));
      }
    } catch {
      setAuth((a) => ({ ...a, state: 'out', username: null }));
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const onUnauthorized = useCallback(() => {
    setCsrf(null);
    setAuth((a) => ({ ...a, state: 'out', username: null }));
  }, []);

  // Close the drawer whenever the page changes, and on Escape.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('nav-locked');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('nav-locked');
    };
  }, [navOpen]);

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* the cookie is cleared server-side either way */
    }
    onUnauthorized();
  }

  const title = useMemo(
    () => TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? 'Caddy Log Interface',
    [location.pathname]
  );

  if (auth.state === 'checking') {
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  }
  if (auth.state === 'out') {
    return (
      <Login
        onSuccess={(res) => {
          setCsrf(res.csrf);
          setAuth({ state: 'in', username: res.username, features: { ...DEFAULT_FEATURES, ...res.features } });
        }}
      />
    );
  }

  const { features } = auth;
  const ctx = { range, setRange, onUnauthorized, features };

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <aside className="sidebar" id="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span>Caddy Logs</span>
          <button type="button" className="nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>
            ✕
          </button>
        </div>
        <nav className="nav">
          <div className="nav-label">Overview</div>
          <NavLink to="/" end>
            <Icon name="dashboard" /> Dashboard
          </NavLink>
          <NavLink to="/domains">
            <Icon name="domains" /> Domains
          </NavLink>
          <NavLink to="/requests">
            <Icon name="requests" /> Requests
          </NavLink>
          <div className="nav-label">Live</div>
          <NavLink to="/logs">
            <Icon name="stream" /> Log stream
          </NavLink>
          {features.caddy && (
            <>
              <div className="nav-label">Configure</div>
              <NavLink to="/caddy">
                <Icon name="caddy" /> Caddy
              </NavLink>
            </>
          )}
          <div className="nav-label">System</div>
          <NavLink to="/health">
            <Icon name="health" /> Health
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <span>
              Signed in as <strong style={{ color: 'var(--text-dim)' }}>{auth.username}</strong>
            </span>
          </div>
          <div className="hstack">
            <button
              className="btn sm"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="Toggle theme"
            >
              {theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
            <button className="btn sm danger" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="nav-backdrop" aria-hidden="true" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Open menu"
            aria-controls="sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
          <h1>{title}</h1>
          <span className="spacer" />
        </header>
        <div className="content">
          <Routes>
            <Route path="/" element={<Dashboard ctx={ctx} />} />
            <Route path="/domains" element={<Domains ctx={ctx} />} />
            <Route path="/domains/:host" element={<DomainDetail ctx={ctx} />} />
            <Route path="/requests" element={<Requests ctx={ctx} />} />
            <Route path="/ip/:ip" element={<IpDetail ctx={ctx} />} />
            <Route path="/logs" element={<LogStream ctx={ctx} />} />
            <Route path="/health" element={<Health ctx={ctx} />} />
            {features.caddy && (
              <Route path="/caddy" element={<CaddyLayout ctx={ctx} />}>
                <Route index element={<CaddySites />} />
                <Route path="sites/:idx" element={<CaddySiteEditor />} />
                <Route path="global" element={<CaddyGlobal />} />
                <Route path="raw" element={<CaddyRaw />} />
                <Route path="history" element={<CaddyHistory />} />
              </Route>
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
