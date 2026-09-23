# Caddy Log Interface

A self-hosted dashboard and control panel for Caddy. One Docker Compose stack
runs Caddy itself alongside the interface: it reads Caddy's JSON access logs
read-only and keeps its own statistics (so history survives log rotation and
deletion), and it edits Caddy's configuration, reloading Caddy for you.

- **Caddy configuration** — add, remove, enable and disable sites; change
  domains, upstreams, IP allowlists, TLS, compression, snippets and global
  options from forms; edit any directive at any depth in a tree editor; or edit
  the raw Caddyfile. Every change is shown as a diff, validated by Caddy, and
  applied with a zero-downtime reload. Past versions can be restored.
- **Dashboard** — hits, 2xx vs non-2xx, top talkers, top URLs, bandwidth,
  latency percentiles, country map, top networks, browsers, referrers.
- **Domains** — every host that received a request Caddy actually served, with
  counters; click through for user agents, source countries and ASNs, a world
  heatmap, protocol/TLS breakdown, slowest and most error-prone URLs.
- **Drill-down** — every value in the app is clickable. A source IP, user
  agent, URL, country, ASN, TLS cipher or latency bucket all resolve to the
  individual requests behind them, and source addresses get their own page with
  enrichment and behaviour.
- **Log stream** — near-real-time tail with pause, filters, and per-request
  JSON pretty-print.
- **Health** — what the ingester is reading and whether IP enrichment is
  working.

---

## 1. Requirements

- Docker with the Compose plugin
- Nothing else listening on ports 80/443 — the stack runs Caddy (2.8 or newer)
- A MaxMind GeoLite2 country database for visitor-country data (free, see below)
- Outbound HTTPS to notoolkit.com for BGP prefix / ASN data (no key required)

## 2. Install

```bash
git clone <this repo> caddy-log-interface && cd caddy-log-interface
cp .env.example .env
```

Edit `.env`. The two settings you must change:

```bash
# 32+ random bytes; sessions are signed and stored against this
SESSION_SECRET=<paste output of: openssl rand -hex 32>

# who may log in
AUTH_USERS=nick:<a long, unique password>
```

### Create the directories

All storage is bind-mounted — there are no named volumes. Docker manages
ownership for named volumes but **not** for bind mounts, so the directories the
interface writes to have to be owned by the UID the containers run as:

```bash
mkdir -p ./data ./caddy/conf ./caddy/run ./caddy/logs ./caddy/data ./caddy/config
cp Caddyfile.example ./caddy/conf/Caddyfile       # then edit the host name
sudo chown -R "$(id -u):$(id -g)" ./data ./caddy/conf ./caddy/run
chmod 700 ./caddy/run
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> .env
```

(Or leave `PUID`/`PGID` at their default of `1000` and `chown 1000:1000` those
three.) If `./data` is wrong, the containers exit immediately with a message
naming the exact `chown` to run — they will not start half-working. If
`./caddy/conf` is wrong, the Caddy pages say the Caddyfile is read-only.

| Directory | Written by | Read by |
|---|---|---|
| `./data` | web, ingest | web, ingest |
| `./caddy/conf` (the Caddyfile) | web, on apply | caddy, web |
| `./caddy/run` (admin socket) | caddy | web |
| `./caddy/logs` | caddy | web, ingest (read-only) |
| `./caddy/data`, `./caddy/config` (certificates) | caddy | caddy only |

`./caddy/run` holds Caddy's admin socket. Its `0700` mode, owned by `PUID`, is
what keeps other host users from reconfiguring Caddy through it.

Keep `DATA_PATH` on a **local** filesystem. SQLite's WAL mode is not safe over
NFS or CIFS.

Then:

```bash
docker compose up -d --build
```

The UI is on `http://<host>:8899` (`APP_PORT`), published on all interfaces per
`BIND_ADDRESS`. Put it behind Caddy for TLS — see `Caddyfile.example`.

### Keeping the password out of .env

`AUTH_USERS` accepts a pre-computed hash instead of a plaintext password:

