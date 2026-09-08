-- AMC Online — Cloudflare D1 schema (cf-port)
--
-- Design rules that keep the app inside Worker limits:
--   1. D1 holds METADATA ONLY. Every embedded JPEG (movie poster + extra
--      poster) lives in R2; D1 stores the R2 object key, never the bytes.
--      This is what removes the 128 MB in-memory-catalog problem: a Worker
--      never loads more than a handful of rows + one poster at a time.
--   2. Multi-tenant via `tenant_id` on the root table + R2 key prefixes.
--      One shared D1 (NOT one-DB-per-user — there is an account cap on the
--      number of databases).
--   3. Positional custom-field values are preserved via `custom_field_defs.ordinal`
--      so an export re-emits them in the exact on-disk order the format requires.
--
-- Apply:  wrangler d1 execute amc --file=schema.sql

PRAGMA foreign_keys = ON;

-- Accounts. `id` doubles as the tenant_id used across catalogs + R2 key prefixes.
-- Passwords are PBKDF2-SHA256 (WebCrypto) — never bcrypt — see worker/auth.ts.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,             -- uuid == tenant_id
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,         -- case-insensitive login key
  password_hash TEXT NOT NULL,               -- pbkdf2-sha256$iters$salt$key
  created_at    INTEGER NOT NULL
);

