-- 0004: drop movies.sort_title in favour of an expression index.
--
-- sort_title was a denormalised copy of lower(translated || original), derived
-- in four places (import mapping, create, the edit form, and a patch-time
-- fixup in the Worker that existed only because the column drifted). SQLite
-- indexes expressions directly, so the column bought nothing the index did not.
--
-- listMovies() must ORDER BY the SAME expression verbatim or the index is
-- ignored — see SORT_TITLE_SQL in worker/db.ts.
--
-- Note: translated_title is NOT NULL DEFAULT '', never NULL, so coalesce() does
-- not work here; the CASE is what picks the translated title when it is set.
--
-- Behaviour change: SQLite lower() is ASCII-only while JS toLowerCase() is
-- Unicode, so titles starting with a non-ASCII uppercase letter (Über, Ötzi)
-- now sort by their raw code point. Neither ordering is locale-correct; a real
-- COLLATE is the fix if anyone complains.

DROP INDEX IF EXISTS idx_movies_sort;

CREATE INDEX IF NOT EXISTS idx_movies_sort ON movies (
  catalog_id,
  number DESC,
  lower(CASE WHEN translated_title <> '' THEN translated_title ELSE original_title END),
  id
);

ALTER TABLE movies DROP COLUMN sort_title;
