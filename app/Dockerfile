# ---------- stage 1: build the React UI ----------
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ./
RUN npm install --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# ---------- stage 2: build native server deps ----------
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- stage 3: runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /logs /geoip
# /data, /logs and /geoip exist only as mount points — every one of them is a
# bind mount whose ownership comes from the host, so there is nothing useful to
# chown at build time.
WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY --from=ui /ui/dist ./public
# Default UID. docker-compose overrides this with PUID:PGID from .env, because
# bind-mounted storage keeps the host directory's ownership.
USER node
EXPOSE 8899
CMD ["node", "src/index.js"]
