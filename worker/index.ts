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

type ExtraRow = ImportResult["extras"][number];

// --- tiny helpers ----------------------------------------------------------

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const err = (status: number, message: string): Response => json({ error: message }, status);

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
      return err(500, e instanceof Error ? e.message : "internal error");
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

  const seg = p.split("/").filter(Boolean); // ["api", ...]

  // GET /api/poster?key=...  — stream a poster from R2 (tenant-scoped)
  if (p === "/api/poster" && m === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return err(400, "missing key");
    if (!key.startsWith(`${t}/`)) return err(403, "forbidden");
    const obj = await env.R2.get(key);
    if (!obj) return err(404, "poster not found");
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "image/jpeg",
        "cache-control": "private, max-age=31536000, immutable",
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
    await db.touchCatalog(env, catalogId, Date.now());
    return json({ inserted: body.movies.length });
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
    const row = await db.getUserCloud(env, t);
    return json({
      provider: row?.provider ?? "mega",
      path: row?.path ?? "",
      hasCredential: !!row?.credential,
    });
  }

  // PUT /api/cloud  { provider?, path?, credential? }
  //   credential omitted / ""  -> keep the stored one (pm's "empty = keep")
  //   credential === null       -> clear it ("forget saved login")
  //   credential is a string    -> encrypt and store it
  if (p === "/api/cloud" && m === "PUT") {
    const body = (await req.json()) as {
      provider?: string;
      path?: string;
      credential?: string | null;
    };
    const existing = await db.getUserCloud(env, t);
    let credential: string | null;
    if (body.credential === undefined || body.credential === "") {
      credential = existing?.credential ?? null;
    } else if (body.credential === null) {
      credential = null;
    } else {
      credential = await encryptSecret(body.credential, env.AUTH_SECRET);
    }
    const provider = body.provider ?? existing?.provider ?? "mega";
    const path = body.path ?? existing?.path ?? "";
    await db.upsertUserCloud(env, {
      user_id: t,
      provider,
      path,
      credential,
      updated_at: Date.now(),
    });
    return json({ provider, path, hasCredential: !!credential });
  }

  // POST /api/cloud/connect — hand back the DECRYPTED credential so the browser
  // can log in to the provider (megajs runs in the browser, never the Worker).
  // Access-token gated; 404 when nothing is stored.
  if (p === "/api/cloud/connect" && m === "POST") {
    const row = await db.getUserCloud(env, t);
    if (!row?.credential) return err(404, "no stored credential");
    const credential = await decryptSecret(row.credential, env.AUTH_SECRET);
    return json({ provider: row.provider, path: row.path, credential });
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

/** Fetch a movie only if it belongs to a catalog owned by this tenant. */
async function ownedMovie(env: Env, tenantId: string, id: string): Promise<MovieRow | null> {
  const movie = await db.getMovie(env, id);
  if (!movie) return null;
  const cat = await db.getCatalog(env, tenantId, movie.catalog_id);
  return cat ? movie : null;
}
