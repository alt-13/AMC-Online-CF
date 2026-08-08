// AMC Online — Cloudflare Worker entry point (cf-port).
//
// Responsibilities, deliberately narrow:
//   * CRUD over D1 (catalog / movies / extras metadata)
//   * store & stream posters from R2
//   * accept an import commit (rows produced in the browser)
//   * hand back an export bundle (rows + poster keys) for the browser to rebuild
//
// The binary .amc parse/serialize NEVER runs here — it runs in the browser
// (see ../browser). That is what keeps a request's memory footprint to a few
// rows + at most one poster, dissolving the 128 MB in-memory-catalog problem.

import type { Env } from "./db";
import type { CatalogRow, CustomFieldDefRow, MovieRow, ImportResult } from "../amc/mapping";
import * as db from "./db";

type ExtraRow = ImportResult["extras"][number];

// --- tiny helpers ----------------------------------------------------------

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const err = (status: number, message: string): Response => json({ error: message }, status);

/**
 * Tenant resolution. The auth layer is not yet ported (see CF-PORT.md); until
 * it is, the tenant comes from a header so the multi-tenant data model can be
 * exercised end-to-end. Swap this for a verified JWT `sub` claim.
 */
function tenant(req: Request): string {
  return req.headers.get("x-tenant-id") || "default";
}

// --- request router --------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (!pathname.startsWith("/api/")) {
      // Static SPA assets (built frontend) — configured in wrangler.jsonc.
      return env.ASSETS.fetch(req);
    }

    try {
      return await route(req, env, url);
    } catch (e) {
      return err(500, e instanceof Error ? e.message : "internal error");
    }
  },
};

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  const t = tenant(req);
  const seg = p.split("/").filter(Boolean); // ["api", ...]

  // GET /api/poster?key=...  — stream a poster from R2
  if (p === "/api/poster" && m === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return err(400, "missing key");
    const obj = await env.R2.get(key);
    if (!obj) return err(404, "poster not found");
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
        etag: obj.httpEtag,
      },
    });
  }

  // PUT /api/import/poster   — browser uploads one poster (raw body, key in header)
  if (p === "/api/import/poster" && m === "PUT") {
    const key = req.headers.get("x-poster-key");
    if (!key || !key.startsWith(`${t}/`)) return err(400, "bad or missing x-poster-key");
    const bytes = new Uint8Array(await req.arrayBuffer());
    await env.R2.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return json({ key });
  }

  // POST /api/import/catalog — create the catalog + custom field defs
  if (p === "/api/import/catalog" && m === "POST") {
    const body = (await req.json()) as {
      catalog: CatalogRow;
      customFieldDefs: CustomFieldDefRow[];
    };
    if (body.catalog.tenant_id !== t) return err(403, "tenant mismatch");
    await db.insertCatalog(env, body.catalog);
    await db.insertCustomFieldDefs(env, body.customFieldDefs);
    return json({ catalogId: body.catalog.id }, 201);
  }

  // POST /api/import/movies?catalogId=  — one chunk of movies + their extras
  if (p === "/api/import/movies" && m === "POST") {
    const catalogId = url.searchParams.get("catalogId");
    if (!catalogId) return err(400, "missing catalogId");
    const cat = await db.getCatalog(env, t, catalogId);
    if (!cat) return err(404, "catalog not found");
    const body = (await req.json()) as { movies: MovieRow[]; extras: ExtraRow[] };
    await db.insertMovies(env, body.movies);
    await db.insertExtras(env, body.extras);
    await db.touchCatalog(env, catalogId, cat.updated_at);
    return json({ inserted: body.movies.length });
  }

  // GET /api/catalogs  — list this tenant's catalogs
  if (p === "/api/catalogs" && m === "GET") {
    return json(await db.listCatalogs(env, t));
  }

  // GET /api/catalog/:id/info
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "info" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const defs = await db.getCustomFieldDefs(env, cat.id);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM movies WHERE catalog_id = ?`)
      .bind(cat.id)
      .first<{ n: number }>();
    return json({ ...cat, movie_count: count?.n ?? 0, custom_field_defs: defs });
  }

  // GET /api/catalog/:id/movies  — list metadata for the movie grid
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "movies" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    return json(await db.listMovies(env, cat.id));
  }

  // GET /api/catalog/:id/export  — full row bundle for the browser rebuild
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "export" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const [customFieldDefs, movies, extras] = await Promise.all([
      db.getCustomFieldDefs(env, cat.id),
      db.listMovies(env, cat.id),
      db.getAllExtras(env, cat.id),
    ]);
    return json({ catalog: cat, customFieldDefs, movies, extras });
  }

  // Movie item routes: /api/movies/:id
  if (seg[0] === "api" && seg[1] === "movies" && seg[2]) {
    const id = seg[2];
    if (m === "GET") {
      const movie = await ownedMovie(env, t, id);
      if (!movie) return err(404, "movie not found");
      const extras = await db.getExtras(env, id);
      return json({ ...movie, extras });
    }
    if (m === "PUT") {
      const movie = await ownedMovie(env, t, id);
      if (!movie) return err(404, "movie not found");
      const patch = (await req.json()) as Partial<MovieRow>;
      await db.updateMovie(env, id, patch);
      const updated = await db.getMovie(env, id);
      return json(updated);
    }
    if (m === "DELETE") {
      const movie = await ownedMovie(env, t, id);
      if (!movie) return err(404, "movie not found");
      if (movie.poster_key) await env.R2.delete(movie.poster_key);
      const extras = await db.getExtras(env, id);
      const keys = extras.map((e) => e.poster_key).filter((k): k is string => !!k);
      if (keys.length) await env.R2.delete(keys);
      await db.deleteMovie(env, id);
      return new Response(null, { status: 204 });
    }
  }

  return err(404, "not found");
}

/** Fetch a movie only if it belongs to a catalog owned by this tenant. */
async function ownedMovie(env: Env, tenantId: string, id: string): Promise<MovieRow | null> {
  const movie = await db.getMovie(env, id);
  if (!movie) return null;
  const cat = await db.getCatalog(env, tenantId, movie.catalog_id);
  return cat ? movie : null;
}
