-- Migration: user_cloud one row per (user_id, provider).
--
-- Was PRIMARY KEY (user_id) — a single provider per user. Multi-provider sync
-- needs an independent {path, credential} per provider, so the PK becomes
-- (user_id, provider). SQLite can't alter a PK in place, so rebuild + copy.
-- Applied once by `wrangler d1 migrations apply` (recorded in d1_migrations).

CREATE TABLE user_cloud_new (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'mega',
  path       TEXT NOT NULL DEFAULT '',
  credential TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

INSERT INTO user_cloud_new (user_id, provider, path, credential, updated_at)
  SELECT user_id, provider, path, credential, updated_at FROM user_cloud;

DROP TABLE user_cloud;
ALTER TABLE user_cloud_new RENAME TO user_cloud;
