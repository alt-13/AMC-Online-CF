// AMC Online — Cloudflare Worker entry point (cf-port).
//
// Responsibilities, deliberately narrow:
//   * auth (register / login / refresh / logout) — WebCrypto, see auth.ts
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
import * as auth from "./auth";
import { encryptSecret, decryptSecret } from "./crypto";
import { searchImdb, fetchOmdb, extractTt } from "./omdb";
import { newMovieRow } from "./movie-new";
import { isBlobKey } from "../amc/posterkey";

type ExtraRow = ImportResult["extras"][number];

// --- tiny helpers ----------------------------------------------------------

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const err = (status: number, message: string): Response => json({ error: message }, status);

/** Clamp a client-supplied paging query param (`limit`/`offset`) at the D1
 *  boundary — the same reasoning as `normalizeMovieNumber` in db.ts: an
 *  untrusted numeric input must be made safe where it enters storage, not
 *  trusted downstream. Concretely: SQLite treats a negative `LIMIT` as
 *  "unlimited" (which would reopen the whole-catalog read paging exists to
 *  avoid), and a non-numeric value produces `NaN`, which is not a valid D1
 *  bind and is more likely to 500 than to fail cleanly. Anything non-finite
 *  falls back to `fallback` instead of reaching D1; anything finite is
 *  truncated to an integer and clamped to `[min, max]`. */
export function clampPagingParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(min, Math.trunc(n)), max);
}

/** Key used to encrypt/decrypt stored cloud credentials: a dedicated
 *  ENCRYPTION_SECRET if provided, else AUTH_SECRET (so existing deploys keep
 *  working, but rotating AUTH_SECRET no longer bricks saved credentials). */
const cryptoSecret = (env: Env): string => env.ENCRYPTION_SECRET || env.AUTH_SECRET;

