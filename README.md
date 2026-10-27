# Caddy Log Interface

A self-hosted dashboard and control panel for Caddy, shipped as a single
container that runs alongside Caddy. It reads Caddy's JSON access logs
read-only and keeps its own statistics (so history survives log rotation and
deletion), and it edits Caddy's configuration, reloading Caddy for you. The
included compose file runs Caddy and the interface together.

- **Caddy configuration** — add, remove, enable and disable sites; change
  domains, upstreams, IP allowlists, TLS, compression, snippets and global
  options from forms; edit any directive at any depth in a tree editor; or edit
  the raw Caddyfile. Every change is shown as a diff, validated by Caddy, and
  applied with a zero-downtime reload. Past versions can be restored.
- **Dashboard** — hits, 2xx vs non-2xx, top talkers, top URLs, bandwidth,
  latency percentiles, country map, top networks, browsers, referrers.
- **Traffic** — visitor analytics from the access log alone, with no tracking
  script: visitors, visits, page views (browsers loading a page, not assets or
  API calls), bounce rate, visit duration, pages per visit and who is active
  now; channels (search, social, AI assistants, email, paid, referral,
  direct), entry, exit and top pages, referring sites, UTM campaigns and ad
  click IDs, visitor languages, and broken links people followed to a 404.
  Per domain or across all of them.
- **Domains** — every host that received a request Caddy actually served, with
  counters; click through for user agents, source countries and ASNs, a world
  heatmap, protocol/TLS breakdown, slowest and most error-prone URLs.
- **Clients** — every source address with traffic in the period, sortable by
  requests, share, bytes sent, errors, response time, country, network and
  first or last seen, for all domains or one.
- **Drill-down** — every value in the app is clickable. A source IP, user
  agent, URL, country, ASN, TLS cipher or latency bucket all resolve to the
  individual requests behind them, and source addresses get their own page with
  enrichment and behaviour.
- **Requests** — the live log stream and the request search in one page. It
  streams new requests as they arrive, with the latest stored ones above and
  older ones a click away, pause, and per-request JSON pretty-print. Filters —
  any field, or free text — apply to the stream too; a time range searches
  the stored requests in that period instead, and Reset goes back to live.
- **Health** — what the ingester is reading and whether IP enrichment is
  working.
- **Settings** — how long individual requests are kept, and a size limit for
  the database.

