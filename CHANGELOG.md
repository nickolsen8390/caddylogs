# Changelog

All notable changes are listed here. Versions follow
[semantic versioning](https://semver.org): a new major version (2.0.0) is the
only kind that can require you to change anything when upgrading.

## [1.7.0] — 2026-10-26

### Added

- Dashboard: **Requests per second**, the mean over the selected range with
  the busiest minute, hour or day beside it. The mean covers only the time
  there is data for, so a new install is not averaged against hours it was
  not running.

### Changed

- IP enrichment is much faster through a backlog. The background queue took
  50 addresses every 5 seconds, so it never resolved more than 10 a second,
  whatever `NOTOOLKIT_RATE_PER_SEC` and `NOTOOLKIT_CONCURRENCY` allowed. It
  now keeps `NOTOOLKIT_CONCURRENCY` lookups in flight for as long as there
  is a backlog, so the rate limit sets the pace (in a test at 100 per
  second: 10 addresses a second before, 200 now).
  - Addresses in the same IPv4 /24 or IPv6 /48 share one lookup, since no
    more specific route is carried on the internet; an answer is shared only
    when the prefix it names covers the whole block. A burst of one-time
    IPv6 addresses from a few networks now costs a few lookups, not one each.
  - Lookups for requests being stored now go ahead of the queue, so a
    backlog does not push them past their time budget.
  - While there is a backlog, the log has an `enrichment progress` line a
    minute: addresses resolved and lookups made per second, and what is
    left in the queue.

### Fixed

- Totals for a range that does not start on the hour were off by up to an
  hour's traffic. They added whole hours from the first one starting inside
  the range, so "last hour" at 18:20 counted only since 18:00 — in a test,
  2,041 of 3,137 requests — "last 24 hours" missed up to an hour, and a
  range inside one hour could count that whole hour. Every headline number
  was affected (requests, errors, bandwidth, clients, visitors, visits,
  bounces, domains), on the Dashboard, Traffic and domain pages, and so
  were the changes from the previous period. The whole hours still come
  from the hourly totals; the part-hours at either end now come from the
  stored requests, which also counts the last few seconds not yet rolled up.
  Visits in a part-hour are counted from the visits themselves for about a
  day, then estimated from that hour's count. Older than the stored
  requests, ranges are rounded to the hour as before.
- Requests: coming back to the live view on a phone could leave it showing
  "Reconnecting…" for good. The browser's own retry gives up once a
  reconnect is refused (a session that ended meanwhile, a rate limit), and a
  phone that sleeps or changes network can leave the stream silently dead.
  The page now keeps the stream open itself:
  - a stream that closes, or goes quiet for 30 seconds, is reopened, with
    waits growing from 1 to 30 seconds; returning to the page or coming back
    online reopens it at once, and the banner has a "Reconnect now" button;
  - the requests that arrived while it was down are filled in, in order.
    After more than 200, the view starts again from the newest, with older
    ones a click away; while paused, they wait behind Resume;
  - when the session has ended, the Sign in screen shows instead.
- The server sends the live view an event at least every 10 seconds, so a
  quiet stream can be told from a dead one, and drops a stream whose reader
  has stopped reading (over 1 MB unsent) instead of holding one of its 32
  places until the operating system gives up on the connection.
- Requests could be lost when the app was stopped abruptly — a crash, out
  of memory, `docker kill`, a power cut, or a `docker stop` past its
  timeout. The read position in the log was saved as soon as lines were
  read, but the lines themselves only with the next batch, up to a second
  later; on restart, reading resumed after them. The position is now saved
  in the same transaction as the requests it covers, so nothing is lost and
  nothing is stored twice. (In a test with 40 forced stops during heavy
  logging, 1.6.0 lost about 30% of lines; this version lost none.)
  - A batch the database refuses is now tried again, twice, before it is
    given up on, and the per-day line counts no longer miss lines read
    while a batch was being written.
  - A normal stop that comes during a batch write now waits for it, then
    writes the rest.
- A missing file under `/assets/` was answered with the app's page and
  status 200; it is now a 404. A tab left open across an upgrade could
  otherwise take that page for one of its scripts, and the service worker
  would have kept it.
## [1.6.0] — 2026-10-26

### Added

- **Installable as an app (PWA).** Over HTTPS, browsers offer to install the
  interface (Chrome and Edge: the install icon in the address bar; iOS
  Safari: Share → Add to Home Screen). It then opens in its own window, with
  app shortcuts to Requests, Traffic and Clients.
  - A web app manifest and icons, including a maskable icon for Android and
    an Apple touch icon; the favicon is now a file rather than inline.
  - A service worker that keeps the hashed UI files, so the app opens fast,
    and shows an "offline" page when the server cannot be reached. It never
    stores API responses: statistics, requests and sessions always come
    from the server. Each release replaces it on the next load.
  - The title bar of the installed app follows the light or dark theme.

### Fixed

- Cache headers on the UI were never applied: every file, `index.html`
  included, was sent `Cache-Control: public, max-age=0`. The hashed files in
  `assets/` are now cached for a year, `index.html` is `no-store`, the
  service worker and manifest are revalidated on every load, and the other
  files (icons, the offline page) are cached for a day.
## [1.5.0] — 2026-10-24

### Added

- **Embedding in a portal.** `EMBED_ORIGINS` lists the origins allowed to
  show the interface in a frame (`scheme://host[:port]`, comma-separated;
  normalised, and invalid entries ignored with a warning). With it set, pages
  are sent `frame-ancestors 'self' <origins>` and no `X-Frame-Options`; API
  responses keep `DENY`. Empty, the default, every header is as before.
  - Sessions started over HTTPS get a `SameSite=None; Secure; Partitioned`
    cookie, so a portal on another site (opened by IP address, say) works.
    A portal on the same site works with the usual cookie, over HTTP too.
  - The portal can sign in for the user. In a frame, the interface tells its
    parent `login-required`, `logged-in`, `login-failed` and `navigated`
    through `postMessage`, and accepts the portal's `login` message — only
    from the parent window, from an allowed origin, while the Sign in screen
    is showing. See README, "Embedding in a portal".
  - A sign-in in a frame counts only once the session cookie comes back; a
    browser refusing it — another site over plain HTTP, or third-party
    cookies blocked — is reported as `login-failed`, with what to do, instead
    of a silent return to the Sign in screen.
- `src/tools/embed-test.html`: a stand-in portal for checking all of the
  above.

### Fixed

- An IPv4 address written in IPv6 form (`::ffff:10.0.0.1`) was stored as no
  source address at all.

## [1.4.2] — 2026-10-22

### Fixed

- Countries showed as "us US" on Windows: Windows has no flag emoji, so
  Chrome and Edge there draw a flag's two letters instead. Flags are now
  left out where the browser cannot draw them, and the country code or name
  shows alone; a request's source keeps its country code.

## [1.4.1] — 2026-10-22

### Changed

- Requests: the Follow checkbox is gone. The live view follows the newest
  request whenever it is in view, and stays put while you scroll up to
  read, with "↓ Latest" to jump back — so the checkbox no longer did
  anything useful. Pause still freezes the list completely, holding new
  requests until Resume.

## [1.4.0] — 2026-10-22

### Security

- Built on Node.js 22.23.4, from the Node.js security release of 21 October
  2026, which fixes ten vulnerabilities. Among them are CVE-2026-111497, remote
  code execution through the bundled Brotli decoder, and TLS certificate
  hostname bypasses. The interface decompresses data it receives over the
  network — its notoolkit lookups — and checks that server's certificate, so
  update.
- The Node.js base image is now pinned to an exact release, so a build
  always contains the fixes it is meant to, rather than whatever a moving
  tag or a build cache last held.

### Added

- A **Clients** page: every source address with traffic in the period, like
  the Domains page lists hosts — requests, share, bytes sent, errors, error
  rate, response time, country, network, and first and last seen — sortable
  by any of them, searchable by address, network, ASN or country, and for all
  domains or one. The dashboard's "Unique clients" card opens it, as do a
  domain's; "Requests" and "Domains served" open their pages too.
- Settings: **Restore from log files**. After raising the retention,
  requests deleted under the old one can be put back from the Caddy log
  files still on disk — as far back as the new retention allows, and short
  of the size limit — in the background. Statistics are not counted twice.
- An address's page has an "All requests from this address" button below
  its recent requests.

### Fixed

- Requests: the live view opens at the newest request instead of the oldest
  of the history loaded above it, and a "↓ Latest" button appears when
  scrolled up.

## [1.3.1] — 2026-10-19

### Changed

- Requests: filters now apply to the live stream as well — domain, address,
  status, method, free text, URL or agent contains, country, ASN, bots, page
  views, channel and every other filter except a time range. Searching keeps
  the stream running, filtered, with the latest matching stored requests
  above it and a button to load older ones. Setting a time range still
  switches to the stored requests in that period; "Back to live" drops the
  time range and keeps the other filters, and Reset clears them all.
- Requests: scrolled up to read, the live view stays put as requests arrive,
  and follows again once scrolled back to the newest.
- Requests from an earlier day show their date as well as their time.

### Fixed

- Settings: a size limit in whole gigabytes, such as 5, was refused by the
  browser — only sizes like 0.25, 0.75 or 1.25 were accepted — so a limit
  could not be saved, and retention stayed at its old value.
- The note on how long requests are kept now mentions the size limit, when
  one is set: "for 2 days, or less once the database reaches its 5 GB limit".
- Phones: the request filter fields no longer run off the right of the
  screen.

## [1.3.0] — 2026-10-18

### Added

- A **Settings** page, for how long individual requests are kept and how
  large the database may grow. Changes apply within about ten minutes, with
  no restart. Users listed in `CADDY_EDITORS` (everyone, when that is empty)
  can change them; others can view them.
  - Keep stored requests for any number of hours or days — or until the
    database reaches its size limit, which keeps as much history as the
    space allows.
  - A database size limit. When it is reached, the oldest stored requests
    are deleted first, whatever the retention says — then, only if those are
    down to their last hour, the oldest days of statistics. The page shows
    how much one day of requests takes at the current rate, and how much
    history a limit would hold.
  - `.env` gives the starting values: `RAW_RETENTION_HOURS` (now accepts 0,
    for "until the size limit") and the new `MAX_DB_SIZE` (e.g. `10GB`).
- Requests can be searched by time: a From and To time, or a quick choice of
  the last 15 minutes up to 7 days. A search in a time range starts there,
  instead of walking back to it from the newest request.

### Changed

- **The live log stream and the request explorer are now one page,
  Requests.** It opens streaming, as the log stream did. Searching — with
  everything the request explorer could do — pauses the stream and lists the
  matching requests; Reset, or "Back to live", resumes it. Links to the old
  log stream page open the new one.
- A search that has not found a page of matches when it reaches its time
  limit keeps searching further back on its own, for up to a dozen rounds,
  before offering a button to continue.
- Clicking a value on the dashboard, Traffic or domain pages searches the
  requests behind it over the period that page was showing, rather than from
  the newest request back.
- `RAW_MAX_ROWS` is no longer used: the size limit replaces it as the way to
  bound disk use. A warning is logged if it is still set.

## [1.2.3] — 2026-10-14

### Fixed

- Busy servers: the dashboard, Traffic, domain and request pages could take
  5–10 seconds to load. Measured on a server logging 3 million requests a
  day:
  - Every list on a page read through every breakdown's rows for the period,
    not just its own — a million URL rows to list five status codes. Each
    list now reads only its own rows.
  - A site whose every request is a new URL (an API answering
    `/lookup/<anything>`) added a million URL rows a day, kept for a week. A
    breakdown with more than 2,000 values in an hour is now trimmed to its
    top values as soon as that hour is over, instead of after a week. The
    most-errored values are kept too, so error lists stay complete. Change
    the limit with `DIM_HOURLY_MAX` and the delay with
    `DIM_COMPACT_AFTER_HOURS`. Ordinary sites never reach the limit.
  - Searching requests read each request's full log line along with it. The
    log line is now stored compressed, in a table of its own, so a search
    reads a fraction of the data and stops on time when nothing matches.
  - Searching requests by domain went through all of that domain's stored
    requests to find the newest, which took seconds for a busy one. It now
    reads only the newest, as other searches do.
- An address's page could take minutes for a very busy address: it read
  every one of its stored requests six times. Its request count and first
  and last seen are now read from the index, and its errors, domains, URLs,
  agents and methods from its latest 20,000 requests — the page says so when
  that is not all of them. It took nearly five minutes for the busiest address
  on the server above.
- Stored requests take about a quarter of the disk space they did. Requests
  already stored keep the old form until they age out (`RAW_RETENTION_HOURS`).
  After that, the database file can be shrunk to its contents with the new
  `src/tools/vacuum.js` — see README §5, "Shrinking the database file".

### Added

- `src/tools/perf.js` reports what the database holds and how long each query
  behind the main pages takes, for working out why an installation is slow.

## [1.2.2] — 2026-10-11

### Fixed

- Network lookups work again. notoolkit moved its API to
  `https://api.notoolkit.com/v1/` and retired the old address, which now
  answers `410 Gone`, so every lookup was failing and the dashboard showed a
  notoolkit error banner. Lookups now use the v1 API. **No change to `.env`
  is needed:** a `NOTOOLKIT_API_URL` of `https://notoolkit.com/` — the old
  default, which `.env.example` spelled out — is translated to the new
  address, and so is a same-server setup using `NOTOOLKIT_HOST_HEADER=notoolkit.com`.
  A warning in the log says so until `.env` is updated.
- If `NOTOOLKIT_API_URL` points at some other retired address, the error
  banner now says so and names the URL to use, instead of reporting an
  outage.

### Changed

- Outbound lookups now go to `api.notoolkit.com` instead of `notoolkit.com`.
  If your firewall restricts outbound traffic by hostname, allow the new one.

## [1.2.1] — 2026-10-10

### Fixed

- Traffic page: **Visitors** was too low for any range other than whole UTC
  days — 1 hour, 6 hours and the rolling 24 hours. A visitor who had first
  come earlier that day was left out of a later window entirely. Visitors are
  now counted exactly for any range within the hourly window
  (`HOURLY_RETENTION_DAYS`), and per whole day beyond it. The visitor line in
  the chart is exact too, including at minute resolution.
- Traffic page: the Languages list could stop the page from loading once old
  data had been condensed and a rare-language "(other)" row appeared.
- Exit pages are now counted once each visit has finished (after 30 quiet
  minutes), instead of being moved on every page view. That could leave exit
  pages counted below zero when importing old logs.
- Visits from another subdomain of the same site (docs.example.com to
  app.example.com) count as internal, not as a referral from another site.
  `example.co.uk`-style domains are handled too.

### Changed

- The Traffic page, dashboard and domain pages run fewer database queries
  on each refresh.

## [1.2.0] — 2026-10-10

### Added

- A **Traffic** page with visitor analytics worked out from Caddy's access
  log, with no tracking script: who visited, what they read, and where they
  came from.
  - Page views count browsers loading a page, not every request: assets, API
    calls, frames, prefetches and bots are left out.
  - Visitors and visits: unique visitors per day, visits (page views with no
    gap over 30 minutes), bounce rate, visit duration, pages per visit, and
    how many visitors are active right now. Visitors are told apart by a
    salted hash that changes daily, the way Plausible does it.
  - Channels: Search, Social, AI assistant (ChatGPT, Perplexity, Claude,
    Gemini, Copilot…), Email, Paid, Referral, Campaign, Internal, Direct —
    counted per visit, by the page the visit started on.
  - Entry, exit and top pages, referring sites (without your own site in the
    list), and visitor languages.
  - UTM campaigns: source, medium, campaign, term and content. `source` and
    `ref` parameters and ad click IDs (`gclid`, `msclkid`, `fbclid`…) are
    read too.
  - Broken links: pages that answered 404 to someone following a link.
  - Campaigns, referrers and channels show each one's visits, bounce rate
    and time on site.
  - Every entry opens the page views behind it in the request explorer.
  Pick a domain on the page, or use the new Traffic button on a domain's page.
  Requests still stored from before the upgrade are counted in the background
  after it starts, so the page is not empty to begin with.
- Clients claiming to be Chrome, Edge or another Chromium browser that send
  none of the headers those browsers always send over HTTPS are now counted
  as bots ("Disguised bot"). Set `BOT_HEADER_CHECK=false` to turn this off.

### Fixed

- Filtering requests by TLS cipher (clicking a cipher on a domain's Protocol
  & TLS tab) failed with an error instead of listing the requests.

## [1.1.1] — 2026-10-01

### Changed

- Domains page: the domain column is only as wide as the longest domain
  name, and the other columns get the rest of the width. Names are never
  cut off. On phones the column no longer has a fixed minimum width; a name
  too long for half the screen still wraps.

## [1.1.0] — 2026-09-30

### Added

- The Health page shows the version that is running and what changed in it,
  with the notes for earlier releases folded away underneath. They are the
  same notes as on GitHub, built into the image from this file.
- "Keep me signed in" on the sign-in page. A session started with it ticked
  is not ended by inactivity, and lasts 30 days instead of the usual 12 hours.
  Change the 30 with `SESSION_REMEMBER_DAYS`, or set it to `0` to remove the
  option. Without the tick, sign-in works as before.

### Changed

- The image is now built from the repository root, so it can include the
  changelog. To build it yourself:
  `docker build -t caddylogs:local -f app/Dockerfile .`

## [1.0.3] — 2026-09-29

### Fixed

- With notoolkit switched off, an address's page no longer shows a "not
  looked up yet" card. The Network card appears only when MaxMind has a
  country or network for the address, and then without lookup status.
- Private and local addresses are shown as "Private network" instead of
  "not enriched yet — it is queued"; they are never looked up.

## [1.0.2] — 2026-09-29

### Fixed

- With notoolkit switched off (`NOTOOLKIT_ENABLED=false`), the interface no
  longer shows the enrichment queue or warns that it is not draining. The
  queue only holds notoolkit retries, so it is now emptied at startup and not
  used at all while lookups are off. The Health page shows notoolkit as
  switched off instead of its past calls and errors.

## [1.0.1] — 2026-09-28

### Fixed

- Phones: the source address in the live log and request explorer is no
  longer cut off. It stays beside the time and status when it fits, and moves
  to its own line when it doesn't (long IPv6 addresses).
- Phones: domain names on the Domains page are shown in full and stay pinned
  on the left while the numbers scroll sideways. Name columns in the other
  tables keep a minimum width instead of being squeezed to nothing.

## [1.0.0] — 2026-09-27

First public release.

### Log dashboard

- Dashboard of hits, status codes, top URLs and addresses, bandwidth, latency
  percentiles, a visitor-country map, networks, browsers and referrers.
- Per-domain pages; every value drills down to the individual requests behind
  it; a request explorer with `key:value` search; a live log stream.
- Statistics are kept in their own SQLite database, so history survives log
  rotation and deletion, with hourly and daily tiers and bounded storage.
- Visitor country from MaxMind GeoLite2 (local). Network, AS and registry
  detail from notoolkit.com — on by default, switched off entirely with
  `NOTOOLKIT_ENABLED=false`.

### Caddy configuration management

- Add, remove, enable and disable sites; forms with help for almost every
  Caddy option (reverse proxy, static files, PHP, redirects, path rules, IP
  allowlists, password protection, single sign-on, TLS, headers, compression,
  logging); a directive tree and a raw editor for everything else.
- Every change is shown as a diff, validated by Caddy, applied with a
  zero-downtime reload, and kept in a restorable history.
- Talks to Caddy's admin API over a unix socket — no TCP admin port, no
  Docker socket. `CADDY_MANAGE=false` removes the feature entirely.

### Deployment

- One container (`victimofareload/caddylogs`) that runs next to Caddy, for
  linux/amd64 and linux/arm64, with a compose file that runs both.
- The image runs as a non-root user; the compose file adds a read-only
  filesystem, no Linux capabilities and `no-new-privileges`.
- Works on phones: slide-in menu, readable request lists, folding filters.

[1.7.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.7.0
[1.6.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.6.0
[1.5.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.5.0
[1.4.2]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.4.2
[1.4.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.4.1
[1.4.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.4.0
[1.3.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.3.1
[1.3.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.3.0
[1.2.3]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.2.3
[1.2.2]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.2.2
[1.2.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.2.1
[1.2.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.2.0
[1.1.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.1.1
[1.1.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.1.0
[1.0.3]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.3
[1.0.2]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.2
[1.0.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.1
[1.0.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.0
