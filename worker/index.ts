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
    const inm = req.headers.get("if-none-match");
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

  // POST /api/import/abort?catalogId=  — roll back a failed/partial import: drop
  // the catalog rows (if the catalog row was created) and sweep every R2 poster
  // under this catalog's prefix, including ones uploaded before any row existed.
  // Always tenant-scoped (`${t}/…`), so it can only ever touch the caller's data.
  if (p === "/api/import/abort" && m === "POST") {
    const catalogId = url.searchParams.get("catalogId");
    if (!catalogId) return err(400, "missing catalogId");
    await purgeCatalog(env, t, catalogId);
    return new Response(null, { status: 204 });
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
    return json({ ...cat, movie_count: count?.n ?? 0, custom_field_defs: defs });
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

  // DELETE /api/catalog/:id  — drop a catalog, its rows, and its R2 posters.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[2] && !seg[3] && m === "DELETE") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    await purgeCatalog(env, t, cat.id);
    return new Response(null, { status: 204 });
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
    let superseded = 0;
    for (const d of dupes) {
      if (d.id === cat.id) continue;
      await purgeCatalog(env, t, d.id);
      superseded += 1;
    }
    return json({ superseded });
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

  // GET /api/catalog/:id/export  — full row bundle for the browser rebuild.
  // Reads movies + extras in bounded pages (never one unbounded query) and
  // reassembles the whole set the export format needs.
  if (seg[0] === "api" && seg[1] === "catalog" && seg[3] === "export" && m === "GET") {
    const cat = await db.getCatalog(env, t, seg[2]);
    if (!cat) return err(404, "catalog not found");
    const PAGE = 500;
    const customFieldDefs = await db.getCustomFieldDefs(env, cat.id);
    const movies: MovieRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const chunk = await db.listMovies(env, cat.id, { limit: PAGE, offset });
      movies.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    const extras: ExtraRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const chunk = await db.getAllExtras(env, cat.id, { limit: PAGE, offset });
      extras.push(...chunk);
      if (chunk.length < PAGE) break;
    }
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
      const body = (await req.json()) as Partial<MovieRow> & { extras?: Array<Partial<ExtraRow>> };
      // Extras (if present) are handled separately — updateMovie whitelists movie
      // columns, so an `extras` key would be ignored, but strip it to be explicit.
      const extrasInput = body.extras;
      delete (body as { extras?: unknown }).extras;
      const patch = body as Partial<MovieRow>;
      // Keep sort_title consistent with the titles even for clients that don't
      // send it (the grid orders by it). Derive from the patch overlaid on the row.
      if (("original_title" in patch || "translated_title" in patch) && !("sort_title" in patch)) {
        const translated = patch.translated_title ?? movie.translated_title;
        const original = patch.original_title ?? movie.original_title;
        patch.sort_title = (translated || original).toLowerCase();
      }
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
 * Drop a catalog's rows (movies/defs/extras cascade) and sweep every R2 poster
 * under its tenant-scoped prefix — including posters uploaded before any row
 * existed. Idempotent, and the `${tenantId}/` prefix means it can only ever
 * touch the caller's own objects.
 */
async function purgeCatalog(env: Env, tenantId: string, catalogId: string): Promise<void> {
  const cat = await db.getCatalog(env, tenantId, catalogId);
  if (cat) await db.deleteCatalog(env, cat.id);
  const prefix = `${tenantId}/${catalogId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix, cursor });
    if (listed.objects.length) await env.R2.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Fetch a movie only if it belongs to a catalog owned by this tenant. */
async function ownedMovie(env: Env, tenantId: string, id: string): Promise<MovieRow | null> {
  const movie = await db.getMovie(env, id);
  if (!movie) return null;
  const cat = await db.getCatalog(env, tenantId, movie.catalog_id);
  return cat ? movie : null;
}
