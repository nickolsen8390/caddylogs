# Caddy Log Interface

A self-hosted dashboard for [Caddy](https://caddyserver.com)'s access logs, and
a web editor for your Caddyfile — in one container that runs next to Caddy.

- **Statistics that outlive your logs** — hits, status codes, top URLs and
  addresses, bandwidth, latency, a visitor-country map, networks, browsers and
  referrers, per domain. History is kept in its own database, so rotating or
  deleting logs loses nothing.
- **Drill into anything** — every number resolves to the individual requests
  behind it; search with `host:` `status:` `ua:` `ip:` terms; watch a live
  stream.
- **Manage Caddy** — add, change, disable and remove sites from forms with help
  for almost every option, or edit the Caddyfile directly. Every change is
  shown as a diff, validated by Caddy and applied with a zero-downtime reload,
  with a history you can restore from.
- **Built for a server that faces the internet** — non-root, read-only
  filesystem, hashed sessions, CSRF protection, login throttling, strict CSP.
  No Docker socket and no network-exposed admin port.

Source, full documentation and issues:
**https://github.com/nickolsen8390/caddylogs**

> **Outbound lookups — on by default, one setting to turn off.** To show which
> network each visitor belongs to, the app sends each **public visitor IP
> address** (once, then cached) and AS numbers to the free
> [notoolkit.com](https://notoolkit.com) API. No URLs, user agents or other log
> content are sent, and private addresses never are. Set
> `NOTOOLKIT_ENABLED=false` to make no outbound calls at all; visitor countries
> still work offline.

## Quick start: Caddy and the interface together

The compose file from the repository runs Caddy and this image side by side.

```bash
mkdir caddylogs && cd caddylogs
base=https://raw.githubusercontent.com/nickolsen8390/caddylogs/main
curl -fsSLO "$base/docker-compose.yml"
curl -fsSL "$base/.env.example" -o .env
mkdir -p data geoip caddy/conf caddy/run caddy/logs caddy/data caddy/config
curl -fsSL "$base/Caddyfile.example" -o caddy/conf/Caddyfile
sudo chown -R 1000:1000 data caddy/conf caddy/run && sudo chmod 700 caddy/run
```

The container runs as UID 1000 (`PUID`/`PGID` in `.env`); it only has to own
those three directories, and does not need to exist as a host account.

Set who may sign in, in `.env`:

```bash
AUTH_USERS=admin:<a long, unique password>
```

In `caddy/conf/Caddyfile`, replace `logs.example.com` with your host name and
the example addresses on the `@notlocal` line with the networks allowed to
reach the interface (everyone else gets 403). Then:

```bash
docker compose up -d
```

The interface listens on port 8899; the example Caddyfile serves it over HTTPS
on your host name. For visitor countries, add the free MaxMind
`GeoLite2-Country.mmdb` to `geoip/`.

Already running Caddy? The README explains how to move its certificates,
Caddyfile and logs into this stack:
https://github.com/nickolsen8390/caddylogs#moving-an-existing-caddy-into-this-stack

## Dashboard only, next to an existing Caddy

Without the Caddy management mounts, set `CADDY_MANAGE=false`:

```bash
docker run -d --name caddylogs --restart unless-stopped \
  --user 1000:1000 --read-only --tmpfs /tmp -p 8899:8899 \
  -e AUTH_USERS='admin:<password>' -e CADDY_MANAGE=false \
  -v "$PWD/data:/data" -v /var/log/caddy:/logs:ro \
  nickolsen8390/caddylogs:1
```

Caddy must write JSON access logs (`format json`) into the mounted directory,
readable by the container user (`mode 0644` on the log output). `./data` must
be owned by the `--user` you run as. Over plain HTTP, also set
`COOKIE_SECURE=false`.

## Mounts

| Path in the container | Contents | Access |
|---|---|---|
| `/data` | the SQLite database | read-write |
| `/logs` | Caddy's JSON access logs | read-only |
| `/geoip` | GeoLite2 `.mmdb` files (optional) | read-only |
| `/caddy` | directory containing the `Caddyfile` (config management) | read-write |
| `/run/caddy` | Caddy's admin socket (config management) | read-write |

## Main settings

| Variable | Default | |
|---|---|---|
| `AUTH_USERS` | — | **required**; `user:password` or `user:scrypt$…`, comma-separated |
| `CADDY_MANAGE` | `true` | `false` removes the Caddy configuration pages entirely |
| `CADDY_EDITORS` | everyone | users allowed to change Caddy's configuration |
| `NOTOOLKIT_ENABLED` | `true` | `false` stops all outbound lookups |
| `COOKIE_SECURE` | `true` | `false` only for plain-HTTP access on a trusted network |
| `RETENTION_DAYS` | `365` | how long statistics are kept |
| `RAW_RETENTION_HOURS` | `48` | how long individual requests are kept |
| `TZ` | `UTC` | time zone |

Every setting is documented in
[`.env.example`](https://github.com/nickolsen8390/caddylogs/blob/main/.env.example).

## Tags

| Tag | Follows |
|---|---|
| `1.0.0` | exactly that release |
| `1.0` | the latest 1.0.x (fixes only) |
| `1` | the latest 1.x — **recommended** |
| `latest` | the newest release, including future major versions |

Images are built for `linux/amd64` and `linux/arm64` by GitHub Actions from
tagged releases, with provenance and SBOM attestations.
[Changelog](https://github.com/nickolsen8390/caddylogs/blob/main/CHANGELOG.md)

## Security and license

Report vulnerabilities privately — see
[SECURITY.md](https://github.com/nickolsen8390/caddylogs/blob/main/SECURITY.md).
MIT licensed.
