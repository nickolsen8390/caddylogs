-- ---------------------------------------------------------------------------
--  Caddy Log Interface — schema
--  Time convention:  events.ts   = epoch MILLISECONDS
--                    *.bucket    = epoch SECONDS at the start of the hour/day
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Tail checkpoints, keyed by INODE rather than path. Rotation renames a file
-- (access.log -> access-2024-01-02T00-00-00.000.log) without changing its
-- inode, so following the inode means the tail resumes at the right offset and
-- the fresh access.log is correctly treated as a new file starting at 0.
-- Keying by path would re-read every rotated file from the beginning.
CREATE TABLE IF NOT EXISTS ingest_state (
  inode      TEXT PRIMARY KEY,
  path       TEXT,
  offset     INTEGER NOT NULL DEFAULT 0,
  size       INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  gone_at    INTEGER   -- when the file was last seen missing from the directory
);
CREATE INDEX IF NOT EXISTS idx_ingest_state_updated ON ingest_state(updated_at);

-- Individual requests. Short retention; powers the live stream and per-request
-- inspection. The original Caddy JSON line is in events_raw; `raw` here is
-- only filled on rows written before 1.2.3, and empties as they age out.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  host        TEXT    NOT NULL,
  method      TEXT,
  path        TEXT,
  query       TEXT,
  status      INTEGER,
  bytes_out   INTEGER NOT NULL DEFAULT 0,
  bytes_in    INTEGER NOT NULL DEFAULT 0,
  dur_ms      REAL,
  ip          TEXT,
  ua          TEXT,
  referer     TEXT,
  proto       TEXT,
  tls_version TEXT,
  tls_cipher  TEXT,
  browser     TEXT,
  os          TEXT,
  device      TEXT,
  bot         INTEGER NOT NULL DEFAULT 0,
  country     TEXT,
  asn         INTEGER,
  as_org      TEXT,
  rolled      INTEGER NOT NULL DEFAULT 0,
  referer_host TEXT,
  raw         TEXT,
  -- Visitor analytics (ingest/traffic.js). nav = 1 for a browser navigating
  -- to a page; NULL only on rows written before these columns existed.
  -- The rest are set on navigations only.
  nav          INTEGER,
  channel      TEXT,
  lang         TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_term     TEXT,
  utm_content  TEXT,
  visitor      TEXT     -- on page views: the visitor id (ingest/visits.js)
);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_host_ts   ON events(host, ts);
CREATE INDEX IF NOT EXISTS idx_events_unrolled  ON events(rolled, ts) WHERE rolled = 0;
CREATE INDEX IF NOT EXISTS idx_events_ip        ON events(ip);
CREATE INDEX IF NOT EXISTS idx_events_status    ON events(status);

-- The original log line of each stored request, compressed (util/rawlog.js).
-- Kept apart from `events` so that searching requests does not read it: in
-- the same table it made each row ten times larger.
CREATE TABLE IF NOT EXISTS events_raw (
  id   INTEGER PRIMARY KEY,   -- events.id
  raw  BLOB NOT NULL
);