Image: [`victimofareload/caddylogs`](https://hub.docker.com/r/victimofareload/caddylogs)
(linux/amd64 and linux/arm64) · License: [MIT](LICENSE) ·
Security reports: see [SECURITY.md](SECURITY.md)

> **Outbound lookups — on by default, one setting to turn off.** To show which
> network each visitor belongs to (BGP prefix, AS number and name, registry,
> WHOIS), the app sends each **public visitor IP address** to the free
> [notoolkit](https://api.notoolkit.com/) API (`api.notoolkit.com`) — once per address, then cached
> locally — along with AS numbers for registry detail. No URLs, user agents,
> hostnames or other log content are sent, and private, loopback and
> link-local addresses never are. Set `NOTOOLKIT_ENABLED=false` in `.env` to
> make no outbound calls at all; visitor countries still work offline from
> MaxMind. Details in [§6](#6-ip-enrichment).

---

## 1. Requirements

- Docker with the Compose plugin
- Nothing else listening on ports 80/443 — the stack runs Caddy (2.8 or newer)
- A MaxMind GeoLite2 country database for visitor-country data (free, see below)
- Outbound HTTPS to api.notoolkit.com for BGP prefix / ASN data (no key required;
  optional — see above)

## 2. Install

```bash
git clone https://github.com/nickolsen8390/caddylogs.git && cd caddylogs
cp .env.example .env
```

Edit `.env`. The one setting you must change:

```bash
# who may log in
AUTH_USERS=admin:<a long, unique password>
```

### Create the directories

All storage is bind-mounted — there are no named volumes. Docker manages
ownership for named volumes but **not** for bind mounts, so the directories the
interface writes to have to be owned by the user the app container runs as —
`PUID:PGID` in `.env`, `1000:1000` by default:

```bash
mkdir -p ./data ./caddy/conf ./caddy/run ./caddy/logs ./caddy/data ./caddy/config
cp Caddyfile.example ./caddy/conf/Caddyfile       # then edit the host name and allowed addresses
sudo chown -R 1000:1000 ./data ./caddy/conf ./caddy/run
sudo chmod 700 ./caddy/run
```

UID 1000 does not need to exist as an account on the host; it only has to own
those directories. Do **not** set `PUID=0`: running the app as root inside the
container throws away a layer of protection, and nothing needs it. To use a
different ID, set `PUID`/`PGID` in `.env` and `chown` to the same values.

If `./data` is wrong, the container exits immediately with a message naming
the exact `chown` to run — it will not start half-working. If `./caddy/conf`
is wrong, the Caddy pages say the Caddyfile is read-only; if `./caddy/run` is
wrong, they say Caddy's admin API is not reachable (permission denied).

| Directory | Written by | Read by |
|---|---|---|
| `./data` | app | app |
| `./caddy/conf` (the Caddyfile) | app, on apply | caddy, app |
| `./caddy/run` (admin socket) | caddy | app |
| `./caddy/logs` | caddy | app (read-only) |
| `./caddy/data`, `./caddy/config` (certificates) | caddy | caddy only |

`./caddy/run` holds Caddy's admin socket. Its `0700` mode, owned by `PUID`, is
what keeps other host users from reconfiguring Caddy through it.

Keep `DATA_PATH` on a **local** filesystem. SQLite's WAL mode is not safe over
NFS or CIFS.

Then:

```bash
docker compose up -d
```

This pulls the published image, `victimofareload/caddylogs`.

The UI is on `http://<host>:8899` (`APP_PORT`), published on all interfaces per
`BIND_ADDRESS`. Put it behind Caddy for TLS — see `Caddyfile.example`.

### Keeping the password out of .env

`AUTH_USERS` accepts a pre-computed hash instead of a plaintext password:

```bash
docker compose run --rm --no-deps app node src/tools/hash.js
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
sudo chown -R 1000:1000 <dir>/conf <dir>/run && sudo chmod 700 <dir>/run
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
(`docker compose -f <old compose file> down`) and `docker compose up -d` here.

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
policy picks the fixed file up on its next attempt. The app container does
not depend on the caddy container, so it keeps running when Caddy is down —
but if you normally reach the interface *through* Caddy, it is then only
reachable directly on port 8899 over plain HTTP, where `COOKIE_SECURE=true`
refuses sign-in. In that case fix `caddy/conf/Caddyfile` by hand (Caddy's
error names the line: `docker compose logs caddy`) and
`docker compose restart caddy`.

`CADDY_EDITORS` limits who may apply changes (everyone else can still view).
`CADDY_MANAGE=false` switches configuration management off: the Caddy menu
and pages disappear from the interface, and the configuration API refuses
every request. Caddy itself keeps running from its Caddyfile. It defaults to
`true`; recreate the app container after changing it
(`docker compose up -d app`).

Limits: `import` of other *files* (as opposed to snippets) is shown and kept,
but those files are not editable here, and relative import paths resolve inside
the Caddy container, so use absolute ones. Environment placeholders
(`{$VAR}`) are kept verbatim.

## 4. Verify it is reading your logs

Before wondering why the dashboard is empty:

```bash
docker compose run --rm --no-deps app node src/tools/inspect.js
```

This parses a sample of real lines and reports how many became requests, which
hosts it saw, and which fields your logs are missing. It writes nothing.

There is also a self-test for the pure logic that is easy to get subtly wrong —
CIDR matching, IP normalisation, log-field extraction. No database, no network,
no log files:

```bash
docker compose run --rm --no-deps app node src/tools/selftest.js
```

Worth running after changing `TRUSTED_PROXIES` or `IGNORE_CIDRS`, since those
are silent when wrong.

## 5. How the data is stored

Everything lives in one SQLite file on the `data` volume, in three tiers:

| Tier | Contents | Governed by |
|---|---|---|
| `events` | individual requests | Settings page: a time (48h by default), or until the size limit |
| `events_raw` | each request's original JSON line, compressed | the same as `events` |
| `visits` | visits that may still grow (working state for the Traffic page) | a day after a visit's last page view |
| `visitor_seen` | which visitor ids had a page view in each hour, for exact visitor counts | `HOURLY_RETENTION_DAYS` (45d) |
| `rollup` / `dims` at hourly granularity | every counter and dimension | `HOURLY_RETENTION_DAYS` (45d) |
| the same tables at daily granularity | folded from hourly | `RETENTION_DAYS` (365d) |

Requests are aggregated into the hourly tier within seconds of being logged, so
**deleting or rotating a Caddy log never loses statistics** — only the ability
to inspect those individual requests in the log stream.

Hourly rows are folded into daily rows once they pass the hourly window, and
the hourly rows are then deleted, so a period exists at exactly one granularity
and totals can never double-count. A range that does not start or end on the
hour (the last hour, the last 24 hours) takes its whole hours from the hourly
tier and the part-hours at either end from the stored requests, so its totals
are exact. Further back than the stored requests reach, the part-hour at the
start of a range is left out and the one at its end counted whole. High-cardinality dimensions (URLs, IPs, user
agents, referrers) are trimmed to the top `DIM_TOP_N` values per bucket after
`DIM_COMPACT_AFTER_DAYS`, with the remainder folded into a single `(other)` row
so totals stay exact while storage stays bounded. The most-errored values are
kept as well, so error lists stay complete.

A dimension that explodes — more than `DIM_HOURLY_MAX` (2000) values in one
hour, typically an API where every lookup is a URL never seen before — is
trimmed as soon as that hour is over (`DIM_COMPACT_AFTER_HOURS`) rather than
after a week; otherwise every list on every page would read through millions
of rows. Ordinary sites never reach that, and keep every value for the week.
The trimmed URLs are still in the stored requests, for as long as those are kept.

Maintenance runs hourly inside the `ingest` container, with the early trim
every 10 minutes and the size limit every minute. Nothing external to schedule.

### Shrinking the database file

SQLite reuses the space of deleted rows but does not return it to the disk.
Upgrading to 1.2.3 frees most of a busy server's database — requests stop
carrying their uncompressed log line — but only as the old requests age out,
and the file keeps its size. Once the old requests have aged out, it can be
rewritten without the unused space:

```bash
docker compose stop app
```
```bash
docker compose run --rm --no-deps app node src/tools/vacuum.js --yes
```
```bash
docker compose start app
```

It needs free disk space of about the size the file shrinks to, and takes a
few minutes for a multi-gigabyte file. Skipping it costs only disk space.

To see where the time goes on a slow installation, run
`docker compose exec app node src/tools/perf.js`: it reports what the file
holds and times every query behind the main pages, without changing anything.

### How the Traffic page counts page views

A request is a page view when a browser navigated to it and got the page: a
`GET` with `Sec-Fetch-Dest: document` (or, from browsers too old to send that,
one asking for HTML and getting it back), answered 2xx or 304, from a client
that is not a bot, and not a prefetch.

**Visitors** are told apart by a hash of the site, the client address, the
User-Agent and a random salt that changes every UTC day — the method
Plausible uses. The same person on two days counts as two visitors, so
"visitors" over a week is the sum of each day's visitors; and two people
behind one address with the same browser count as one. Each day's salt is
deleted once no stored request still needs it, after which that day's
visitor ids can no longer be recomputed from an address. (The addresses
themselves are still kept for the dashboard's per-address statistics.)

A **visit** is one visitor's page views with no gap longer than 30 minutes; it
also ends at midnight UTC, when the visitor id changes. A visit of one page is
a bounce, and its duration is the time from its first page view to its last —
so a bounce counts as zero seconds, as in other analytics tools. Visits are
counted the moment they start, in the hour they started, and corrected as they
grow, so the numbers are live. The exit page is the exception: it is counted
once a visit has been quiet for 30 minutes, since until then it is not known.

Channels, referrers, campaigns, languages, entry and exit pages count
**visits**, credited to the page each visit started on: a visit from a search
engine that goes on to read five pages is one Search visit. Top pages and
broken links count page views.

UTM tags come from the landing URL's query string. `source` and `ref` stand in
for `utm_source`, and ad click IDs (`gclid`, `msclkid`, `fbclid`, `ttclid`, …)
for untagged ad links. A visit that starts from another page of the same site
(after 30 idle minutes, say) is in the **Internal** channel; your own site
never appears as a referrer. "The same site" includes its other subdomains:
a link from docs.example.com to app.example.com is internal.

What a server log cannot see: route changes inside a single-page app after
its first load, pages served from a CDN cache without reaching Caddy, and
screen sizes.

All of this starts counting when you upgrade to 1.2.0. Requests still stored
from before the upgrade (`RAW_RETENTION_HOURS`) are counted too, in the
background, in the first minutes after it starts.

### What drill-down can and cannot reach

Clicking a value opens the **Requests** page (`/requests`) as a search for it,
over the period the page you came from was showing. That reads `events`, so
it only reaches back as far as individual requests are kept — the UI says so
on every such view rather than showing an empty list that reads as "this
never happened".

Aggregates have no such limit: the counts on the dashboard and domain pages
cover the full `RETENTION_DAYS`. The split is deliberate — keeping every
individual request for a year would be enormous, while the counters are small.
If you routinely need to inspect requests further back, keep them longer on
the Settings page; they are the largest tier on disk, so do it knowingly.

A search of a rare value stops at a time budget on each round trip, so the
page searches further back on its own — up to a dozen rounds — before
offering a button to keep going. Searching a time range starts at that range,
so finding requests from an hour last week does not mean walking back to it.

### Retention and the size limit

On the **Settings** page (editable by `CADDY_EDITORS`, or everyone when that
is empty):

- **Stored requests** are kept for a time you choose, in hours or days — or
  until the database reaches its size limit, which keeps as much history as
  the space allows.
- **Size limit**: when the database reaches it, the oldest stored requests
  are deleted first, whatever the retention says — then, only if those are
  down to their last hour, the oldest days of statistics. It applies to the
  data held: SQLite reuses freed space rather than shrinking the file, so the
  file settles at about the limit. Beside it, `stats.db-wal` (the write-ahead
  log) is kept under about 64 MB. Requests not yet counted into the
  statistics wait until they are, so a backlog there can hold the database
  over the limit for a while; the log says so.

The size limit is checked every minute; a change to the retention applies
within about ten minutes. Neither needs a restart. `.env` gives the
starting values (`RAW_RETENTION_HOURS`, `MAX_DB_SIZE`) — set them before the
first start if you want more history from the start, as the first start
reads the existing log files from the beginning.

**Restoring after raising the retention.** Requests deleted under a shorter
retention are usually still in Caddy's log files. "Restore from log files" on
the Settings page reads them again and puts back the requests older than the
oldest one stored, as far back as the new retention allows and stopping short
of the size limit. It runs in the background. Their statistics were counted
when they first arrived, so nothing is counted twice; only files matching
`CADDY_LOG_GLOB` that are still on disk can be read (compressed, rotated
files are not).

A large database is a slower one: searching requests and the address pages
read more data as it grows, and once the database is much larger than the
memory the server can spare for its file cache, most reads come from disk.
A few gigabytes keeps the interface quick for most sites.

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

A file's read position is saved in the same transaction as the requests read
up to it, so a crash, `docker kill` or power cut neither loses requests nor
stores any twice: reading resumes just after the last request stored.

## 6. IP enrichment

### What is sent, and how to turn it off

notoolkit lookups, to `api.notoolkit.com`, are **on by default** and are the
only outbound connections the app makes. They send:

- each **public** visitor IP address, once — the answer is cached in the local
  database for `ENRICH_TTL_DAYS` (30 by default) before it is asked again;
- each AS number seen, once, for registry detail (refreshed every
  `ENRICH_ASN_TTL_DAYS`, 90 by default).

Nothing else leaves the server: no URLs, paths, query strings, user agents,
referrers, hostnames or timestamps. Private, loopback and link-local addresses
(10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, 169.254/16, ::1, fc00::/7,
fe80::/10) are never sent.

**To disable it**, set in `.env` and recreate the container:

```bash
NOTOOLKIT_ENABLED=false
```

```bash
docker compose up -d app
```

With it off the app makes no outbound connections at all. Visitor countries
still work (MaxMind is local), and with `GeoLite2-ASN.mmdb` present the AS
number and organisation still resolve locally; you lose BGP prefix, registry
and WHOIS detail. Anything already cached is kept.

### Sources

| Source | Provides | Failure behaviour |
|---|---|---|
| MaxMind GeoLite2 | **visitor country** (and ASN if the ASN db is present) | local, always available |
| notoolkit `v1/ip/{address}` | BGP prefix, originating ASN, AS name/org | retried with backoff; **an error banner appears on the dashboard and Health page** |
| notoolkit `v1/asn/{number}` | RIR, registrant country, description, WHOIS, prefix counts | one lookup per distinct ASN, filled in the background |

**Two different countries.** MaxMind answers "where is this visitor" — that is
what the world map and country breakdowns use. notoolkit's `country` is where
the *autonomous system* is registered, which is a different thing (a
US-registered CDN serves traffic from everywhere). It is shown separately, in
the ASN table, labelled "Registered".

Per-IP results are cached in SQLite for `ENRICH_TTL_DAYS`. Ingest waits at most
`ENRICH_INLINE_TIMEOUT_MS` for a new IP; anything slower is written with what is
known locally, queued, and resolved in the background, so the cache is warm for
that address from then on. Private-range addresses are never sent anywhere.

Addresses in the same IPv4 /24 or IPv6 /48 share one lookup. No route more
specific than that is carried on the internet, so every address in such a
block has the same prefix and AS; the answer is shared only when the prefix it
names covers the whole block. This matters most for IPv6, where a client may
use a new address for almost every connection: a burst of one-time addresses
from a few networks costs a few lookups, not one each.

Some networks — proxy services above all — hand out addresses at random
across a whole route, such as a /29 with half a million /48s in it, so the
routes the answers name are remembered too, and an address inside one is
answered without a lookup. A route can hold a more specific one belonging to
another network, which only a lookup inside it reveals, so a route is shared
only once three lookups inside it have named it, every 100th address it
would answer is looked up instead, and so is any address the MaxMind ASN
database (when installed) places in another network. Finding a more specific
route has the wider one confirmed again; it answers for its own addresses
from then on. In a test with 20,000 random addresses across two /29s, one
hiding another network's /48, this took 304 lookups where the /48 sharing
alone needed 16,000, with every answer right.

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
| `410` retired endpoint | a configuration problem: `NOTOOLKIT_API_URL` points at the pre-v1 API. Addresses stay queued and the banner names the URL to use. The old `https://notoolkit.com/` setting is translated to v1 automatically, so this only appears for other stale URLs. |
| `503`, other 5xx, timeout, network error | transient. Retried with exponential backoff (1m → 1h, `NOTOOLKIT_MAX_RETRIES` attempts), provider marked unhealthy, banner shown. |

Requests are rate-limited client-side to `NOTOOLKIT_RATE_PER_SEC` (default 10)
with a token bucket, on top of notoolkit's own 24-hour Redis cache. The
background queue keeps `NOTOOLKIT_CONCURRENCY` lookups (default 4) in flight
at all times while it has a backlog, so those two settings set its pace:
concurrency needs to be at least the rate times the API's response time in
seconds (100 per second at 0.2 s needs 20). Lookups for requests being
stored now go ahead of the queue. While there is a backlog, the log has an
`enrichment progress` line a minute, with addresses resolved and lookups
made per second, and how many were left in the queue.

The whole wire format lives in one file, `app/src/enrich/notoolkit.js`. The
public API needs no authentication; `NOTOOLKIT_API_KEY` / `NOTOOLKIT_AUTH_HEADER`
exist only so a key could be added later without a code change.

### When the API is on the same server

If this stack monitors the very Caddy instance that serves api.notoolkit.com, the
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
NOTOOLKIT_API_URL=http://10.0.0.5/v1/     # whatever your reverse_proxy targets, plus /v1/
NOTOOLKIT_HOST_HEADER=api.notoolkit.com   # so vhost routing still resolves
```

Plain HTTP is appropriate here: it stays on the local network, and the payload
is public routing data, not credentials. Do not use `https://` with an address
— the certificate will not match the IP and TLS will fail.

Verify from inside the container:

```bash
docker compose run --rm --no-deps app node src/tools/probe.js
```

The probe reports DNS, TCP and HTTP separately with timings, and names the
likely cause when a stage fails. It writes nothing.

## 7. Security

The interface is built on the assumption it may be internet-facing.

- Session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`; the session id is
  32 random bytes stored **hashed**, so a stolen database file does not yield
  live sessions. Sessions are looked up server-side, so there is no signing
  secret to configure or leak. (Older versions required `SESSION_SECRET`; it
  is now ignored and can be deleted from `.env`.)
- Sessions end after `SESSION_IDLE_MINUTES` without use, or `SESSION_TTL_HOURS`
  after sign-in. Ticking **Keep me signed in** exempts that session from the
  idle timeout and makes it last `SESSION_REMEMBER_DAYS` (default 30) instead;
  set it to `0` to remove the option. Signing out ends the session at once
  either way.
- Passwords are verified with scrypt and a constant-time comparison. Unknown
  usernames cost the same as known ones, so accounts cannot be enumerated.
- Failed logins are throttled per source IP (`LOGIN_MAX_ATTEMPTS` per
  `LOGIN_WINDOW_MINUTES`), plus a global API rate limit.
- CSRF: every state-changing request needs the token issued with the session.
- `X-Forwarded-For` is honoured **only** from `TRUSTED_PROXIES`, so a client
  cannot spoof its address to dodge the login throttle.
- Strict CSP (`default-src 'none'`, no inline scripts, no CDNs — the whole UI
  including the world map is bundled), HSTS, `nosniff`, `frame-ancestors none`
  (or the portals in `EMBED_ORIGINS`, below),
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

### Embedding in a portal

By default no page may show the interface in a frame (`frame-ancestors
'none'`, `X-Frame-Options: DENY`). To show it in a portal, list the portal's
origins in `EMBED_ORIGINS` — `scheme://host[:port]`, no path, comma-separated:

```bash
EMBED_ORIGINS=https://homecontrol.example.com,http://10.0.0.20
```

Entries are normalised (lowercase, no trailing slash, no default port), and
anything that is not an origin is ignored with a warning in the log. Pages
are then sent `frame-ancestors 'self' <origins>` and no `X-Frame-Options`
(which cannot express an allow list); API responses keep `DENY`.

**Cookies.** A portal on the same site — `homecontrol.example.com` framing
`stats.example.com`, both https — works with the usual `SameSite=Strict`
cookie. A portal on another site, such as one opened by IP address, needs the
interface served over **HTTPS**: with `EMBED_ORIGINS` set, sessions started
over HTTPS get a `SameSite=None; Secure; Partitioned` cookie, which browsers
send into a frame from another site (partitioned, it is kept per portal, and
still works where third-party cookies are blocked). Over plain HTTP no cookie
can cross sites; signing in then reports why instead of failing silently.
Relaxing SameSite does not weaken CSRF protection, which rests on the token
issued with the session.

**Sign-in by the portal.** In a frame, and only with `EMBED_ORIGINS` set, the
interface talks to its parent with `postMessage`, posting each message once
for every allowed origin (the browser delivers the one that matches):

| Direction | Message |
|---|---|
| to the portal | `{ source: "caddylogs", type: "login-required" }` — the Sign in screen is showing, including after a session expires |
| to the portal | `{ source: "caddylogs", type: "logged-in", user }` — after a successful sign-in |
| to the portal | `{ source: "caddylogs", type: "login-failed", status, message }` — after a failed sign-in the portal started; `message` is for a person |
| to the portal | `{ source: "caddylogs", type: "navigated", path }` — on load and every page change (path and query) |
| from the portal | `{ source: "embedder", type: "login", username, password }` |

The portal's `login` is accepted only from the parent window, from an allowed
origin, while the Sign in screen is showing; it signs in as if typed, without
"keep me signed in". In a frame, a sign-in counts as successful only once the
session cookie is seen to come back — otherwise `login-failed` says why
(status 200 in that case: the password was right). The password is never
logged.

### Installing as an app

Served over HTTPS, the interface can be installed as an app (a PWA): in
Chrome or Edge with the install icon in the address bar, on Android from the
browser menu, on iOS with Share → Add to Home Screen. It opens in its own
window, with shortcuts to Requests, Traffic and Clients. Browsers allow this
only over HTTPS (or on `localhost`); over plain HTTP the interface works as
before and is simply not installable.

Its service worker keeps only the UI's own files, so the app opens quickly,
and shows an offline page when the server cannot be reached. It never stores
API responses: statistics, requests and sessions always come from the
server, and signing out means what it always has. A new release replaces the
service worker on the next load. On iOS an installed app keeps its own
cookies, so it asks you to sign in once, separately from Safari.

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
| `CADDY_EDITORS` | — (everyone) | users allowed to change Caddy's config and the Settings page |
| `CADDY_MANAGE` | `true` | `false` hides the Caddy menu and turns the configuration API off |
| `CADDY_LOG_GLOB` | `*.log` | which files to follow |
| `AUTH_USERS` | — | `user:password` or `user:scrypt$…`, comma-separated |
| `SESSION_REMEMBER_DAYS` | `30` | lifetime of a "keep me signed in" session, which has no idle timeout; `0` removes the option |
| `RETENTION_DAYS` | `365` | how long statistics are kept |
| `HOURLY_RETENTION_DAYS` | `45` | how long hour-level detail is kept |
| `RAW_RETENTION_HOURS` | `48` | how long individual requests are kept, to start with (0 = until the size limit); then the Settings page |
| `MAX_DB_SIZE` | — (no limit) | largest the database may grow, e.g. `10GB`, to start with; then the Settings page |
| `DIM_HOURLY_MAX` | `2000` | values one dimension may gather in an hour before it is trimmed right away (see §5) |
| `IGNORE_HOSTS` / `IGNORE_CIDRS` | — | traffic never recorded (healthchecks, monitoring) |
| `EMBED_ORIGINS` | — (no framing) | origins allowed to show the interface in a frame, and to sign in for it (see §7) |
| `BOT_HEADER_CHECK` | `true` | count a "Chrome" that sends no Sec-Fetch / client-hint headers as a bot |
| `STREAM_POLL_MS` | `400` | live-tail latency |
| `INGEST_BACKFILL` | `true` | read existing logs from the start on first run |

## 9. Operating

```bash
docker compose logs -f app           # the interface: web requests and the tailer
docker compose logs -f caddy         # Caddy itself: certificates, config loads
docker compose restart app           # safe: read positions are durable
docker compose down                  # your data directory is untouched
```

The app container runs two processes: the web UI/API, and the log ingester as
its child. Their log lines are told apart by the `scope` field (`web`, `api`,
`caddy` for the former; `ingest`, `tail`, `enrich` for the latter). If the
ingester dies it is restarted automatically, backing off up to a minute
between attempts, while the web UI stays up. The container's health check
reports the web UI.

`APP_MODE` can split them again if you ever need to: `web` runs only the UI
and API, `ingest` only the ingester — run two containers from the same image
against the same `DATA_PATH`. The default, `all`, runs both.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The default image tag, `:1`, follows every 1.x release — new features and
fixes, never a breaking change. Releases are listed in
[CHANGELOG.md](CHANGELOG.md).

### Upgrading from separate web and ingest containers

Earlier versions ran the interface as two containers, `cli-web` and
`cli-ingest`. The compose service is now called `app`, so remove the old
containers while starting the new one:

```bash
docker compose up -d --remove-orphans
```

Nothing else changes: the same `.env`, database and mounts are used, and the
ingester resumes where the old container stopped.

Because storage is a bind mount, `docker compose down -v` does **not** delete
your statistics — the only way to lose them is to remove `DATA_PATH` yourself.

### Backup

The database is a file you can see, so take a consistent copy with SQLite's own
backup (safe to run while the stack is live — do not just `cp` a WAL database):

```bash
docker compose exec app \
  node -e "require('better-sqlite3')('/data/stats.db').backup('/data/backup.db')"
mv ./data/backup.db ./stats-$(date +%F).db
```

Restoring is putting `stats.db` back in `DATA_PATH` with the stack stopped.

### Sizing

At the 1–20M requests/day this is tuned for, expect roughly:

- `events`: ~400 bytes/request × 48 hours of traffic
- `dims`: dominated by distinct URLs and IPs per hour, then bounded by
  `DIM_TOP_N` once compaction kicks in

If the disk grows faster than you like, set a size limit on the Settings page,
or keep stored requests for less time — they are by far the largest tier, and
neither affects long-term statistics until the limit is very small.

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
sudo chown -R 1000:1000 ./data
docker compose up -d
```

Confirm `./data/stats.db` is there and the Health page still shows your history,
then reclaim the old volume with
`docker volume rm caddy-log-interface_data`.

## 10. The container image

Everything the interface needs is in one image,
[`victimofareload/caddylogs`](https://hub.docker.com/r/victimofareload/caddylogs),
built from `app/Dockerfile` for linux/amd64 and linux/arm64. It works with
plain `docker run` as well as compose: the paths it expects are built in, it
has a health check, and it runs as a non-root user.

| Tag | Follows |
|---|---|
| `1.0.0` | exactly that release — never changes |
| `1.0` | the latest 1.0.x (fixes only) |
| `1` | the latest 1.x (what the compose file uses) |
| `latest` | the newest release, including a future 2.0 with breaking changes |

| Mount at | Contents | Access |
|---|---|---|
| `/data` | SQLite database | read-write, owned by the container user |
| `/logs` | Caddy's JSON access logs | read-only |
| `/geoip` | GeoLite2 `.mmdb` files (optional) | read-only |
| `/caddy` | the directory holding the `Caddyfile` (optional; for config management) | read-write |
| `/run/caddy` | Caddy's admin socket (optional; for config management) | read-write |

The only required setting is `AUTH_USERS`; everything else has a default (see
`.env.example`). Without `/caddy` and `/run/caddy`, set
`CADDY_MANAGE=false` and the image is a pure log dashboard.

```bash
docker run -d --name caddy-log-interface --user 1000:1000 \
  -p 8899:8899 --read-only --tmpfs /tmp \
  -e AUTH_USERS='admin:...' -e CADDY_MANAGE=false \
  -v "$PWD/data:/data" -v /var/log/caddy:/logs:ro \
  victimofareload/caddylogs:1
```

### How releases are made

Images are built by GitHub Actions (`.github/workflows/docker.yml`), not by
hand. Every push to `main` and every pull request builds the image as a check.
Pushing a version tag publishes it:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow builds for amd64 and arm64, pushes `1.0.1`, `1.0`, `1` and
`latest` to Docker Hub with provenance and SBOM attestations, and refreshes the
Docker Hub description from `DOCKERHUB.md`. Before tagging, bump `version` in
`app/package.json` and add the release to `CHANGELOG.md`. The changelog is
built into the image: the Health page shows the running version with its
release notes, and the earlier releases below them.

To run a locally built image instead, build it and point `APP_IMAGE` at it:

```bash
docker build -t caddylogs:local -f app/Dockerfile .
```

Then set `APP_IMAGE=caddylogs:local` in `.env` and run `docker compose up -d`.

## 11. Development

```bash
cd app && npm install && cd ui && npm install
# terminal 1 — API + ingest against a local log directory
LOG_DIR=/path/to/logs DB_PATH=./data/stats.db APP_MODE=all \
  AUTH_USERS=dev:devpassword123 \
  COOKIE_SECURE=false node src/index.js
# terminal 2 — UI with hot reload, proxying /api to the above
cd app/ui && npm run dev
```

Pull requests are welcome. Please keep changes focused, describe how you
tested them, and run the self-test (`node src/tools/selftest.js` in `app/`).

## 12. Known limits

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

## License

[MIT](LICENSE) © 2026 Nick Olsen. The container image also includes a Debian
base system, the Node.js runtime and npm dependencies, each under its own
license; each release's SBOM on Docker Hub lists them.
