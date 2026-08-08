// D1 access helpers for the AMC Worker.
//
// Kept tiny and explicit: no ORM, no query builder. Every statement is a
// prepared, parameterised D1 call so the Worker stays well under the Free-plan
// 10ms CPU budget per request.

import type {
  CatalogRow,
  CustomFieldDefRow,
  MovieRow,
  ImportResult,
} from "../amc/mapping";

export type ExtraRow = ImportResult["extras"][number];

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  ASSETS: Fetcher;
}

// --- catalogs --------------------------------------------------------------

export async function listCatalogs(env: Env, tenantId: string): Promise<CatalogRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM catalogs WHERE tenant_id = ? ORDER BY updated_at DESC`,
  )
    .bind(tenantId)
    .all<CatalogRow>();
  return results ?? [];
}

export async function getCatalog(
  env: Env,
  tenantId: string,
  id: string,
): Promise<CatalogRow | null> {
  return env.DB.prepare(`SELECT * FROM catalogs WHERE id = ? AND tenant_id = ?`)
    .bind(id, tenantId)
    .first<CatalogRow>();
}

export async function insertCatalog(env: Env, c: CatalogRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO catalogs
       (id, tenant_id, version, name, mail, site, description,
        cfp_column_settings, cfp_gui_properties, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      c.id, c.tenant_id, c.version, c.name, c.mail, c.site, c.description,
      c.cfp_column_settings, c.cfp_gui_properties, c.created_at, c.updated_at,
    )
    .run();
}

export async function touchCatalog(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE catalogs SET updated_at = ? WHERE id = ?`).bind(now, id).run();
}

// --- custom field defs -----------------------------------------------------

export async function insertCustomFieldDefs(
  env: Env,
  defs: CustomFieldDefRow[],
): Promise<void> {
  if (!defs.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO custom_field_defs
       (id, catalog_id, ordinal, tag, name, field_ext, field_type, default_value,
        media_info, multi_values, multi_values_sep, multi_values_rmp, multi_values_patch,
        excluded_in_scripts, gui_properties, list_values, list_auto_add, list_sort,
        list_auto_complete, list_use_catalog_values)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  await env.DB.batch(
    defs.map((d) =>
      stmt.bind(
        d.id, d.catalog_id, d.ordinal, d.tag, d.name, d.field_ext, d.field_type,
        d.default_value, d.media_info, d.multi_values, d.multi_values_sep,
        d.multi_values_rmp, d.multi_values_patch, d.excluded_in_scripts,
        d.gui_properties, d.list_values, d.list_auto_add, d.list_sort,
        d.list_auto_complete, d.list_use_catalog_values,
      ),
    ),
  );
}

export async function getCustomFieldDefs(
  env: Env,
  catalogId: string,
): Promise<CustomFieldDefRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM custom_field_defs WHERE catalog_id = ? ORDER BY ordinal`,
  )
    .bind(catalogId)
    .all<CustomFieldDefRow>();
  return results ?? [];
}

// --- movies ----------------------------------------------------------------

const MOVIE_COLS = [
  "id", "catalog_id", "number", "date", "date_watched", "user_rating", "rating",
  "year", "length", "video_bitrate", "audio_bitrate", "disks", "color_tag",
  "checked", "media", "media_type", "source", "borrower", "original_title",
  "translated_title", "director", "producer", "writer", "composer", "country",
  "category", "certification", "actors", "url", "description", "comments",
  "file_path", "video_format", "audio_format", "resolution", "framerate",
  "languages", "subtitles", "size", "pic_path", "poster_key", "custom_values",
  "sort_title",
] as const;

export async function insertMovies(env: Env, movies: MovieRow[]): Promise<void> {
  if (!movies.length) return;
  const placeholders = MOVIE_COLS.map(() => "?").join(",");
  const stmt = env.DB.prepare(
    `INSERT INTO movies (${MOVIE_COLS.join(",")}) VALUES (${placeholders})`,
  );
  await env.DB.batch(
    movies.map((m) => stmt.bind(...MOVIE_COLS.map((c) => (m as Record<string, unknown>)[c]))),
  );
}

export async function insertExtras(env: Env, extras: ExtraRow[]): Promise<void> {
  if (!extras.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO movie_extras
       (id, movie_id, ordinal, checked, tag, title, category, url, description,
        comments, created_by, pic_path, poster_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  await env.DB.batch(
    extras.map((e) =>
      stmt.bind(
        e.id, e.movie_id, e.ordinal, e.checked, e.tag, e.title, e.category,
        e.url, e.description, e.comments, e.created_by, e.pic_path, e.poster_key,
      ),
    ),
  );
}

export async function listMovies(env: Env, catalogId: string): Promise<MovieRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM movies WHERE catalog_id = ? ORDER BY sort_title`,
  )
    .bind(catalogId)
    .all<MovieRow>();
  return results ?? [];
}

export async function getMovie(env: Env, id: string): Promise<MovieRow | null> {
  return env.DB.prepare(`SELECT * FROM movies WHERE id = ?`).bind(id).first<MovieRow>();
}

export async function getExtras(env: Env, movieId: string): Promise<ExtraRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM movie_extras WHERE movie_id = ? ORDER BY ordinal`,
  )
    .bind(movieId)
    .all<ExtraRow>();
  return results ?? [];
}

export async function getAllExtras(env: Env, catalogId: string): Promise<ExtraRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.* FROM movie_extras e
       JOIN movies m ON m.id = e.movie_id
      WHERE m.catalog_id = ? ORDER BY e.movie_id, e.ordinal`,
  )
    .bind(catalogId)
    .all<ExtraRow>();
  return results ?? [];
}

/** Update a whitelisted set of scalar movie columns. */
export async function updateMovie(
  env: Env,
  id: string,
  patch: Partial<MovieRow>,
): Promise<void> {
  const editable = MOVIE_COLS.filter(
    (c) => c !== "id" && c !== "catalog_id" && c !== "number",
  );
  const cols = editable.filter((c) => c in patch);
  if (!cols.length) return;
  const set = cols.map((c) => `${c} = ?`).join(", ");
  await env.DB.prepare(`UPDATE movies SET ${set} WHERE id = ?`)
    .bind(...cols.map((c) => (patch as Record<string, unknown>)[c]), id)
    .run();
}

export async function deleteMovie(env: Env, id: string): Promise<void> {
  // movie_extras cascades via FK; posters in R2 are cleaned by the caller.
  await env.DB.prepare(`DELETE FROM movies WHERE id = ?`).bind(id).run();
}
