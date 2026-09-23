// Every option the settings pages offer, with the help shown in its tooltip.
//
// A field names the directive it writes (`dir`), where that directive lives
// (`path`, relative to the block the section edits), the kind of value, and
// the text a person needs to fill it in without the Caddy docs open: what it
// does, what to put in it, the default, and an example.
//
// Field types (see caddyedit.js):
//   text    one value; `kind` adds a format hint (duration|size|number|port|status|url)
//   select  one of `options`; an option with `param` takes an extra value
//   flag    on/off: the directive is present or not
//   list    several values on one line
//   checks  a subset of `options`, on one line
//   rows    the directive repeated, one row each; `columns` describes a row
//
// Custom fields (`read`/`write`) handle the few directives with an unusual shape.

import { directive, quote } from './caddyfile.js';
import { argsOf, isDir, replaceNodes, resolve } from './caddyedit.js';

const d = (s) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
//  Reverse proxy — edited on one `reverse_proxy` block
// ---------------------------------------------------------------------------

const TRANSPORT = [{ name: 'transport', head: ['http'] }];

export const PROXY_GROUPS = [
  {
    id: 'lb',
    title: 'Load balancing & retries',
    help: d(`Only matters with more than one upstream, or when you want Caddy to retry a
      failed connection. By default Caddy picks an upstream at random and does not retry.`),
    fields: [
      {
        id: 'lb_policy', dir: 'lb_policy', type: 'select', multi: true, label: 'Policy',
        help: d(`How Caddy chooses which upstream gets each request.`),
        options: [
          { value: '', label: 'Random (default)' },
          { value: 'round_robin', label: 'Round robin — take turns' },
          { value: 'least_conn', label: 'Least connections — the least busy upstream' },
          { value: 'first', label: 'First available — use the first, fall back to the next (failover)' },
          { value: 'ip_hash', label: 'IP hash — same visitor (by connection address) sticks to one upstream' },
          { value: 'client_ip_hash', label: 'Client IP hash — like IP hash, honouring trusted proxies' },
          { value: 'uri_hash', label: 'URI hash — same URL always goes to the same upstream (cache-friendly)' },
          { value: 'random_choose', label: 'Random of N — pick N at random, use the least busy', param: 'how many, e.g. 2' },
          { value: 'header', label: 'Header hash — sticky by a request header', param: 'header name, e.g. X-User-ID' },
          { value: 'query', label: 'Query hash — sticky by a query parameter', param: 'parameter, e.g. session' },
          { value: 'cookie', label: 'Cookie — sticky sessions via a cookie Caddy sets', param: 'cookie name (optional)' },
        ],
        example: 'round_robin',
      },
      {
        id: 'lb_retries', dir: 'lb_retries', type: 'text', kind: 'number', label: 'Retries',
        help: d(`How many times to try another upstream when one fails to connect. Requests
          that already reached an upstream are only retried if they are safe to repeat (GET, HEAD…).`),
        placeholder: '0 (off)', example: '2',
      },
      {
        id: 'lb_try_duration', dir: 'lb_try_duration', type: 'text', kind: 'duration', label: 'Keep trying for',
        help: d(`How long to keep looking for an available upstream before giving up with an error.
          Useful to ride out a backend restart instead of failing immediately.`),
        placeholder: '0 (off)', example: '5s',
      },
      {
        id: 'lb_try_interval', dir: 'lb_try_interval', type: 'text', kind: 'duration', label: 'Wait between tries',
        help: 'How long to wait before trying the next upstream after a failure.',
        placeholder: '250ms', example: '500ms',
      },
    ],
  },
  {
    id: 'active',
    title: 'Active health checks',
    help: d(`Caddy polls each upstream in the background and stops sending traffic to any that fail,
      until it recovers. Turned on by setting a path to check.`),
    fields: [
      {
        id: 'health_uri', dir: 'health_uri', type: 'text', label: 'Path to check',
        help: 'The URL path (and optional query) Caddy requests on each upstream. Setting it turns active checks on.',
        placeholder: '/healthz', example: '/health?full=1',
      },
      {
        id: 'health_port', dir: 'health_port', type: 'text', kind: 'port', label: 'Port',
        help: "Check a different port than the one traffic goes to, e.g. a separate management port.",
        placeholder: "the upstream's port", example: '8081',
      },
      {
        id: 'health_interval', dir: 'health_interval', type: 'text', kind: 'duration', label: 'Every',
        help: 'How often to check each upstream.', placeholder: '30s', example: '10s',
      },
      {
        id: 'health_timeout', dir: 'health_timeout', type: 'text', kind: 'duration', label: 'Timeout',
        help: 'How long a check may take before it counts as failed.', placeholder: '5s', example: '2s',
      },
      {
        id: 'health_status', dir: 'health_status', type: 'text', kind: 'status', label: 'Expected status',
        help: 'The status code a healthy upstream returns. Use 2xx to accept any 200–299 response.',
        placeholder: '2xx', example: '200',
      },
      {
        id: 'health_body', dir: 'health_body', type: 'text', label: 'Body must contain',
        help: 'Text (or a regular expression) the response body must contain to count as healthy.',
        placeholder: 'anything', example: 'OK',
      },
      {
        id: 'health_passes', dir: 'health_passes', type: 'text', kind: 'number', label: 'Passes to recover',
        help: 'Consecutive successful checks before a down upstream receives traffic again.',
        placeholder: '1', example: '2',
      },
      {
        id: 'health_fails', dir: 'health_fails', type: 'text', kind: 'number', label: 'Failures to mark down',
        help: 'Consecutive failed checks before an upstream stops receiving traffic.',
        placeholder: '1', example: '3',
      },
      {
        id: 'health_follow_redirects', dir: 'health_follow_redirects', type: 'flag', label: 'Follow redirects',
        help: 'Follow redirects returned by the health check instead of treating a redirect as the answer.',
      },
    ],
  },
  {
    id: 'passive',
    title: 'Passive health checks',
    help: d(`Caddy watches real traffic and takes an upstream out of rotation after too many failed
      requests. Turned on by setting "Remember failures for".`),
    fields: [
      {
        id: 'fail_duration', dir: 'fail_duration', type: 'text', kind: 'duration', label: 'Remember failures for',
        help: 'How long a failed request counts against an upstream. Setting this turns passive checks on.',
        placeholder: '0 (off)', example: '30s',
      },
      {
        id: 'max_fails', dir: 'max_fails', type: 'text', kind: 'number', label: 'Failures allowed',
        help: 'How many failures within that window mark the upstream down.',
        placeholder: '1', example: '3',
      },
      {
        id: 'unhealthy_status', dir: 'unhealthy_status', type: 'list', kind: 'status', label: 'Count these statuses as failures',
        help: 'Response codes that count as a failed request, not just connection errors.',
        placeholder: '5xx', example: '500 502 503',
      },
      {
        id: 'unhealthy_latency', dir: 'unhealthy_latency', type: 'text', kind: 'duration', label: 'Slower than',
        help: 'Responses taking longer than this count as failures.', placeholder: 'off', example: '5s',
      },
      {
        id: 'unhealthy_request_count', dir: 'unhealthy_request_count', type: 'text', kind: 'number', label: 'Max concurrent requests',
        help: 'An upstream already handling this many requests is skipped until it catches up.',
        placeholder: 'unlimited', example: '100',
      },
    ],
  },
  {
    id: 'headers',
    title: 'Headers & client addresses',
    help: d(`Caddy already sends the standard X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host
      headers and passes the original Host header through. Add or change others here.`),
    fields: [
      {
        id: 'header_up', dir: 'header_up', type: 'rows', label: 'Send to upstream',
        help: d(`Headers added to or changed on each request before it reaches the upstream.
          Prefix the name with - to remove a header, + to add another value.
          Placeholders work in the value, e.g. {remote_host} or {http.request.header.X-Foo}.`),
        columns: [
          { label: 'Header', placeholder: 'X-Real-IP' },
          { label: 'Value', placeholder: '{remote_host}', rest: true, optional: true },
        ],
        example: 'X-Real-IP {remote_host}',
      },
      {
        id: 'header_down', dir: 'header_down', type: 'rows', label: 'Change in responses',
        help: 'Headers changed on responses coming back from the upstream. Prefix with - to strip one, e.g. -Server.',
        columns: [
          { label: 'Header', placeholder: '-X-Powered-By' },
          { label: 'Value', placeholder: '(none to remove)', rest: true, optional: true },
        ],
        example: '-X-Powered-By',
      },
      {
        id: 'trusted_proxies', dir: 'trusted_proxies', type: 'list', label: 'Trust X-Forwarded-* from',
        help: d(`If requests reach Caddy through another proxy or CDN, list its addresses so the
          X-Forwarded-* headers it sets are passed on instead of overwritten.
          "private_ranges" covers all private networks.`),
        placeholder: 'private_ranges', example: '173.245.48.0/20 private_ranges',
      },
    ],
  },
  {
    id: 'stream',
    title: 'Streaming & buffering',
    help: 'How response and request bodies flow through Caddy.',
    fields: [
      {
        id: 'flush_interval', dir: 'flush_interval', type: 'text', kind: 'duration', label: 'Flush interval',
        help: d(`-1 sends data to the visitor as soon as the upstream writes it: needed for live
          streams, long polling and progress output. Caddy already does this for server-sent
          events (text/event-stream); a positive duration flushes on that schedule.`),
        placeholder: 'automatic', example: '-1',
      },
      {
        id: 'request_buffers', dir: 'request_buffers', type: 'text', kind: 'size', label: 'Buffer request bodies up to',
        help: d(`Read up to this much of an upload before sending it to the upstream.
          Helps upstreams that cannot handle slow clients; costs memory per request.`),
        placeholder: 'off (stream)', example: '4MB',
      },
      {
        id: 'response_buffers', dir: 'response_buffers', type: 'text', kind: 'size', label: 'Buffer responses up to',
        help: 'Read up to this much of a response before sending it on. Usually best left off.',
        placeholder: 'off (stream)', example: '1MB',
      },
      {
        id: 'stream_timeout', dir: 'stream_timeout', type: 'text', kind: 'duration', label: 'Close long streams after',
        help: 'Forcibly end WebSocket and other upgraded connections after this long.',
        placeholder: 'never', example: '24h',
      },
      {
        id: 'stream_close_delay', dir: 'stream_close_delay', type: 'text', kind: 'duration', label: 'Keep streams through reloads for',
        help: d(`When Caddy reloads its config, keep open WebSockets alive this long instead of
          closing them at once, so clients do not all reconnect at the same moment.`),
        placeholder: '0 (close on reload)', example: '5m',
      },
    ],
  },
  {
    id: 'transport',
    title: 'Connection to the upstream',
    help: d(`How Caddy connects to the upstream (the "http" transport). Upstreams written as
      https://… already use TLS.`),
    fields: [
      {
        id: 'tls', dir: 'tls', path: TRANSPORT, type: 'flag', label: 'Use HTTPS to the upstream',
        help: 'Connect to the upstream with TLS. Not needed when the upstream address starts with https://.',
      },
      {
        id: 'tls_insecure_skip_verify', dir: 'tls_insecure_skip_verify', path: TRANSPORT, type: 'flag',
        label: "Don't verify the upstream's certificate",
        help: d(`Accept any certificate from the upstream, including self-signed ones. Only for
          upstreams on a network you trust: it removes protection against interception.`),
      },
      {
        id: 'tls_server_name', dir: 'tls_server_name', path: TRANSPORT, type: 'text', label: 'Expect certificate for',
        help: "The host name to verify the upstream's certificate against, when it differs from the address you connect to.",
        placeholder: 'the upstream host', example: 'internal.example.com',
      },
      {
        id: 'dial_timeout', dir: 'dial_timeout', path: TRANSPORT, type: 'text', kind: 'duration', label: 'Connect timeout',
        help: 'How long to wait for a connection to the upstream to open.', placeholder: '3s', example: '5s',
      },
      {
        id: 'response_header_timeout', dir: 'response_header_timeout', path: TRANSPORT, type: 'text', kind: 'duration',
        label: 'Response timeout',
        help: 'How long to wait for the upstream to start answering (its headers) once the request is sent.',
        placeholder: 'unlimited', example: '30s',
      },
      {
        id: 'read_timeout', dir: 'read_timeout', path: TRANSPORT, type: 'text', kind: 'duration', label: 'Read timeout',
        help: 'Maximum time between reads from the upstream before the connection is dropped.',
        placeholder: 'unlimited', example: '60s',
      },
      {
        id: 'write_timeout', dir: 'write_timeout', path: TRANSPORT, type: 'text', kind: 'duration', label: 'Write timeout',
        help: 'Maximum time between writes to the upstream before the connection is dropped.',
        placeholder: 'unlimited', example: '60s',
      },
      {
        id: 'keepalive', dir: 'keepalive', path: TRANSPORT, type: 'text', label: 'Keep idle connections for',
        help: 'How long unused connections to the upstream stay open for reuse. "off" opens a new connection per request.',
        placeholder: '2m', example: '5m',
      },
      {
        id: 'keepalive_idle_conns', dir: 'keepalive_idle_conns', path: TRANSPORT, type: 'text', kind: 'number',
        label: 'Idle connections to keep',
        help: 'Maximum number of idle connections kept open for reuse, across all upstreams.',
        placeholder: '32', example: '100',
      },
      {
        id: 'max_conns_per_host', dir: 'max_conns_per_host', path: TRANSPORT, type: 'text', kind: 'number',
        label: 'Max connections per upstream',
        help: 'Limit on simultaneous connections to each upstream; further requests wait.',
        placeholder: 'unlimited', example: '50',
      },
      {
        id: 'versions', dir: 'versions', path: TRANSPORT, type: 'checks', label: 'HTTP versions',
        help: d(`Protocols Caddy may use to talk to the upstream. h2c is HTTP/2 without TLS
          (e.g. gRPC to a plain-text backend).`),
        options: [
          { value: '1.1', label: 'HTTP/1.1' },
          { value: '2', label: 'HTTP/2' },
          { value: 'h2c', label: 'h2c' },
          { value: '3', label: 'HTTP/3' },
        ],
        example: '1.1 2 (default)',
      },
      {
        id: 'compression', dir: 'compression', path: TRANSPORT, type: 'select', label: 'Compression from upstream',
        help: 'Whether Caddy asks the upstream for compressed responses. Turn off if the upstream compresses badly.',
        options: [
          { value: '', label: 'Allowed (default)' },
          { value: 'off', label: 'Off' },
        ],
      },
      {
        id: 'proxy_protocol', dir: 'proxy_protocol', path: TRANSPORT, type: 'select', label: 'PROXY protocol',
        help: d(`Send the visitor's real address to the upstream with the PROXY protocol. Only if the
          upstream expects it — otherwise every request fails.`),
        options: [
          { value: '', label: 'Off (default)' },
          { value: 'v1', label: 'v1 (text)' },
          { value: 'v2', label: 'v2 (binary)' },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
//  Static files — edited on the `file_server` block
// ---------------------------------------------------------------------------

export const FILE_SERVER_FIELDS = [
  {
    id: 'browse', type: 'flag', label: 'Directory listings',
    help: 'Show a file listing for directories without an index file. Leave off unless the files are meant to be browsed.',
    read: (n) => n.tokens.includes('browse') || Boolean(n.body?.some((x) => isDir(x, 'browse'))),
    write: (n, on) => {
      n.tokens = n.tokens.filter((t) => t !== 'browse');
      n.body = n.body?.filter((x) => !isDir(x, 'browse')) ?? null;
      if (on) n.tokens.push('browse');
    },
  },
  {
    id: 'index', dir: 'index', type: 'list', label: 'Index files',
    help: 'File names tried, in order, when a directory is requested.', placeholder: 'index.html index.txt', example: 'index.html index.htm',
  },
  {
    id: 'hide', dir: 'hide', type: 'list', label: 'Never serve',
    help: 'Files or patterns that are never served, even if requested directly. Relative names match anywhere.',
    placeholder: '.git', example: '.git .env *.bak',
  },
  {
    id: 'precompressed', dir: 'precompressed', type: 'checks', label: 'Serve pre-compressed copies',
    help: d(`If a file has a compressed sibling (app.js.zst, app.js.br, app.js.gz), send that instead to
      browsers that accept it. The copies must exist on disk.`),
    options: [
      { value: 'zstd', label: 'zstd (.zst)' },
      { value: 'br', label: 'Brotli (.br)' },
      { value: 'gzip', label: 'gzip (.gz)' },
    ],
  },
  {
    id: 'status', dir: 'status', type: 'text', kind: 'status', label: 'Response status',
    help: 'Serve files with this status instead of 200 — e.g. a static maintenance page returned as 503.',
    placeholder: '200', example: '503',
  },
  {
    id: 'disable_canonical_uris', dir: 'disable_canonical_uris', type: 'flag', label: "Don't redirect to canonical URLs",
    help: 'By default /dir is redirected to /dir/ and /index.html to /. Turn this on to stop those redirects.',
  },
  {
    id: 'pass_thru', dir: 'pass_thru', type: 'flag', label: 'Fall through when not found',
    help: 'If a file does not exist, let the next handler try instead of returning 404.',
  },
];

// ---------------------------------------------------------------------------
//  TLS options — the `tls { }` block of a site
// ---------------------------------------------------------------------------

const TLS = [{ name: 'tls', any: true }];

export const TLS_FIELDS = [
  {
    id: 'protocols', type: 'custom', label: 'TLS versions',
    help: d(`Oldest and newest TLS versions accepted from browsers. The default (1.2 to 1.3) suits
      almost everyone; require 1.3 only if every client supports it.`),
    read: (site) => {
      const n = resolve(site, TLS)?.body?.find((x) => isDir(x, 'protocols'));
      const a = n ? argsOf(n) : [];
      return [a[0] ?? '', a[1] ?? ''];
    },
    write: (site, [min, max]) => {
      const tls = resolve(site, TLS, Boolean(min || max));
      if (!tls) return;
      tls.body ??= [];
      replaceNodes(tls.body, (x) => isDir(x, 'protocols'), min || max ? [directive(['protocols', min || 'tls1.2', ...(max ? [max] : [])])] : []);
      if (!tls.body.length) dropEmptyTls(site, tls);
    },
  },
  {
    id: 'key_type', dir: 'key_type', path: TLS, type: 'select', label: 'Key type',
    help: 'The kind of private key for this certificate. ECDSA P-256 is fast and universally supported.',
    options: [
      { value: '', label: 'Default (ECDSA P-256)' },
      { value: 'ed25519', label: 'Ed25519' },
      { value: 'p256', label: 'ECDSA P-256' },
      { value: 'p384', label: 'ECDSA P-384' },
      { value: 'rsa2048', label: 'RSA 2048 (old clients)' },
      { value: 'rsa4096', label: 'RSA 4096' },
    ],
  },
  {
    id: 'ca', dir: 'ca', path: TLS, type: 'text', kind: 'url', label: 'Certificate authority (ACME URL)',
    help: d(`The ACME directory to get this site's certificate from. Leave blank for Let's Encrypt
      with ZeroSSL as fallback. Use the Let's Encrypt staging URL while testing to avoid rate limits.`),
    placeholder: "Let's Encrypt / ZeroSSL",
    suggestions: [
      'https://acme-v02.api.letsencrypt.org/directory',
      'https://acme-staging-v02.api.letsencrypt.org/directory',
      'https://acme.zerossl.com/v2/DV90',
    ],
    example: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  },
  {
    id: 'dns', dir: 'dns', path: TLS, type: 'text', multi: true, label: 'DNS challenge provider',
    help: d(`Prove domain ownership through DNS instead of HTTP: works for internal-only names and
      is required for wildcard certificates. Needs a Caddy build with the provider's plugin
      (set CADDY_IMAGE). Keep API tokens in environment variables.`),
    placeholder: 'provider {env.TOKEN}', example: 'cloudflare {env.CF_API_TOKEN}',
  },
  {
    id: 'resolvers', dir: 'resolvers', path: TLS, type: 'list', label: 'DNS resolvers for the challenge',
    help: 'DNS servers used to check the challenge record, when the system resolver sees stale or internal answers.',
    placeholder: 'system', example: '1.1.1.1 8.8.8.8',
  },
  {
    id: 'on_demand', dir: 'on_demand', path: TLS, type: 'flag', label: 'On-demand certificates',
    help: d(`Get certificates at the first connection for each name instead of at startup — for sites
      serving customer domains. Requires on_demand_tls { ask … } in the global options, or anyone
      could make Caddy request certificates for arbitrary names.`),
  },
];

export function dropEmptyTls(site, tls) {
  if (tls.tokens.length === 1) site.body = site.body.filter((x) => x !== tls);
  else tls.body = null;
}

// ---------------------------------------------------------------------------
//  Site-wide simple fields
// ---------------------------------------------------------------------------

export const SITE_FIELDS = {
  bind: {
    id: 'bind', dir: 'bind', type: 'list', label: 'Listen only on',
    help: d(`Network addresses this site listens on. By default Caddy listens on every interface of the
      server. Restrict it to keep an internal site off a public interface.`),
    placeholder: 'all interfaces', example: '10.40.10.5 127.0.0.1',
  },
  requestBody: {
    id: 'max_size', dir: 'max_size', path: [{ name: 'request_body' }], type: 'text', kind: 'size',
    label: 'Largest upload allowed',
    help: 'Requests with a bigger body are rejected with 413 before reaching the app.', placeholder: 'unlimited', example: '100MB',
  },
  logSkip: {
    id: 'log_skip', dir: ['log_skip', 'skip_log'], type: 'rows', label: "Don't log requests to",
    help: d(`Paths left out of the access log (and so out of the statistics). Leave the path empty to
      stop logging this site entirely. Wildcards: /health*, *.png.`),
    columns: [{ label: 'Path', placeholder: '/health', optional: true }],
    example: '/healthz',
  },
  templates: {
    id: 'templates', dir: 'templates', type: 'flag', label: 'Process templates',
    help: d(`Run responses (HTML, text) through Caddy's template engine, so pages can include
      {{.RemoteIP}}, other files and more. Only for content you control.`),
  },
  metrics: {
    id: 'metrics', dir: 'metrics', type: 'text', label: 'Prometheus metrics at',
    help: d(`Serve Caddy's Prometheus metrics at this path on this site. Protect it (e.g. with the IP
      allowlist): metrics reveal traffic details.`),
    placeholder: 'off', example: '/metrics',
  },
  vars: {
    id: 'vars', dir: 'vars', type: 'rows', label: 'Variables',
    help: 'Named values other directives can read as {vars.name} — handy for values used in several places.',
    columns: [{ label: 'Name', placeholder: 'backend' }, { label: 'Value', placeholder: '10.0.0.5:8080', rest: true, optional: true }],
    example: 'backend 10.0.0.5:8080',
  },
};

// ---------------------------------------------------------------------------
//  Global options — the `{ }` block at the top of the file
// ---------------------------------------------------------------------------

const SERVERS = [{ name: 'servers' }];
const TIMEOUTS = [{ name: 'servers' }, { name: 'timeouts' }];

export const GLOBAL_GROUPS = [
  {
    id: 'certs',
    title: 'Certificates',
    help: 'Defaults for how every site gets its HTTPS certificate.',
    fields: [
      {
        id: 'email', dir: 'email', type: 'text', label: 'ACME account e-mail',
        help: 'Contact address for your certificate authority account; they use it for expiry and policy notices.',
        placeholder: 'none', example: 'ops@example.com',
      },
      {
        id: 'auto_https', dir: 'auto_https', type: 'select', label: 'Automatic HTTPS',
        help: 'Caddy gets certificates for every site and redirects HTTP to HTTPS by default. Narrow that here.',
        options: [
          { value: '', label: 'On (default)' },
          { value: 'disable_redirects', label: 'On, without HTTP → HTTPS redirects' },
          { value: 'ignore_loaded_certs', label: 'On, even for names with manually loaded certificates' },
          { value: 'disable_certs', label: 'Redirects only, no certificate management' },
          { value: 'off', label: 'Off entirely' },
        ],
      },
      {
        id: 'acme_ca', dir: 'acme_ca', type: 'text', kind: 'url', label: 'Certificate authority (ACME URL)',
        help: "Default ACME directory for all sites. Blank = Let's Encrypt with ZeroSSL as fallback.",
        placeholder: "Let's Encrypt / ZeroSSL",
        suggestions: [
          'https://acme-v02.api.letsencrypt.org/directory',
          'https://acme-staging-v02.api.letsencrypt.org/directory',
          'https://acme.zerossl.com/v2/DV90',
        ],
      },
      {
        id: 'acme_dns', dir: 'acme_dns', type: 'text', multi: true, label: 'DNS challenge for all sites',
        help: 'Use the DNS challenge for every site by default. Needs a Caddy build with the provider plugin (CADDY_IMAGE).',
        placeholder: 'off', example: 'cloudflare {env.CF_API_TOKEN}',
      },
      {
        id: 'key_type', dir: 'key_type', type: 'select', label: 'Key type',
        help: 'Default private key type for certificates.',
        options: [
          { value: '', label: 'Default (ECDSA P-256)' },
          { value: 'ed25519', label: 'Ed25519' },
          { value: 'p256', label: 'ECDSA P-256' },
          { value: 'p384', label: 'ECDSA P-384' },
          { value: 'rsa2048', label: 'RSA 2048' },
          { value: 'rsa4096', label: 'RSA 4096' },
        ],
      },
      {
        id: 'local_certs', dir: 'local_certs', type: 'flag', label: 'Use the internal CA for every site',
        help: "Issue every certificate from Caddy's own CA instead of a public one — for fully internal setups.",
      },
      {
        id: 'skip_install_trust', dir: 'skip_install_trust', type: 'flag', label: "Don't install the internal CA",
        help: "Skip adding Caddy's root certificate to the system trust store. Inside a container it cannot anyway.",
      },
      {
        id: 'ocsp_stapling', dir: 'ocsp_stapling', type: 'select', label: 'OCSP stapling',
        help: "Caddy attaches certificate revocation status to handshakes. Turn off only if the CA's OCSP service is unreachable.",
        options: [{ value: '', label: 'On (default)' }, { value: 'off', label: 'Off' }],
      },
      {
        id: 'renew_interval', dir: 'renew_interval', type: 'text', kind: 'duration', label: 'Check renewals every',
        help: 'How often Caddy checks whether certificates need renewing.', placeholder: '10m', example: '1h',
      },
    ],
  },
  {
    id: 'server',
    title: 'Ports & shutdown',
    help: 'Where Caddy listens and how it handles reloads.',
    fields: [
      {
        id: 'http_port', dir: 'http_port', type: 'text', kind: 'port', label: 'HTTP port',
        help: 'Port for plain HTTP (and the ACME HTTP challenge). Change only if something else must have 80.',
        placeholder: '80', example: '8080',
      },
      {
        id: 'https_port', dir: 'https_port', type: 'text', kind: 'port', label: 'HTTPS port',
        help: 'Port for HTTPS.', placeholder: '443', example: '8443',
      },
      {
        id: 'default_sni', dir: 'default_sni', type: 'text', label: 'Default certificate name',
        help: 'Certificate to use for clients that do not say which name they want (old clients, bare IP access).',
        placeholder: 'none', example: 'example.com',
      },
      {
        id: 'grace_period', dir: 'grace_period', type: 'text', kind: 'duration', label: 'Reload grace period',
        help: 'On reload or shutdown, how long to let in-flight requests finish before closing them.',
        placeholder: 'wait forever', example: '10s',
      },
      {
        id: 'shutdown_delay', dir: 'shutdown_delay', type: 'text', kind: 'duration', label: 'Shutdown delay',
        help: 'Keep serving this long after a shutdown is requested, so a load balancer can notice first.',
        placeholder: '0', example: '5s',
      },
      {
        id: 'debug', dir: 'debug', type: 'flag', label: 'Debug logging',
        help: "Very verbose Caddy logs (docker compose logs caddy). Turn on to diagnose, then off again.",
      },
    ],
  },
  {
    id: 'servers',
    title: 'HTTP servers',
    help: 'Options for every HTTP server Caddy runs (the servers { } global option).',
    fields: [
      {
        id: 'trusted_proxies', type: 'custom', label: 'Trusted proxies',
        help: d(`If Caddy sits behind a CDN or load balancer, list its address ranges so the visitor's
          real address is taken from X-Forwarded-For. Affects logs, client_ip matching and the
          statistics. "private_ranges" covers all private networks.`),
        placeholder: 'none', example: '173.245.48.0/20 private_ranges',
        read: (g) => {
          const n = resolve(g, SERVERS)?.body?.find((x) => isDir(x, 'trusted_proxies'));
          const a = n ? argsOf(n) : [];
          return a[0] === 'static' ? a.slice(1) : a;
        },
        write: (g, vals) => {
          const s = resolve(g, SERVERS, vals.length > 0);
          if (!s) return;
          s.body ??= [];
          replaceNodes(s.body, (x) => isDir(x, 'trusted_proxies'), vals.length ? [directive(['trusted_proxies', 'static', ...vals.map(quote)])] : []);
          if (!s.body.length) g.body = g.body.filter((x) => x !== s);
        },
        listLike: true,
      },
      {
        id: 'client_ip_headers', dir: 'client_ip_headers', path: SERVERS, type: 'list', label: 'Client address headers',
        help: 'Headers read, in order, for the real client address when the request comes from a trusted proxy.',
        placeholder: 'X-Forwarded-For', example: 'CF-Connecting-IP X-Forwarded-For',
      },
      {
        id: 'protocols', dir: 'protocols', path: SERVERS, type: 'checks', label: 'Protocols',
        help: 'HTTP versions browsers may use. HTTP/3 needs UDP 443 open.',
        options: [
          { value: 'h1', label: 'HTTP/1.1' },
          { value: 'h2', label: 'HTTP/2' },
          { value: 'h2c', label: 'h2c' },
          { value: 'h3', label: 'HTTP/3' },
        ],
        example: 'h1 h2 h3 (default)',
      },
      {
        id: 'read_body', dir: 'read_body', path: TIMEOUTS, type: 'text', kind: 'duration', label: 'Read body timeout',
        help: 'Longest a client may take to send a request body.', placeholder: 'unlimited', example: '1m',
      },
      {
        id: 'read_header', dir: 'read_header', path: TIMEOUTS, type: 'text', kind: 'duration', label: 'Read headers timeout',
        help: 'Longest a client may take to send request headers. Guards against slow-loris attacks.', placeholder: '1m', example: '10s',
      },
      {
        id: 'write', dir: 'write', path: TIMEOUTS, type: 'text', kind: 'duration', label: 'Write timeout',
        help: 'Longest a response may take to send. Long downloads and streams need this unset.', placeholder: 'unlimited', example: '5m',
      },
      {
        id: 'idle', dir: 'idle', path: TIMEOUTS, type: 'text', kind: 'duration', label: 'Idle timeout',
        help: 'How long an idle keep-alive connection stays open.', placeholder: '5m', example: '2m',
      },
      {
        id: 'max_header_size', dir: 'max_header_size', path: SERVERS, type: 'text', kind: 'size', label: 'Largest request headers',
        help: 'Requests with bigger headers are rejected. Raise if apps set very large cookies.', placeholder: '1MB', example: '64KB',
      },
      {
        id: 'log_credentials', dir: 'log_credentials', path: SERVERS, type: 'flag', label: 'Log credentials',
        help: 'Include Cookie and Authorization headers in access logs. Off by default for good reason.',
      },
      {
        id: 'strict_sni_host', dir: 'strict_sni_host', path: SERVERS, type: 'select', label: 'Require Host to match SNI',
        help: 'Reject requests whose Host header differs from the name used in the TLS handshake.',
        options: [{ value: '', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'insecure_off', label: 'Off (insecure)' }],
      },
    ],
  },
];
