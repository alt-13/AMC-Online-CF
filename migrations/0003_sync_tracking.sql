-- Migration: per-catalog sync tracking (local revision + remote fingerprint).
--
-- Applied by Wrangler's D1 migrations, recorded in d1_migrations so it runs
-- exactly once per database:
--   wrangler d1 migrations apply amc --remote
-- (run automatically by setup.sh and the deploy step — see package.json).
--
-- WHY A COUNTER, not a timestamp: content_rev is compared against synced_rev to
-- answer "is the .amc on the cloud behind the DB?". A counter is immune to clock
-- skew between the Worker and anything else, and yields an exact "N revisions
-- behind" for the UI.
--
-- Existing rows land on content_rev = synced_rev = 0 with remote_checked_at
-- NULL, which the frontend derives as "unknown" — honest, because we hold no
-- fingerprint for a catalog that was pushed before this migration. The first
-- remote check resolves them.

ALTER TABLE catalogs ADD COLUMN content_rev        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalogs ADD COLUMN synced_rev         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalogs ADD COLUMN content_hash       TEXT;
ALTER TABLE catalogs ADD COLUMN remote_fingerprint TEXT;
ALTER TABLE catalogs ADD COLUMN remote_size        INTEGER;
ALTER TABLE catalogs ADD COLUMN remote_state       TEXT;
ALTER TABLE catalogs ADD COLUMN remote_checked_at  INTEGER;
ALTER TABLE catalogs ADD COLUMN last_sync_at       INTEGER;

-- Per-row mtime. Powers "M movies touched since the last sync" in the conflict
-- dialog. Nullable with no default on purpose: pre-existing rows read NULL, so
-- `updated_at > last_sync_at` is false for them and they correctly do not count
-- as touched.
ALTER TABLE movies ADD COLUMN updated_at INTEGER;