```bash
docker compose run --rm --no-deps web node src/tools/hash.js
```

It prints an `AUTH_USERS=user:scrypt$...$...` line to paste in. Multiple users
are separated by commas or newlines.

### GeoLite2 (country data)

notoolkit provides ASN information only, so countries come from MaxMind.
Sign up for a free GeoLite2 account, create a licence key, download
`GeoLite2-Country.mmdb` (and optionally `GeoLite2-ASN.mmdb`, used as an ASN
fallback when notoolkit is unreachable), and drop them in `./geoip/`:

```
geoip/
  GeoLite2-Country.mmdb
  GeoLite2-ASN.mmdb      # optional
```

The directory is mounted read-only at `/geoip`. Without it the stack still
runs; the country map is simply empty and the Health page says so.

### Moving an existing Caddy into this stack

If Caddy already runs from its own compose file, point this stack at the same
directories instead of starting fresh — certificates, the Caddyfile and logs
all carry over. With the old layout `<dir>/Caddyfile`, `<dir>/data`,
`<dir>/config`, `<dir>/logs`:

```bash
mkdir -p <dir>/conf <dir>/run
mv <dir>/Caddyfile <dir>/conf/Caddyfile       # a directory mount, for atomic saves
sudo chown -R "$(id -u):$(id -g)" <dir>/conf <dir>/run && chmod 700 <dir>/run
sudo chmod 644 <dir>/logs/*.log               # existing logs were created 0600
```

```bash
# .env
CADDY_CONF_PATH=<dir>/conf
CADDY_DATA_PATH=<dir>/data
CADDY_STATE_PATH=<dir>/config
CADDY_LOG_HOST_PATH=<dir>/logs
CADDY_RUN_PATH=<dir>/run
```

Then, in the Caddyfile, add `mode 0644` inside each `output file` block (see
`Caddyfile.example`) so files Caddy creates after a rotation stay readable, and
remove any `admin` global option. Stop the old Caddy
(`docker compose -f <old compose file> down`) and `docker compose up -d --build`
here.

## 3. Managing Caddy

The **Caddy** section of the interface edits the Caddyfile:

| Page | What it does |
|---|---|
| **Sites** | Every site block, with what it proxies to. Add a site (reverse proxy, static files, redirect or fixed response), switch one off and on, duplicate, delete. Each domain links to its traffic statistics. |
| **Site editor** | Every common option as a form field, each with a **?** tooltip explaining what it does, what to enter, the default and an example: domains and listen addresses; what the site does (reverse proxy, static files, PHP, redirect or fixed response) with all their options — load balancing, active and passive health checks, upstream headers, streaming and buffering, timeouts, upstream TLS and HTTP versions; path rules (redirect, rewrite, block, respond, or proxy/serve a path elsewhere); IP allowlist, password protection (hashed for you), single sign-on via forward auth and upload limits; certificate source, TLS versions, key type, CA and DNS challenge; security-header presets and custom request/response headers; compression; logging and snippets; templates, metrics and variables. Anything without a form is listed under *Advanced* and stays editable in *All directives*, which edits every directive at any depth; *Source* edits the block as text. |
| **Global & snippets** | The global options as documented form fields (certificates and ACME, ports and shutdown, trusted proxies, protocols and timeouts), plus a tree editor for everything else, and the snippets sites import. Renaming a snippet updates the imports that use it. |
| **Caddyfile** | The whole file as text, with Caddy validation, a formatter and the JSON config Caddy is actually running. |
| **History** | Every version applied from the interface, with who, when and why. Any version can be compared and restored. |

**Nothing changes until you apply.** Edits on all pages build up one draft (it
survives moving between pages and a refresh). *Review & apply* shows the diff,
has Caddy validate it, and on apply:

1. checks the file has not changed on disk since you opened it — if it has, you
   choose between loading the new version or overwriting it;
2. has Caddy adapt the Caddyfile (`/adapt`) — syntax and directive errors are
   shown with a link to the offending line;
