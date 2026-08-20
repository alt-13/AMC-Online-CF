-- Migration: add catalogs.text_encoding (legacy ANSI umlaut fix).
--
-- Applied by Wrangler's D1 migrations, which record it in d1_migrations so it
-- runs exactly once per database:
--   wrangler d1 migrations apply amc --remote
-- (run automatically by setup.sh and by the deploy step — see package.json).
--
-- Catalogs imported BEFORE this fix already had their legacy (non-UTF-8) bytes
-- destroyed by D1 (stored as U+FFFD "�") — those bytes are unrecoverable, so
-- affected catalogs must be re-imported after deploying the fix. The DEFAULT
-- 'utf-8' below keeps every pre-existing row exporting exactly as it did before.

ALTER TABLE catalogs ADD COLUMN text_encoding TEXT NOT NULL DEFAULT 'utf-8';
