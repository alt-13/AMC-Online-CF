-- 0005: TMDB key + the display-only ratings/streaming cache.
--
-- tmdb_key: per-user TMDB key (v3 API key or v4 read token), AES-GCM encrypted
-- at rest exactly like omdb_key. NULL = use the optional global TMDB_API_KEY.
--
-- ext_info: what the movie header shows beyond the .amc — every OMDb rating and
-- the streaming offers for one region (TMDB/JustWatch). Display-only: never
-- exported, never merged into movies. Keyed by IMDb id, not movie id, so it
-- survives re-imports and is shared by every catalog holding the film.
-- Tenant-scoped like everything else (rule 8). Rows older than 7 days are
-- refetched on read (worker/extinfo.ts EXTINFO_TTL_MS); nothing sweeps them.

ALTER TABLE user_settings ADD COLUMN tmdb_key TEXT;

CREATE TABLE IF NOT EXISTS ext_info (
  tenant_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  imdb_id    TEXT NOT NULL,              -- tt0133093
  region     TEXT NOT NULL,              -- ISO 3166-1 alpha-2, upper case
  data       TEXT NOT NULL,              -- JSON ExtInfo (worker/extinfo.ts)
  fetched_at INTEGER NOT NULL,           -- epoch ms
  PRIMARY KEY (tenant_id, imdb_id, region)
);
