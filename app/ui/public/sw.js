// Service worker: what makes Caddy Log Interface installable as an app, and
// quick to start.
//
// Deliberately small, because everything worth seeing is live on the server
// and much of it is private:
//
//   /api/*, /healthz   never touched: always the network, never stored. The
//                      worker never holds statistics, requests or sessions,
//                      and can never serve stale or signed-out data.
//   /assets/*          cache first. Built files carry a content hash in
//                      their name, so a cached copy is never out of date;
//                      a new release brings new names.
//   page loads         network first. When the server cannot be reached, an
//                      offline page says so, instead of an app shell that
//                      would only show a sign-in screen that cannot work.
//
// Everything else (icons, the manifest) is left to the browser's HTTP cache.

const SHELL = 'cli-shell-v1';
const ASSETS = 'cli-assets-v1';
const OFFLINE = '/offline.html';
// Old builds' files are dropped beyond this many, oldest first.
const MAX_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll([OFFLINE, '/icon.svg'])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL && n !== ASSETS).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

async function asset(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trim(cache);
  }
  return response;
}

async function page(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE);
    return offline ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(page(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(asset(request));
  }
});
