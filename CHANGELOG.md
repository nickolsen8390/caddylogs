# Changelog

All notable changes are listed here. Versions follow
[semantic versioning](https://semver.org): a new major version (2.0.0) is the
only kind that can require you to change anything when upgrading.

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

[1.2.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.2.0
[1.1.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.1.1
[1.1.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.1.0
[1.0.3]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.3
[1.0.2]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.2
[1.0.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.1
[1.0.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.0
