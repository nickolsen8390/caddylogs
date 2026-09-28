# Caddy Log Interface — one container that runs next to Caddy.
# Published as victimofareload/caddylogs; source: https://github.com/nickolsen8390/caddylogs
#
# Releases are built and pushed by .github/workflows/docker.yml when a version
# tag (v1.2.3) is pushed. To build locally, from the repository root:
#   docker build -t caddylogs:local ./app
#
# Lockfiles (package-lock.json) are used when present, for reproducible builds.

# ---------- stage 1: build the React UI ----------
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi
COPY ui/ ./
RUN npm run build

# ---------- stage 2: build native server deps ----------
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# ---------- stage 3: runtime ----------
FROM node:22-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Caddy Log Interface" \
      org.opencontainers.image.description="Dashboard for Caddy's access logs, with Caddyfile management and zero-downtime reloads" \
      org.opencontainers.image.source="https://github.com/nickolsen8390/caddylogs" \
      org.opencontainers.image.url="https://github.com/nickolsen8390/caddylogs" \
      org.opencontainers.image.documentation="https://github.com/nickolsen8390/caddylogs#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /logs /geoip /caddy /run/caddy
# Every one of those is a mount point — bind mounts take their ownership from
# the host, so there is nothing useful to chown at build time.

# Paths inside the container. Mount your directories at these locations; the
# settings exist so a different layout can still be used.
ENV NODE_ENV=production \
    APP_MODE=all \
    DB_PATH=/data/stats.db \
    LOG_DIR=/logs \
    MAXMIND_COUNTRY_DB=/geoip/GeoLite2-Country.mmdb \
    MAXMIND_ASN_DB=/geoip/GeoLite2-ASN.mmdb \
    CADDYFILE_PATH=/caddy/Caddyfile \
    CADDY_ADMIN_ADDRESS=unix//run/caddy/admin.sock

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY --from=ui /ui/dist ./public

# Default UID 1000. Override with --user (compose: user: PUID:PGID) to match
# the owner of the bind-mounted data directory.
USER node
EXPOSE 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/tools/healthcheck.js"]
CMD ["node", "src/index.js"]
