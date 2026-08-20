-- Migration: add catalogs.text_encoding (legacy ANSI umlaut fix).
--
-- New databases get this column straight from schema.sql. Existing databases
-- need this ALTER once:
--   wrangler d1 execute amc --file=cf/migrations/0001_text_encoding.sql
--
-- Catalogs imported BEFORE this fix already had their legacy (non-UTF-8) bytes
-- destroyed by D1 (stored as U+FFFD "�") — those bytes are unrecoverable, so
-- affected catalogs must be re-imported after deploying the fix. The DEFAULT
-- 'utf-8' below keeps every pre-existing row exporting exactly as it did before.

ALTER TABLE catalogs ADD COLUMN text_encoding TEXT NOT NULL DEFAULT 'utf-8';