3. refuses a config that would disable or move Caddy's admin endpoint, since
   that would cut the interface off;
4. loads it into Caddy (`/load`) — a graceful reload with no dropped
   connections. If Caddy cannot start the new config it keeps running the old
   one and reports why;
5. only then writes the Caddyfile (atomically), so the file on disk is always
   a config Caddy has accepted and a restart can never come up broken;
6. records the version in history.

**Disabled sites** are commented out, not deleted: every line of the block is
prefixed with `#`, the way an editor's "comment out" does. The interface
recognises a block commented that way (`#example.com {` — no space after the
`#`) as a disabled site, so hand-commented sites show up as switchable too.
Documentation-style comments (`# example.com {`) are left alone.

**Formatting is preserved.** A block you have not touched is written back
byte-for-byte; a block you edit keeps its own indentation style, so diffs show
only what changed. *Format* on the Caddyfile page re-indents everything with
tabs, like `caddy fmt`.

**If the file is changed by hand** without a reload, the pages say Caddy is
running something different from the file and offer *Reload Caddy from the
file*. **If Caddy is down** — possibly because of the file — the pages say so,
and the review screen offers *Save file without reloading*; Caddy's restart
policy picks the fixed file up on its next attempt. The web container
deliberately does not depend on the caddy container, so the tool you fix Caddy
with is up even when Caddy is not.

`CADDY_EDITORS` limits who may apply changes (everyone else can still view);
`CADDY_MANAGE=false` turns the section off entirely.

Limits: `import` of other *files* (as opposed to snippets) is shown and kept,
but those files are not editable here, and relative import paths resolve inside
the Caddy container, so use absolute ones. Environment placeholders
(`{$VAR}`) are kept verbatim.

## 4. Verify it is reading your logs

Before wondering why the dashboard is empty:

```bash
docker compose run --rm --no-deps ingest node src/tools/inspect.js
```

This parses a sample of real lines and reports how many became requests, which
hosts it saw, and which fields your logs are missing. It writes nothing.

There is also a self-test for the pure logic that is easy to get subtly wrong —
CIDR matching, IP normalisation, log-field extraction. No database, no network,
no log files:

```bash
docker compose run --rm --no-deps web node src/tools/selftest.js
```

Worth running after changing `TRUSTED_PROXIES` or `IGNORE_CIDRS`, since those
are silent when wrong.

## 5. How the data is stored

Everything lives in one SQLite file on the `data` volume, in three tiers:

| Tier | Contents | Governed by |
|---|---|---|
| `events` | individual requests incl. the raw JSON line | `RAW_RETENTION_HOURS` (48h), capped by `RAW_MAX_ROWS` |
| `rollup` / `dims` at hourly granularity | every counter and dimension | `HOURLY_RETENTION_DAYS` (45d) |
| the same tables at daily granularity | folded from hourly | `RETENTION_DAYS` (365d) |

Requests are aggregated into the hourly tier within seconds of being logged, so
**deleting or rotating a Caddy log never loses statistics** — only the ability
to inspect those individual requests in the log stream.

Hourly rows are folded into daily rows once they pass the hourly window, and
the hourly rows are then deleted, so a period exists at exactly one granularity
and totals can never double-count. High-cardinality dimensions (URLs, IPs, user
agents, referrers) are trimmed to the top `DIM_TOP_N` values per bucket after
`DIM_COMPACT_AFTER_DAYS`, with the remainder folded into a single `(other)` row
so totals stay exact while storage stays bounded.

Maintenance runs hourly inside the `ingest` container. Nothing external to
schedule.

### What drill-down can and cannot reach

Clicking a value opens the **request explorer** (`/requests`) filtered to it.
That reads `events`, so it only reaches back `RAW_RETENTION_HOURS` — the UI
says so on every such view rather than showing an empty list that reads as
"this never happened".

Aggregates have no such limit: the counts on the dashboard and domain pages
cover the full `RETENTION_DAYS`. The split is deliberate — keeping every
individual request for a year would be enormous, while the counters are small.
If you routinely need to inspect requests further back, raise
`RAW_RETENTION_HOURS`; it is the largest tier on disk, so raise it knowingly.