// --- request router --------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req); // built SPA
    }
    try {
      return await route(req, env, url);
    } catch (e) {
      // Log the detail (observability is on) but don't leak internals to clients.
      console.error("unhandled route error", e);
      return err(500, "internal error");
    }
  },
};

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  const nowSec = Math.floor(Date.now() / 1000);

  // ---- public auth routes -------------------------------------------------
  if (p.startsWith("/api/auth/")) {
    return authRoute(req, env, p, m, nowSec);
  }

  // ---- everything below requires a valid access token; tenant == user id --
  const t = await auth.authenticate(env.AUTH_SECRET, req, nowSec);
  if (!t) return err(401, "unauthorized");
  // The token is validly signed, but the account it names may no longer exist
  // (DB reset in dev, user deleted). Reject here so a write never reaches a
  // FOREIGN KEY error downstream (user_cloud / user_settings REFERENCES users).
  // The client treats 401 as "session gone" and re-auths.
  if (!(await db.userExists(env, t))) return err(401, "unauthorized");

  const seg = p.split("/").filter(Boolean); // ["api", ...]

  // GET /api/poster?key=...  — stream a poster from R2 (tenant-scoped)
  if (p === "/api/poster" && m === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return err(400, "missing key");
    if (!key.startsWith(`${t}/`)) return err(403, "forbidden");
    // Legacy poster keys are reused when a poster is replaced (same movie id),
    // so those objects are NOT immutable — revalidate via ETag rather than
    // caching for a year. If-None-Match lets R2 answer 304 without re-streaming
    // the bytes. A blob key is immutable (see below), so a browser holding one
    // has no reason to ever send If-None-Match for it in the first place.
    // R2's onlyIf wants the BARE etag, not the header's quoted form (a quoted
    // value throws "Conditional ETag should not be wrapped in quotes"). Only a
    // single etag is honoured; a list or "*" just skips the conditional.
    const inm = req.headers.get("if-none-match")?.match(/^(?:W\/)?"([^"]*)"$/)?.[1];
    const obj = await env.R2.get(key, inm ? { onlyIf: { etagDoesNotMatch: inm } } : undefined);
    if (!obj) return err(404, "poster not found");
    // A content-addressed key names its own bytes, so the object can never
    // change under it — cache it for a year. Legacy per-movie keys ARE
    // overwritten in place (that is why they were uncacheable), so they keep
    // revalidating. Being wrong in the immutable direction would serve a stale
    // poster for a year, so isBlobKey is deliberately strict.
    const cache = isBlobKey(key)
      ? "private, max-age=31536000, immutable"
      : "private, max-age=0, must-revalidate";
    if (!("body" in obj) || obj.body === undefined) {
      // etag matched — R2 returned metadata only.
      return new Response(null, { status: 304, headers: { etag: obj.httpEtag, "cache-control": cache } });
    }
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "image/jpeg",
        "cache-control": cache,
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

  // GET /api/import/existing-blobs?catalogId=&cursor=
  //   Blob keys already stored for this catalog, so the browser can skip
  //   re-uploading bytes R2 already has. One R2 list page per request (1000
  //   keys) — far cheaper than a HEAD per poster.
  if (p === "/api/import/existing-blobs" && m === "GET") {
    const catalogId = url.searchParams.get("catalogId");
    if (!catalogId) return err(400, "missing catalogId");
    // Tenant scoping (rule 8): never list a prefix for a catalog this caller
    // does not own.
    const cat = await db.getCatalog(env, t, catalogId);
    if (!cat) return err(404, "catalog not found");
    const listed = await env.R2.list({
      prefix: `${t}/${cat.id}/blobs/`,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return json({
      keys: listed.objects.map((o) => o.key),
      next: listed.truncated ? listed.cursor : null,
    });
  }

  // DELETE /api/poster?key=...  — drop one poster object.
  //   Used when an in-app poster edit repoints a movie away from a LEGACY
  //   per-movie key (which only that movie could reference, so deleting it is
  //   safe). Blob keys are never deleted here: two movies with identical
  //   artwork legitimately share one hash, so superseded blobs are reclaimed by
  //   /api/catalog/:id/gc-posters instead.
  if (p === "/api/poster" && m === "DELETE") {
    const key = url.searchParams.get("key");
    if (!key) return err(400, "missing key");
    if (!key.startsWith(`${t}/`)) return err(403, "forbidden");
    if (isBlobKey(key)) return err(400, "refusing to delete a shared blob key");
    await env.R2.delete(key);
    return new Response(null, { status: 204 });
  }

  // POST /api/import/catalog — create the catalog + custom field defs
  if (p === "/api/import/catalog" && m === "POST") {
    const body = (await req.json()) as {
      catalog: CatalogRow;
      customFieldDefs: CustomFieldDefRow[];
    };
    if (body.catalog.tenant_id !== t) return err(403, "tenant mismatch");
    // Trust the server-verified catalog id for the child rows, never the body:
    // a client could otherwise point customFieldDefs at another tenant's catalog.
    const defs = (body.customFieldDefs ?? []).map((d) => ({ ...d, catalog_id: body.catalog.id }));
    await db.insertCatalog(env, body.catalog);
    await db.insertCustomFieldDefs(env, defs);
    return json({ catalogId: body.catalog.id }, 201);
  }

  // POST /api/import/custom-field-defs  { catalogId, customFieldDefs }
  //   Defs only, for the re-import path (the catalog row already exists and
  //   must keep its id, source_ref and sync bookkeeping).
  if (p === "/api/import/custom-field-defs" && m === "POST") {
    const body = (await req.json()) as {
      catalogId: string;
      customFieldDefs: CustomFieldDefRow[];
    };
    const cat = await db.getCatalog(env, t, body.catalogId);
    if (!cat) return err(404, "catalog not found");
    // Trust the server-verified id, never the body's per-def catalog_id.
    const defs = (body.customFieldDefs ?? []).map((d) => ({ ...d, catalog_id: cat.id }));
    await db.insertCustomFieldDefs(env, defs);
    return json({ inserted: defs.length });
  }

  // POST /api/import/movies?catalogId=  — one chunk of movies + their extras
  if (p === "/api/import/movies" && m === "POST") {
    const catalogId = url.searchParams.get("catalogId");
    if (!catalogId) return err(400, "missing catalogId");
    const cat = await db.getCatalog(env, t, catalogId);
    if (!cat) return err(404, "catalog not found");
    const body = (await req.json()) as { movies: MovieRow[]; extras: ExtraRow[] };
    // Pin every movie to the verified catalog and every extra to a movie in this
    // same chunk — never trust the catalog_id/movie_id the client put on the rows.
    const movies = (body.movies ?? []).map((mv) => ({ ...mv, catalog_id: cat.id }));
    const movieIds = new Set(movies.map((mv) => mv.id));
    const extras = (body.extras ?? []).filter((e) => movieIds.has(e.movie_id));
    try {
      await db.insertMovies(env, movies);
      await db.insertExtras(env, extras);
    } catch (e) {
      // Surface the real DB error instead of a generic 500 so the import UI can
      // show why (e.g. a UNIQUE constraint) rather than "internal error".
      const detail = e instanceof Error ? e.message : String(e);
      console.error("import/movies insert failed", detail);
      return err(422, `movie insert failed: ${detail}`);
    }
    await db.bumpCatalogRev(env, catalogId, Date.now());
    return json({ inserted: movies.length });
  }

  // POST /api/import/abort?catalogId=&cursor=  — roll back a failed/partial
  // import: drop the catalog rows (if the catalog row was created) and sweep
  // every R2 poster under this catalog's prefix, including ones uploaded before
  // any row existed. Always tenant-scoped (`${t}/…`), so it can only ever touch
  // the caller's data. Bounded per request: `next` is the cursor to call back
  // with, null when the prefix is clear.
  if (p === "/api/import/abort" && m === "POST") {
    const catalogId = url.searchParams.get("catalogId");
    if (!catalogId) return err(400, "missing catalogId");
    const next = await purgeCatalog(env, t, catalogId, url.searchParams.get("cursor") ?? undefined);
    return json({ next });
  }

  // GET /api/catalogs  — list this tenant's catalogs
  if (p === "/api/catalogs" && m === "GET") {
    return json(await db.listCatalogs(env, t));
  }

  // ---- cloud sync config (provider + .amc path + encrypted credential) ----
  //
  // GET returns the config WITHOUT the secret (a `hasCredential` flag instead),
  // exactly like pm's email settings. The decrypted credential is only ever
  // handed back by the explicit POST /api/cloud/connect below.
  if (p === "/api/cloud" && m === "GET") {
    const rows = await db.listUserClouds(env, t);
    return json(
      rows.map((r) => ({
        provider: r.provider,
        path: r.path,
        hasCredential: !!r.credential,
        updatedAt: r.updated_at,
      })),
    );
  }

  // PUT /api/cloud  { provider, path?, credential? }  — provider identifies the row.
  //   credential omitted / ""  -> keep the stored one
  //   credential === null       -> clear it ("forget saved login")
  //   credential is a string    -> encrypt and store it
  if (p === "/api/cloud" && m === "PUT") {
    const body = (await req.json()) as {
      provider?: string;
      path?: string;
      credential?: string | null;
    };
    const provider = body.provider;
    if (!provider) return err(400, "provider required");
    const existing = await db.getUserCloud(env, t, provider);
    let credential: string | null;
    if (body.credential === undefined || body.credential === "") {
      credential = existing?.credential ?? null;
    } else if (body.credential === null) {
      credential = null;
    } else {
      credential = await encryptSecret(body.credential, cryptoSecret(env));
    }
    const path = body.path ?? existing?.path ?? "";
    const updated_at = Date.now();
    await db.upsertUserCloud(env, { user_id: t, provider, path, credential, updated_at });
    return json({ provider, path, hasCredential: !!credential, updatedAt: updated_at });
  }

  // POST /api/cloud/connect { provider } — hand back the DECRYPTED credential so
  // the browser can log in (megajs runs in the browser, never the Worker).
  if (p === "/api/cloud/connect" && m === "POST") {
    const { provider } = (await req.json().catch(() => ({}))) as { provider?: string };
    if (!provider) return err(400, "provider required");
    const row = await db.getUserCloud(env, t, provider);
    if (!row?.credential) return err(404, "no stored credential");
    let credential: string;
    try {
      credential = await decryptSecret(row.credential, cryptoSecret(env));
    } catch {
      return err(409, "stored credential can no longer be decrypted — please reconnect and re-save it");
    }
    return json({ provider: row.provider, path: row.path, credential });
  }

  // ---- app settings (field visibility + search field + series rule) ------
  // Stored as one opaque JSON blob per user, exactly like pm's settings.json.
  // The shape mirrors AppSettings/DEFAULT_SETTINGS in frontend/fields.ts; the
  // spread below is what backfills a new key onto an existing user's blob, so
  // adding one here is all a new setting needs (no migration).
  const DEFAULT_SETTINGS = {
    field_visibility: { desktop: {}, mobile: {} },
    search_field: "",
    series_rule: { kind: "off" },
  };
  if (p === "/api/settings" && m === "GET") {
    const raw = await db.getUserSettings(env, t);
    if (!raw) return json(DEFAULT_SETTINGS);
    try {
      return json({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {
      return json(DEFAULT_SETTINGS);
    }
  }
  if (p === "/api/settings" && m === "PUT") {
    const body = await req.json();
    await db.upsertUserSettings(env, t, JSON.stringify(body), Date.now());
    return json(body);
  }

  // ---- OMDb / IMDb lookup (the only metadata source kept for the POC) ------
  // Search needs no key; fetch needs an OMDb key. The key is per-user (set in
  // Settings, encrypted at rest) so the deploy needs no OMDb secret; a global
  // env.OMDB_API_KEY still works as a fallback if an operator sets one. Both run
  // as plain fetch() in the Worker — no script runner, no transpiler.
  if (p === "/api/omdb/search" && m === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return err(400, "missing q");
    return json(await searchImdb(q));
  }

  // GET /api/omdb/key -> { hasKey } ; never returns the key itself.
  if (p === "/api/omdb/key" && m === "GET") {
    const stored = await db.getOmdbKey(env, t);
    return json({ hasKey: !!stored || !!env.OMDB_API_KEY, personal: !!stored });
  }
  // PUT /api/omdb/key { key }  — string = set, "" = keep, null = clear.
  if (p === "/api/omdb/key" && m === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { key?: string | null };
    if (body.key === undefined || body.key === "") {
      // keep existing
    } else if (body.key === null) {
      await db.setOmdbKey(env, t, null, Date.now());
    } else {
      await db.setOmdbKey(env, t, await encryptSecret(body.key.trim(), cryptoSecret(env)), Date.now());
    }
    const stored = await db.getOmdbKey(env, t);
    return json({ hasKey: !!stored || !!env.OMDB_API_KEY, personal: !!stored });
  }

  if (p === "/api/omdb/fetch" && m === "GET") {
    const arg = url.searchParams.get("i") ?? "";
    const tt = extractTt(arg);
    if (!tt) return err(400, "missing or invalid tt-id");
    // Personal key wins; fall back to a global env key if the operator set one.
    let apiKey = env.OMDB_API_KEY ?? "";
    const stored = await db.getOmdbKey(env, t);
    if (stored) {
      try {
        apiKey = await decryptSecret(stored, cryptoSecret(env));
      } catch {
        // Key unreadable (secret rotated with no ENCRYPTION_SECRET) — treat as
        // unset so the user is told to re-enter it, rather than 502'ing on OMDb.
        return err(409, "saved OMDb key can no longer be decrypted — re-enter it in Settings");
      }
    }
    if (!apiKey) return err(400, "no OMDb API key — add a free key in Settings");
    try {
      return json(await fetchOmdb(tt, apiKey));
    } catch (e) {
      return err(502, e instanceof Error ? e.message : "OMDb fetch failed");
    }
  }

  // GET /api/proxy-image?url=  — server-side image fetch so the browser can
  // re-encode a poster it otherwise can't read (IMDb CDN sends no CORS headers).
  // The browser canvas does the JPEG normalisation; the Worker is a dumb proxy.
  if (p === "/api/proxy-image" && m === "GET") {
    const src = url.searchParams.get("url") ?? "";
    let target: URL;
    try {
      target = new URL(src);
    } catch {
      return err(400, "invalid url");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return err(400, "only http(s) urls allowed");
    }
    const up = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.imdb.com/",
      },
    });
    if (!up.ok) return err(502, `image fetch failed (${up.status})`);
    // This endpoint is authenticated but still a proxy — only let images through,
    // and cap the size so it can't be used to relay arbitrary large payloads.
    const ct = up.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return err(415, "not an image");
    const len = Number(up.headers.get("content-length") ?? "0");
    const MAX_BYTES = 25 * 1024 * 1024;
    if (len > MAX_BYTES) return err(413, "image too large");
    return new Response(up.body, {
      headers: {
        "content-type": ct,
        "cache-control": "private, max-age=3600",
      },
    });
  }

  // POST /api/catalog/:id/movies  — create a blank/patched movie, next number.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "movies" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const patch = (await req.json().catch(() => ({}))) as Partial<MovieRow>;
    const num = await db.nextMovieNumber(env, cat.id);
    const row = newMovieRow(crypto.randomUUID(), cat.id, num, patch, Date.now());
    await db.insertMovies(env, [row]);
    const content_rev = await db.bumpCatalogRev(env, cat.id, Date.now());
    return json({ ...row, content_rev }, 201);
  }

  // GET /api/catalog/:id/info
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "info" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const defs = await db.getCustomFieldDefs(env, cat.id);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM movies WHERE catalog_id = ?`)
      .bind(cat.id)
      .first<{ n: number }>();
    return json({
      ...cat,
      movie_count: count?.n ?? 0,
      custom_field_defs: defs,
      // Movies written since the last successful push. Rows predating the
      // updated_at column read NULL and correctly do not count.
      touched_since_sync: await db.countMoviesTouchedSince(env, cat.id, cat.last_sync_at ?? 0),
    });
  }

  // GET /api/catalog/:id/movies?limit=&offset=  — one page of grid metadata.
  // Always bounded so a huge catalog can't blow the D1 response / Worker memory;
  // the client walks pages using `total`. Defaults to a full first page.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "movies" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const MAX = 1000;
    const limit = Math.min(MAX, Math.max(1, Number(url.searchParams.get("limit")) || 500));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const [movies, total] = await Promise.all([
      db.listMovies(env, cat.id, { limit, offset }),
      db.countMovies(env, cat.id),
    ]);
    return json({ movies, total, limit, offset });
  }

  // DELETE /api/catalog/:id?cursor=  — drop a catalog, its rows, and its R2
  //   posters. Bounded per request: `next` is the cursor to call back with,
  //   null when the sweep is done.
  //
  //   The ownership check runs on the FIRST call only. A continuation has no
  //   catalog row left to check — it is the same tenant-rooted prefix sweep,
  //   which is what enforces rule 8 here, and it is also how `supersede` hands
  //   its leftover prefixes back to the browser to finish.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[2] && !seg[3] && m === "DELETE") {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!cursor && !(await db.getCatalog(env, t, seg[2]))) return err(404, "catalog not found");
    return json({ next: await purgeCatalog(env, t, seg[2], cursor) });
  }

  // POST /api/catalog/:id/supersede  — after a cloud re-pull finishes, drop every
  // OTHER catalog that shares this one's source_ref (the older copies of the same
  // .amc). Runs only once the new import is complete, so a failed pull never
  // destroys the previous copy — worst case you briefly keep a duplicate.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "supersede" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    if (!cat.source_ref) return json({ superseded: 0 });
    const dupes = await db.catalogsBySource(env, t, cat.source_ref);
    // Rows go now (cheap, and what the UI reads). The R2 sweep is bounded like
    // every other one, so a dupe with more objects than one request can clear
    // comes back in `pending`; the browser finishes it via DELETE
    // /api/catalog/:id?cursor=.
    const pending: Array<{ id: string; cursor: string }> = [];
    let superseded = 0;
    for (const d of dupes) {
      if (d.id === cat.id) continue;
      const next = await purgeCatalog(env, t, d.id);
      if (next) pending.push({ id: d.id, cursor: next });
      superseded += 1;
    }
    return json({ superseded, pending });
  }

  // POST /api/catalog/:id/reimport-begin
  //   Clear a catalog's contents so a fresh .amc can be imported INTO it,
  //   keeping the catalog id, its source_ref and its sync bookkeeping.
  //
  //   Deliberately keeps everything under blobs/: those objects are content-
  //   addressed, so the incoming import will re-reference most of them and the
  //   dedup probe can skip re-uploading them. That is the whole reason a
  //   re-import is cheap. Legacy per-movie objects ARE swept, since nothing
  //   will reference them again.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "reimport-begin" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    // movies cascade to movie_extras; defs cascade from the catalog, so delete
    // them explicitly (the catalog row itself must survive).
    const cursor = url.searchParams.get("cursor") ?? undefined;
    // Rows go on the first call only; a continuation is a pure R2 sweep.
    if (!cursor) await db.deleteCatalogContents(env, cat.id);
    const blobs = `${t}/${cat.id}/blobs/`;
    const next = await sweepPrefix(env, `${t}/${cat.id}/`, cursor, (k) => k.startsWith(blobs));
    return json({ ok: true, next });
  }

  // POST /api/catalog/:id/gc-posters?cursor=
  //   Reclaim superseded poster blobs. Content addressing means a changed
  //   poster writes a NEW key and leaves the old object behind (it may be shared
  //   by identical artwork, so no write path may delete it) — this is where they
  //   go.
  //
  //   One R2 list page per request, cursor returned for the browser to loop:
  //   a catalog can hold thousands of objects and a Worker has ~10 ms of CPU.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "gc-posters" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const referenced = await db.referencedPosterKeys(env, cat.id);
    const blobs = `${t}/${cat.id}/blobs/`;
    // An import PUTs blobs BEFORE committing the rows that reference them, so a
    // concurrent import would look like an orphan. Never touch anything recent.
    const cutoff = Date.now() - 60 * 60 * 1000;
    const listed = await env.R2.list({
      prefix: blobs,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    const stale = listed.objects
      .filter((o) => !referenced.has(o.key) && o.uploaded.getTime() < cutoff)
      .map((o) => o.key);
    if (stale.length) await env.R2.delete(stale);
    return json({
      deleted: stale.length,
      scanned: listed.objects.length,
      next: listed.truncated ? listed.cursor : null,
    });
  }

  // POST /api/catalog/:id/source-ref  { source_ref } — adopt a cloud origin for a
  // catalog that had none (first push of a direct-upload library to the cloud).
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "source-ref" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const { source_ref } = (await req.json().catch(() => ({}))) as { source_ref?: string };
    if (!source_ref) return err(400, "source_ref required");
    await db.setCatalogSourceRef(env, cat.id, source_ref, Date.now());
    return json({ id: cat.id, source_ref });
  }

  // POST /api/catalog/:id/sync-state  — record the outcome of a push.
  //   The BROWSER computes the fingerprint (it is the only side that runs
  //   megajs and holds the bytes), so it tells us; we just store it. Setting
  //   remote_state = 'match' here is not a guess: we just wrote that file and
  //   know its identity, so no re-check is needed.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "sync-state" && m === "POST") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const b = (await req.json().catch(() => ({}))) as Partial<{
      synced_rev: number;
      content_hash: string;
      remote_fingerprint: string;
      remote_size: number;
    }>;
    if (
      typeof b.synced_rev !== "number" ||
      typeof b.content_hash !== "string" ||
      typeof b.remote_fingerprint !== "string" ||
      typeof b.remote_size !== "number"
    ) {
      return err(400, "synced_rev, content_hash, remote_fingerprint and remote_size required");
    }
    await db.setSyncState(env, cat.id, {
      synced_rev: b.synced_rev,
      content_hash: b.content_hash,
      remote_fingerprint: b.remote_fingerprint,
      remote_size: b.remote_size,
      last_sync_at: Date.now(),
    });
    return json({ ok: true });
  }

  // POST /api/catalogs/remote-state  — batch-record remote check verdicts.
  //   One Mega login covers every catalog, so the whole pass lands in one
  //   request and one D1 batch. The UPDATE is filtered on tenant_id, so an id
  //   the caller does not own simply matches no row (rule 8).
  if (p === "/api/catalogs/remote-state" && m === "POST") {
    const b = (await req.json().catch(() => ({}))) as {
      states?: Array<{
        id?: unknown; state?: unknown;
        remote_fingerprint?: unknown; remote_size?: unknown;
      }>;
    };
    const input = Array.isArray(b.states) ? b.states : null;
    if (!input) return err(400, "states array required");
    const allowed = new Set(["match", "differs", "missing"]);
    const checked_at = Date.now();
    const rows = [];
    for (const s of input) {
      if (typeof s.id !== "string" || typeof s.state !== "string" || !allowed.has(s.state)) {
        return err(400, "each state needs an id and one of match|differs|missing");
      }
      rows.push({
        id: s.id,
        state: s.state,
        checked_at,
        remote_fingerprint: typeof s.remote_fingerprint === "string" ? s.remote_fingerprint : null,
        remote_size: typeof s.remote_size === "number" ? s.remote_size : null,
      });
    }
    await db.setRemoteStates(env, t, rows);
    return json({ updated: rows.length });
  }

  // GET /api/catalog/:id/export  — the row bundle for the browser rebuild.
  //
  // Three shapes, and only these three — a bare/unrecognised `part` is
  // rejected rather than served:
  //   ?part=meta                      -> catalog + defs + row counts (+ content_rev)
  //   ?part=movies&limit=&offset=     -> one page of movies
  //   ?part=extras&limit=&offset=     -> one page of extras
  //
  // The parts exist so the browser can fetch pages CONCURRENTLY (see
  // browser/export.ts). There used to be a fourth, unparameterised shape that
  // looped the same queries serially inside a single request to build the
  // whole bundle at once — exactly the unbounded whole-catalog read this
  // paging was added to get away from (see CLAUDE.md rule 7: a Worker request
  // must never load more than a handful of rows). It had no caller — the only
  // consumer is browser/export.ts, and it always sends a `part` — so it was
  // removed rather than kept "just in case".
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "export" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const PAGE = 500;
    const part = url.searchParams.get("part");
    const limit = clampPagingParam(url.searchParams.get("limit"), PAGE, 1, PAGE);
    const offset = clampPagingParam(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    if (part === "meta") {
      return json({
        catalog: cat,
        customFieldDefs: await db.getCustomFieldDefs(env, cat.id),
        movieCount: await db.countMovies(env, cat.id),
        extraCount: await db.countExtras(env, cat.id),
        // The revision this bundle was read at. A push records THIS as
        // synced_rev, so an edit made during a multi-minute upload stays
        // pending instead of being silently marked synced.
        content_rev: cat.content_rev,
      });
    }
    if (part === "movies") {
      return json(await db.listMovies(env, cat.id, { limit, offset }));
    }
    if (part === "extras") {
      return json(await db.getAllExtras(env, cat.id, { limit, offset }));
    }
    return err(400, "part must be one of: meta, movies, extras");
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
      const body = (await req.json()) as Partial<MovieRow> & { extras?: Array<Partial<ExtraRow>> };
      // Extras (if present) are handled separately — updateMovie whitelists movie
      // columns, so an `extras` key would be ignored, but strip it to be explicit.
      const extrasInput = body.extras;
      delete (body as { extras?: unknown }).extras;
      const patch = body as Partial<MovieRow>;
      await db.updateMovie(env, id, patch);

      // Replace-all extras when the client sends the set. Ordinals follow array
      // order; ids/poster_key/pic_path round-trip so existing extra posters are
      // preserved. Posters orphaned by a removed extra are swept from R2.
      if (Array.isArray(extrasInput)) {
        const old = await db.getExtras(env, id);
        const rows: ExtraRow[] = extrasInput.map((e, i) => ({
          id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
          movie_id: id,
          ordinal: i,
          checked: e.checked ? 1 : 0,
          tag: String(e.tag ?? ""),
          title: String(e.title ?? ""),
          category: String(e.category ?? ""),
          url: String(e.url ?? ""),
          description: String(e.description ?? ""),
          comments: String(e.comments ?? ""),
          created_by: String(e.created_by ?? ""),
          pic_path: String(e.pic_path ?? ""),
          poster_key: typeof e.poster_key === "string" ? e.poster_key : null,
        }));
        await db.replaceExtras(env, id, rows);
        const kept = new Set(rows.map((r) => r.poster_key).filter((k): k is string => !!k));
        const orphans = old
          .map((e) => e.poster_key)
          .filter((k): k is string => !!k && !kept.has(k));
        if (orphans.length) await env.R2.delete(orphans);
      }

      const content_rev = await db.bumpCatalogRev(env, movie.catalog_id, Date.now());
      const updated = await db.getMovie(env, id);
      const extras = await db.getExtras(env, id);
      // content_rev rides along so the workspace's sync button tracks the
      // counter without a second request.
      return json({ ...updated, extras, content_rev });
    }
    if (m === "DELETE") {
      const movie = await ownedMovie(env, t, id);
      if (!movie) return err(404, "movie not found");
      if (movie.poster_key) await env.R2.delete(movie.poster_key);
      const extras = await db.getExtras(env, id);
      const keys = extras.map((e) => e.poster_key).filter((k): k is string => !!k);
      if (keys.length) await env.R2.delete(keys);
      await db.deleteMovie(env, id);
      const content_rev = await db.bumpCatalogRev(env, movie.catalog_id, Date.now());
      return json({ content_rev });
    }
  }

  return err(404, "not found");
}

// --- auth routes -----------------------------------------------------------

async function authRoute(
  req: Request,
  env: Env,
  p: string,
  m: string,
  nowSec: number,
): Promise<Response> {
  // GET /api/auth/status  -> { needs_setup }  (public; no account yet == first run)
  if (p === "/api/auth/status" && m === "GET") {
    return json({ needs_setup: (await db.countUsers(env)) === 0 });
  }

  // POST /api/auth/register  { email, password }
  // pm-style bootstrap: registration is ONLY open on first run (no user yet).
  // This is a single-operator self-host — one CF account == one user — so once
  // that account exists the door closes and everyone else just logs in.
  if (p === "/api/auth/register" && m === "POST") {
    if ((await db.countUsers(env)) > 0) return err(403, "registration is closed");
    const { email, password } = (await req.json()) as { email?: string; password?: string };
    if (!email || !password || password.length < 8) {
      return err(400, "email and password (min 8 chars) required");
    }
    if (await db.getUserByEmail(env, email)) return err(409, "email already registered");
    const user: db.UserRow = {
      id: crypto.randomUUID(),
      email: email.trim(),
      email_lower: email.trim().toLowerCase(),
      password_hash: await auth.hashPassword(password),
      created_at: Date.now(),
    };
    await db.insertUser(env, user);
    return issueTokens(env, user.id, nowSec, 201);
  }

  // POST /api/auth/login  { username|email, password }
  if (p === "/api/auth/login" && m === "POST") {
    const body = (await req.json()) as { email?: string; username?: string; password?: string };
    const email = body.email ?? body.username ?? "";
    const user = await db.getUserByEmail(env, email);
    // Verify even on unknown user to keep timing uniform.
    const ok = user
      ? await auth.verifyPassword(body.password ?? "", user.password_hash)
      : await auth.verifyPassword(body.password ?? "", DUMMY_HASH);
    if (!user || !ok) return err(401, "invalid credentials");
    return issueTokens(env, user.id, nowSec);
  }

  // POST /api/auth/refresh  (refresh token in httpOnly cookie)
  if (p === "/api/auth/refresh" && m === "POST") {
    const token = auth.readRefreshCookie(req);
    if (!token) return err(401, "no session");
    const payload = await auth.verifyJwt(env.AUTH_SECRET, token, "refresh", nowSec);
    if (!payload) return err(401, "invalid session");
    // The refresh token is valid but its account is gone — clear the cookie so
    // the browser stops presenting a ghost session (otherwise the gate's 401 →
    // refresh → 401 would loop), and force a fresh login.
    if (!(await db.userExists(env, payload.sub))) {
      return json({ error: "invalid session" }, 401, { "set-cookie": auth.clearRefreshCookie() });
    }
    // Rotate: hand back a fresh access token (and slide the refresh cookie).
    return issueTokens(env, payload.sub, nowSec);
  }

  // POST /api/auth/logout
  if (p === "/api/auth/logout" && m === "POST") {
    return json({ ok: true }, 200, { "set-cookie": auth.clearRefreshCookie() });
  }

  return err(404, "not found");
}

async function issueTokens(env: Env, userId: string, nowSec: number, status = 200): Promise<Response> {
  const [access, refresh] = await Promise.all([
    auth.createAccessToken(env.AUTH_SECRET, userId, nowSec),
    auth.createRefreshToken(env.AUTH_SECRET, userId, nowSec),
  ]);
  return json({ access_token: access, tenant_id: userId }, status, {
    "set-cookie": auth.refreshCookie(refresh),
  });
}

/** A valid-format hash so login timing is identical for unknown emails. */
const DUMMY_HASH =
  "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * R2 list pages swept per request. A page is up to 1000 keys, so one request
 * clears ~4000 objects — more than any normal catalog holds, while still
 * bounding the work a single Worker request can do (rule 7). Every sweeping
 * route returns the cursor it stopped at and the browser loops until null.
 */
const SWEEP_PAGES = 4;

/**
 * Delete R2 objects under `prefix`, at most SWEEP_PAGES list pages per call.
 * Returns the cursor to resume from, or null once the prefix is exhausted.
 * `keep` (optional) spares the keys it matches — the re-import path keeps
 * everything under `blobs/`.
 *
 * Callers must pass a `${tenantId}/`-rooted prefix; that is what makes this
 * safe without a row-level ownership check (rule 8), which matters because the
 * catalog row is already gone by the time the sweep is resumed.
 */
async function sweepPrefix(
  env: Env,
  prefix: string,
  cursor: string | undefined,
  keep?: (key: string) => boolean,
): Promise<string | null> {
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const listed = await env.R2.list({ prefix, cursor });
    const doomed = listed.objects.map((o) => o.key).filter((k) => !keep?.(k));
    if (doomed.length) await env.R2.delete(doomed);
    if (!listed.truncated) return null;
    cursor = listed.cursor;
  }
  return cursor ?? null;
}

/**
 * Drop a catalog's rows (movies/defs/extras cascade) and sweep its R2 posters —
 * including posters uploaded before any row existed. The row delete happens on
 * the FIRST call only (`cursor` undefined); later calls just continue the
 * sweep. Returns the cursor to resume from, or null when nothing is left.
 *
 * Idempotent, and the `${tenantId}/` prefix means it can only ever touch the
 * caller's own objects.
 */
async function purgeCatalog(
  env: Env,
  tenantId: string,
  catalogId: string,
  cursor?: string,
): Promise<string | null> {
  if (!cursor) {
    const cat = await db.getCatalog(env, tenantId, catalogId);
    if (cat) await db.deleteCatalog(env, cat.id);
  }
  return sweepPrefix(env, `${tenantId}/${catalogId}/`, cursor);
}

/** Fetch a movie only if it belongs to a catalog owned by this tenant. */
async function ownedMovie(env: Env, tenantId: string, id: string): Promise<MovieRow | null> {
  const movie = await db.getMovie(env, id);
  if (!movie) return null;
  const cat = await db.getCatalog(env, tenantId, movie.catalog_id);
  return cat ? movie : null;
}