-- One row per uploaded .amc library (a "catalog"), owned by a tenant.
CREATE TABLE IF NOT EXISTS catalogs (
  id                  TEXT PRIMARY KEY,          -- uuid
  tenant_id           TEXT NOT NULL,             -- owning user/account
  version             INTEGER NOT NULL,          -- 31|33|35|40|41|42
  name                TEXT NOT NULL DEFAULT '',
  mail                TEXT NOT NULL DEFAULT '',
  site                TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  cfp_column_settings TEXT NOT NULL DEFAULT '',  -- v4.0+ header blob (opaque)
  cfp_gui_properties  TEXT NOT NULL DEFAULT '',  -- v4.0+ header blob (opaque)
  -- NOTE: `text_encoding` is added by migrations/0001_text_encoding.sql, not here.
  -- This file is the BASELINE schema; all later column additions live in
  -- migrations/*.sql and are applied with `wrangler d1 migrations apply` (see
  -- setup.sh / the deploy step). Keeping the column out of the baseline avoids a
  -- "duplicate column" collision when migrations run on a freshly-created DB.
  -- Stable origin key for cloud pulls (e.g. "mega:<folder>:<file>.amc"). NULL for
  -- direct file uploads. Lets re-pulling the same .amc replace its catalog instead
  -- of piling up duplicates.
  source_ref          TEXT,
  created_at          INTEGER NOT NULL,          -- epoch ms
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalogs_tenant ON catalogs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_catalogs_source ON catalogs (tenant_id, source_ref);

-- Custom field definitions (catalog header, v4.0+). `ordinal` is authoritative:
-- per-movie custom values are stored positionally in the binary, so export must
-- walk defs in this exact order.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id                      TEXT PRIMARY KEY,
  catalog_id              TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  ordinal                 INTEGER NOT NULL,      -- 0-based position in the file
  tag                     TEXT NOT NULL,
  name                    TEXT NOT NULL DEFAULT '',
  field_ext               TEXT NOT NULL DEFAULT '',
  field_type              TEXT NOT NULL DEFAULT 'ftString',
  default_value           TEXT NOT NULL DEFAULT '',
  media_info              TEXT NOT NULL DEFAULT '',
  multi_values            INTEGER NOT NULL DEFAULT 0,  -- bool
  multi_values_sep        INTEGER NOT NULL DEFAULT 44,  -- ','
  multi_values_rmp        INTEGER NOT NULL DEFAULT 0,
  multi_values_patch      INTEGER NOT NULL DEFAULT 0,
  excluded_in_scripts     INTEGER NOT NULL DEFAULT 0,
  gui_properties          TEXT NOT NULL DEFAULT '',
  list_values             TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  list_auto_add           INTEGER NOT NULL DEFAULT 0,
  list_sort               INTEGER NOT NULL DEFAULT 0,
  list_auto_complete      INTEGER NOT NULL DEFAULT 0,
  list_use_catalog_values INTEGER NOT NULL DEFAULT 0,
  UNIQUE (catalog_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_cfd_catalog ON custom_field_defs (catalog_id);

-- Movie records. Scalar fields are columns; the poster is an R2 pointer.
-- Custom-field values are stored as a {tag: value} JSON map for edit ergonomics
-- and re-expanded to positional order on export via custom_field_defs.ordinal.
CREATE TABLE IF NOT EXISTS movies (
  id               TEXT PRIMARY KEY,
  catalog_id       TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,            -- on-disk sequential id
  date             INTEGER NOT NULL DEFAULT 0,
  date_watched     INTEGER NOT NULL DEFAULT 0,
  user_rating      INTEGER NOT NULL DEFAULT -1,
  rating           INTEGER NOT NULL DEFAULT -1,
  year             INTEGER NOT NULL DEFAULT -1,
  length           INTEGER NOT NULL DEFAULT -1,
  video_bitrate    INTEGER NOT NULL DEFAULT -1,
  audio_bitrate    INTEGER NOT NULL DEFAULT -1,
  disks            INTEGER NOT NULL DEFAULT -1,
  color_tag        INTEGER NOT NULL DEFAULT 0,
  checked          INTEGER NOT NULL DEFAULT 0,
  media            TEXT NOT NULL DEFAULT '',
  media_type       TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT '',
  borrower         TEXT NOT NULL DEFAULT '',
  original_title   TEXT NOT NULL DEFAULT '',
  translated_title TEXT NOT NULL DEFAULT '',
  director         TEXT NOT NULL DEFAULT '',
  producer         TEXT NOT NULL DEFAULT '',
  writer           TEXT NOT NULL DEFAULT '',
  composer         TEXT NOT NULL DEFAULT '',
  country          TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT '',
  certification    TEXT NOT NULL DEFAULT '',
  actors           TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  comments         TEXT NOT NULL DEFAULT '',
  file_path        TEXT NOT NULL DEFAULT '',
  video_format     TEXT NOT NULL DEFAULT '',
  audio_format     TEXT NOT NULL DEFAULT '',
  resolution       TEXT NOT NULL DEFAULT '',
  framerate        TEXT NOT NULL DEFAULT '',
  languages        TEXT NOT NULL DEFAULT '',
  subtitles        TEXT NOT NULL DEFAULT '',
  size             TEXT NOT NULL DEFAULT '',
  pic_path         TEXT NOT NULL DEFAULT '',     -- original external path (preserved)
  poster_key       TEXT,                         -- R2 object key, NULL if no embedded image
  custom_values    TEXT NOT NULL DEFAULT '{}',   -- JSON {tag: value}
  sort_title       TEXT                          -- DROPPED by migrations/0004_drop_sort_title.sql
                                                 -- (replaced by an expression index; see SORT_TITLE_SQL in worker/db.ts)
  -- NOTE: no UNIQUE on (catalog_id, number). AMC does NOT enforce unique movie
  -- numbers, so real catalogs contain duplicates (and 0s) — a unique constraint
  -- would reject those imports. new in-app movies still get a fresh number via
  -- nextMovieNumber() (MAX+1); the index below just keeps export's ORDER BY fast.
);
CREATE INDEX IF NOT EXISTS idx_movies_catalog ON movies (catalog_id);
-- Rebuilt as an expression index by migrations/0004_drop_sort_title.sql.
CREATE INDEX IF NOT EXISTS idx_movies_sort ON movies (catalog_id, sort_title);
CREATE INDEX IF NOT EXISTS idx_movies_number ON movies (catalog_id, number);
CREATE INDEX IF NOT EXISTS idx_movies_year ON movies (catalog_id, year);

-- Movie extras (v4.2+). Each may carry its own embedded poster → R2.
CREATE TABLE IF NOT EXISTS movie_extras (
  id          TEXT PRIMARY KEY,
  movie_id    TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,                 -- position within the movie
  checked     INTEGER NOT NULL DEFAULT 0,
  tag         TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  comments    TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  pic_path    TEXT NOT NULL DEFAULT '',
  poster_key  TEXT,                             -- R2 object key, NULL if none
  UNIQUE (movie_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_extras_movie ON movie_extras (movie_id);

-- Per-user cloud-sync config: which provider, where the .amc lives, and an
-- OPTIONAL credential encrypted at rest. provider + path are not secrets. The
-- credential is AES-256-GCM (WebCrypto HKDF off AUTH_SECRET, see worker/crypto.ts)
-- — never plaintext — mirroring how the pm project stores SMTP passwords.
--
-- Self-hosting model: each deployment is ONE person's own Cloudflare account, so
-- the AUTH_SECRET holder and the cloud-account owner are the same party. This
-- keeps the credential out of D1 dumps/consoles; it is not a defense against the
-- operator (who is the user). One row per user.
CREATE TABLE IF NOT EXISTS user_cloud (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'mega',   -- 'mega'|'drive'|'onedrive' (frontend/connector.ts)
  path       TEXT NOT NULL DEFAULT '',       -- e.g. /Backups/movies.amc
  credential TEXT,                            -- base64(iv‖AES-GCM ct), NULL if none
  updated_at INTEGER NOT NULL
);

-- Per-user app settings (field visibility per surface + the search field).
-- Stored as one opaque JSON blob, mirroring the pm project's settings.json:
--   { "field_visibility": { "desktop": {col:bool}, "mobile": {col:bool} },
--     "search_field": "" }        -- "" = all, a column name, or "custom:TAG"
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '{}',
  -- OMDb API key, encrypted at rest exactly like user_cloud.credential (AES-GCM,
  -- never plaintext). Per-user so the OMDb key is set in-app, not as a Worker
  -- secret — the only deploy-time secret is then the Cloudflare token. NULL = use
  -- the optional global OMDB_API_KEY env var, if the operator set one.
  omdb_key   TEXT,
  updated_at INTEGER NOT NULL
);

-- Full-text search over the fields people actually search. Populate on import
-- and keep in sync on edit; optional but cheap and keeps search off the hot path.
CREATE VIRTUAL TABLE IF NOT EXISTS movies_fts USING fts5 (
  original_title, translated_title, director, actors, description,
  content=''  -- external-content-less; you insert rowid = movies.rowid
);