Filters live entirely in the URL, so any drill-down is a shareable link and the
back button behaves.

On the Requests page you can also build filters directly — from the field row,
or by typing terms into the search box:

```
host:example.com  ua:curl  status:4xx  url:/wp-login  ip:203.0.113.9
country:US  asn:15169  ref:google.com  bot:yes  "exact phrase"
```

`ua:` and `url:` match anywhere in the value; quote a value that contains
spaces (`ua:"Mozilla/5.0 (X11"`). Anything that is not a term is matched as
free text across URL, agent, referrer, address and host.

Broad searches walk the retained requests newest-first in bounded chunks and
stop after about half a second, so a search can never stall the server. If one
stops before filling a page, it says how far back it got and offers **Search
older requests** to continue. Filtering by source IP goes straight to the
matching rows and is not limited this way.

### Rotation handling

The tailer tracks files by **inode**, not path. When Caddy rotates
`access.log` to `access-2024-01-02T00-00-00.000.log`, the checkpoint follows
the inode, so the rotated file is read to its end and the new `access.log`
starts cleanly at zero. Truncation in place is detected and restarts that file.

## 6. IP enrichment

| Source | Provides | Failure behaviour |
|---|---|---|
| MaxMind GeoLite2 | **visitor country** (and ASN if the ASN db is present) | local, always available |
| notoolkit.com `/?ip=` | BGP prefix, originating ASN, AS name/org | retried with backoff; **an error banner appears on the dashboard and Health page** |
| notoolkit.com `/?asn=` | RIR, registrant country, description, WHOIS, prefix counts | one lookup per distinct ASN, filled in the background |

**Two different countries.** MaxMind answers "where is this visitor" — that is
what the world map and country breakdowns use. notoolkit's `country` is where
the *autonomous system* is registered, which is a different thing (a
US-registered CDN serves traffic from everywhere). It is shown separately, in
the ASN table, labelled "Registered".

Per-IP results are cached in SQLite for `ENRICH_TTL_DAYS`. Ingest waits at most
`ENRICH_INLINE_TIMEOUT_MS` for a new IP; anything slower is written with what is
known locally, queued, and resolved in the background, so the cache is warm for
that address from then on. Private-range addresses are never sent anywhere.

Per-ASN registrant detail is fetched **once per ASN**, not per request — that
set is bounded by the number of networks that talk to your server, so the
`whois_raw` text and prefix counts cost one lookup each and are refreshed every
`ENRICH_ASN_TTL_DAYS` (default 90).

### Error handling

The API's status codes are treated distinctly, because they mean different
things:

| Response | Treated as |
|---|---|
| `404` no BGP prefix covers the address | a definitive answer. Cached as resolved-with-no-data, **not** retried in a loop, and **not** a health problem — unrouted and bogon space legitimately has no prefix. |
| `400` invalid parameter | same: cached, not retried. |
| `503`, other 5xx, timeout, network error | transient. Retried with exponential backoff (1m → 1h, `NOTOOLKIT_MAX_RETRIES` attempts), provider marked unhealthy, banner shown. |

Requests are rate-limited client-side to `NOTOOLKIT_RATE_PER_SEC` (default 10)
with a token bucket, on top of notoolkit's own 24-hour Redis cache.

The whole wire format lives in one file, `app/src/enrich/notoolkit.js`. The
public API needs no authentication; `NOTOOLKIT_API_KEY` / `NOTOOLKIT_AUTH_HEADER`
exist only so a key could be added later without a code change.

### When the API is on the same server

If this stack monitors the very Caddy instance that serves notoolkit.com, the
container will usually fail to reach the public hostname while the host itself
succeeds. That is **NAT hairpin**: the container resolves the public address,
the packet leaves via the default route, and the firewall declines to loop it
back in from the Docker subnet. It works from the host (the traffic never
leaves the box) and from anywhere external (it arrives normally), which makes
the failure look stranger than it is.