-- Per-bucket, per-host headline counters.
CREATE TABLE IF NOT EXISTS rollup (
  bucket    INTEGER NOT NULL,
  gran      TEXT    NOT NULL,          -- 'h' | 'd'
  host      TEXT    NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  bytes_in  INTEGER NOT NULL DEFAULT 0,
  dur_sum   REAL    NOT NULL DEFAULT 0,
  dur_max   REAL    NOT NULL DEFAULT 0,
  c1xx      INTEGER NOT NULL DEFAULT 0,
  c2xx      INTEGER NOT NULL DEFAULT 0,
  c3xx      INTEGER NOT NULL DEFAULT 0,
  c4xx      INTEGER NOT NULL DEFAULT 0,
  c5xx      INTEGER NOT NULL DEFAULT 0,
  bots      INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  -- Visits are counted in the hour they started (ingest/visits.js).
  visits    INTEGER NOT NULL DEFAULT 0,
  -- A visitor's first visit of the UTC day. Exact for whole days, so it is
  -- only read from daily rows; recent hours count visitor_seen instead.
  visitors  INTEGER NOT NULL DEFAULT 0,
  bounces   INTEGER NOT NULL DEFAULT 0,  -- visits of a single page view
  visit_ms  INTEGER NOT NULL DEFAULT 0,  -- first to last page view, summed
  PRIMARY KEY (bucket, gran, host)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rollup_scan ON rollup(gran, bucket);

-- Generic dimension counters. One row per distinct value per bucket per host.
-- dim ∈ status | method | path | ip | ua | browser | os | device | country |
--       asn | referer | proto | tls | cipher | ext | lat | kind
-- and `page`, counting page views only, and `broken`: paths that answered
-- 404 to a browser following a link.
--
-- Visit dimensions count visits, in the hour each visit started, and use the
-- columns differently: requests = visits, bytes = page views in those visits,
-- errors = bounces, dur_sum = visit duration in ms.
--       entry | exit | channel | refsite | lang | utm_source | utm_medium |
--       utm_campaign | utm_term | utm_content
-- All but `exit` are counted when a visit starts and adjusted as it grows;
-- `exit` is counted once, when the visit closes.
CREATE TABLE IF NOT EXISTS dims (
  bucket   INTEGER NOT NULL,
  gran     TEXT    NOT NULL,
  host     TEXT    NOT NULL,
  dim      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes    INTEGER NOT NULL DEFAULT 0,
  errors   INTEGER NOT NULL DEFAULT 0,
  dur_sum  REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, gran, host, dim, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dims_scan  ON dims(gran, dim, bucket);
CREATE INDEX IF NOT EXISTS idx_dims_host  ON dims(gran, dim, host, bucket);

-- Visits, so a later page view can extend the right one and a visit's exit
-- page can be counted when it closes (ingest/visits.js). Statistics are in
-- rollup/dims; this is working state, pruned a day after a visit was last
-- touched. The index on open visits is created in db.js.
CREATE TABLE IF NOT EXISTS visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor      TEXT    NOT NULL,   -- hash of the day's salt, host, address, User-Agent
  host         TEXT    NOT NULL,
  start_ts     INTEGER NOT NULL,   -- epoch ms of the first page view
  end_ts       INTEGER NOT NULL,   -- epoch ms of the last page view
  pageviews    INTEGER NOT NULL DEFAULT 1,
  entry_path   TEXT,
  exit_path    TEXT,
  first        INTEGER NOT NULL DEFAULT 0,  -- the visitor's first visit that day
  channel      TEXT,
  refsite      TEXT,
  lang         TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_term     TEXT,
  utm_content  TEXT,
  touched      INTEGER NOT NULL DEFAULT 0,  -- wall clock of the last change
  closed       INTEGER NOT NULL DEFAULT 0   -- 1 once it can no longer grow
);
CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits(visitor, end_ts);
CREATE INDEX IF NOT EXISTS idx_visits_end     ON visits(end_ts);
CREATE INDEX IF NOT EXISTS idx_visits_touched ON visits(touched);

-- Which visitors had a page view in each hour, so "visitors" over any range
-- is an exact distinct count. Hours are deleted as they fold into days, where
-- rollup.visitors is exact.
CREATE TABLE IF NOT EXISTS visitor_seen (
  bucket   INTEGER NOT NULL,   -- epoch seconds at the start of the hour
  host     TEXT    NOT NULL,
  visitor  TEXT    NOT NULL,
  PRIMARY KEY (bucket, host, visitor)
) WITHOUT ROWID;

-- First/last seen per served host, for the domains list.
CREATE TABLE IF NOT EXISTS hosts (
  host       TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Per-ASN registrant detail, kept out of `dims` so the dimension value stays a
-- compact integer while the UI can still show "AS15169 GOOGLE". There is one
-- row per distinct ASN ever seen — a bounded set — so the bulky WHOIS text
-- lives here rather than being repeated against every IP.
--
-- Columns mirror notoolkit.com's ASN response. `country` is the country of the
-- AS *registrant*, which is not where the traffic came from; visitor country
-- comes from MaxMind and lives on ip_info.country.
CREATE TABLE IF NOT EXISTS asn_names (
  asn           INTEGER PRIMARY KEY,
  as_name       TEXT,     -- short RIR handle, e.g. GOOGLE
  org           TEXT,     -- full registered organisation name
  country       TEXT,     -- registrant country, ISO 3166-1 alpha-2
  rir           TEXT,     -- ARIN | RIPE | APNIC | LACNIC | AFRINIC
  description   TEXT,
  whois_raw     TEXT,
  prefix_v4     INTEGER,  -- prefixes originated, from the ASN endpoint
  prefix_v6     INTEGER,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  detail_at     INTEGER,  -- when the richer /?asn= lookup last succeeded
  detail_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_asn_detail ON asn_names(detail_at);

-- IP -> country / ASN cache.
CREATE TABLE IF NOT EXISTS ip_info (
  ip           TEXT PRIMARY KEY,
  country      TEXT,      -- MaxMind: where the client is
  country_name TEXT,
  asn          INTEGER,
  as_name      TEXT,
  as_org       TEXT,
  as_prefix    TEXT,      -- longest-matching BGP prefix
  as_country   TEXT,      -- notoolkit: where the AS is registered
  as_rir       TEXT,
  source       TEXT,      -- notoolkit | maxmind | maxmind-fallback | private
  updated_at   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ip_info_updated ON ip_info(updated_at);

-- IPs awaiting (or having failed) enrichment.
CREATE TABLE IF NOT EXISTS ip_queue (
  ip        TEXT PRIMARY KEY,
  attempts  INTEGER NOT NULL DEFAULT 0,
  next_try  INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ip_queue_next ON ip_queue(next_try);

-- Health of the external enrichment provider, surfaced in the UI.
CREATE TABLE IF NOT EXISTS provider_health (
  provider     TEXT PRIMARY KEY,
  ok           INTEGER NOT NULL DEFAULT 1,
  last_ok_at   INTEGER,
  last_error   TEXT,
  last_error_at INTEGER,
  calls        INTEGER NOT NULL DEFAULT 0,
  failures     INTEGER NOT NULL DEFAULT 0
);

-- Server-side sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT,
  -- 1 when signed in with "keep me signed in": exempt from the idle timeout.
  persistent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- Login throttling.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  username TEXT,
  ok       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_ip_ts ON login_attempts(ip, ts);

-- Counters for lines the parser could not use, surfaced on the health page.
CREATE TABLE IF NOT EXISTS ingest_stats (
  day        INTEGER PRIMARY KEY,
  lines      INTEGER NOT NULL DEFAULT 0,
  parsed     INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  malformed  INTEGER NOT NULL DEFAULT 0
);

-- Settings saved from the Settings page (settings.js); .env gives defaults.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL,
  username   TEXT
);

-- Every version of the Caddyfile this interface has applied, plus the on-disk
-- version it replaced the first time, so any change can be rolled back.
CREATE TABLE IF NOT EXISTS caddy_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  username  TEXT,
  action    TEXT NOT NULL,   -- apply | restore | reload | baseline
  message   TEXT,
  hash      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  text      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_caddy_history_ts ON caddy_history(ts);
