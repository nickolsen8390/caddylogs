# Changelog

All notable changes are listed here. Versions follow
[semantic versioning](https://semver.org): a new major version (2.0.0) is the
only kind that can require you to change anything when upgrading.

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

[1.0.3]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.3
[1.0.2]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.2
[1.0.1]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.1
[1.0.0]: https://github.com/nickolsen8390/caddylogs/releases/tag/v1.0.0