Rather than fight the firewall, stop leaving the network. Point at the origin
directly and name the virtual host, so Caddy's own `reverse_proxy` target is
reached over the LAN:

```bash
NOTOOLKIT_API_URL=http://10.0.0.5/        # whatever your reverse_proxy targets
NOTOOLKIT_HOST_HEADER=notoolkit.com       # so vhost routing still resolves
```

Plain HTTP is appropriate here: it stays on the local network, and the payload
is public routing data, not credentials. Do not use `https://` with an address
— the certificate will not match the IP and TLS will fail.

The alternative — keep TLS and go through Caddy — is a hosts entry pointing the
public name at the Docker host. That is a `.env` setting:

```bash
EXTRA_HOST=notoolkit.com:host-gateway
```

`host-gateway` is a Docker alias for the host itself, where Caddy is listening,
so the request crosses the bridge with correct SNI and a valid certificate.
With this set, leave `NOTOOLKIT_API_URL` as the public `https://` address and
`NOTOOLKIT_HOST_HEADER` blank. Leave `EXTRA_HOST` empty to disable it;
`EXTRA_HOST_2` is available if you need a second mapping. Requires Docker
Engine 20.10 or newer.

Either way, verify from inside the container:

```bash
docker compose run --rm --no-deps ingest node src/tools/probe.js
```

The probe reports DNS, TCP and HTTP separately with timings, and names the
likely cause when a stage fails. It writes nothing.

## 7. Security

The interface is built on the assumption it may be internet-facing.

- Session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`; the session id is
  stored **hashed**, so a stolen database file does not yield live sessions.
- Passwords are verified with scrypt and a constant-time comparison. Unknown
  usernames cost the same as known ones, so accounts cannot be enumerated.
- Failed logins are throttled per source IP (`LOGIN_MAX_ATTEMPTS` per
  `LOGIN_WINDOW_MINUTES`), plus a global API rate limit.
- CSRF: every state-changing request needs the token issued with the session.
- `X-Forwarded-For` is honoured **only** from `TRUSTED_PROXIES`, so a client
  cannot spoof its address to dodge the login throttle.
- Strict CSP (`default-src 'none'`, no inline scripts, no CDNs — the whole UI
  including the world map is bundled), HSTS, `nosniff`, `frame-ancestors none`,
  `no-referrer`.
- Containers run as a non-root user with a read-only root filesystem, all
  capabilities dropped and `no-new-privileges`. Your Caddy log directory is
  mounted read-only.
- Raw log content is rendered as React text nodes, never as HTML, so a crafted
  User-Agent or URL cannot inject markup into the dashboard.
- API errors are generic; details go to the container log, not the browser.
  The exception is Caddy's own validation message on the Caddy pages, which
  is configuration detail the signed-in operator needs.
- Caddy's admin API is on a unix socket in a `0700` directory, never on a TCP
  port, and the interface never gets the Docker socket. Anyone who can sign in
  (or is in `CADDY_EDITORS`) can reconfigure your reverse proxy, which is as
  powerful as it sounds — treat those accounts accordingly.
- Changes to Caddy's configuration are logged (`Caddy configuration applied`,
  with the user) and kept in history with the full text of every version.

Set `COOKIE_SECURE=false` only for plain-HTTP local testing — with it false over
HTTP the session cookie is not marked `Secure`.

## 8. Configuration reference

Every setting is documented inline in `.env.example`. The ones you are most
likely to change:

| Variable | Default | Meaning |
|---|---|---|
| `APP_PORT` / `BIND_ADDRESS` | `8899` / `0.0.0.0` | where the UI is published |
| `CADDY_CONF_PATH` | `./caddy/conf` | directory holding the Caddyfile |
| `CADDY_LOG_HOST_PATH` | `./caddy/logs` | Caddy's log directory (read-only to the app) |
| `CADDY_DATA_PATH` / `CADDY_STATE_PATH` / `CADDY_RUN_PATH` | `./caddy/{data,config,run}` | Caddy's certificates, state, admin socket |
| `CADDY_IMAGE` | `caddy:2` | Caddy image; use your own build for plugins |
| `CADDY_EDITORS` | — (everyone) | users allowed to change Caddy's config |
| `CADDY_MANAGE` | `true` | show the Caddy configuration pages |
| `CADDY_LOG_GLOB` | `*.log` | which files to follow |
| `AUTH_USERS` | — | `user:password` or `user:scrypt$…`, comma-separated |
| `RETENTION_DAYS` | `365` | how long statistics are kept |
| `HOURLY_RETENTION_DAYS` | `45` | how long hour-level detail is kept |
| `RAW_RETENTION_HOURS` | `48` | how long individual requests are kept |
| `IGNORE_HOSTS` / `IGNORE_CIDRS` | — | traffic never recorded (healthchecks, monitoring) |
| `STREAM_POLL_MS` | `400` | live-tail latency |
| `INGEST_BACKFILL` | `true` | read existing logs from the start on first run |

## 9. Operating

```bash
docker compose logs -f ingest        # what the tailer is doing
docker compose logs -f web
docker compose logs -f caddy         # Caddy itself: certificates, config loads
docker compose restart ingest        # safe: checkpoints are durable
docker compose down                  # your data directory is untouched
```

Because storage is a bind mount, `docker compose down -v` does **not** delete
your statistics — the only way to lose them is to remove `DATA_PATH` yourself.

### Backup

The database is a file you can see, so take a consistent copy with SQLite's own
backup (safe to run while the stack is live — do not just `cp` a WAL database):

```bash
docker compose exec web \
  node -e "require('better-sqlite3')('/data/stats.db').backup('/data/backup.db')"
mv ./data/backup.db ./stats-$(date +%F).db
```

Restoring is putting `stats.db` back in `DATA_PATH` with the stack stopped.

### Sizing

At the 1–20M requests/day this is tuned for, expect roughly:

- `events`: ~400 bytes/request × 48 hours of traffic
- `dims`: dominated by distinct URLs and IPs per hour, then bounded by
  `DIM_TOP_N` once compaction kicks in

If the disk grows faster than you like, reduce `RAW_RETENTION_HOURS` first — it
is by far the largest tier, and it does not affect long-term statistics.

### Migrating off the old named volume

Earlier revisions of this stack kept the database in a Docker named volume. To
move existing statistics into the bind mount:

```bash
docker compose down
mkdir -p ./data
docker run --rm \
  -v caddy-log-interface_data:/from \
  -v "$PWD/data":/to \
  alpine sh -c 'cp -a /from/. /to/'
sudo chown -R "$(id -u):$(id -g)" ./data
docker compose up -d --build
```

Confirm `./data/stats.db` is there and the Health page still shows your history,
then reclaim the old volume with
`docker volume rm caddy-log-interface_data`.

## 10. Development

```bash
cd app && npm install && cd ui && npm install
# terminal 1 — API + ingest against a local log directory
LOG_DIR=/path/to/logs DB_PATH=./data/stats.db APP_MODE=all \
  SESSION_SECRET=$(openssl rand -hex 32) AUTH_USERS=dev:devpassword123 \
  COOKIE_SECURE=false node src/index.js
# terminal 2 — UI with hot reload, proxying /api to the above
cd app/ui && npm run dev
```

## 11. Known limits

- Latency percentiles are computed from a fixed histogram, so they are accurate
  to the bucket edge, not exact. The bucket labels are shown alongside.
- Unique-client counts are distinct source IPs within the selected window,
  which is exact until dimension compaction trims older buckets.
- The live stream shows the newest requests. If Caddy logs faster than the tail
  can carry (over ~750 req/s at the default poll interval), the view skips
  ahead and tells you how many entries it passed over; aggregates remain
  complete.
- ASNs resolved after a request was already aggregated are applied from the
  next request by that address onward; the rollup pass repairs rows that were
  still pending when it ran.
