// CF frontend API client — the thin bits around the browser import/export glue.
//
// import.ts / export.ts already own the heavy binary flows; this covers the
// plain metadata calls (list catalogs, catalog info, movie CRUD) so a Vue app
// can drive the whole port from one module.

import type { CatalogRow, CustomFieldDefRow, MovieRow } from "../amc/mapping";

export type { CatalogRow, CustomFieldDefRow, MovieRow };
export { importAmcFile } from "../browser/import";
export { exportAmcFile, downloadAmcFile } from "../browser/export";

// --- session (tenant + auth header) ----------------------------------------
//
// Until the auth layer lands this is an x-tenant-id header stub. Wire
// setSession() to your login flow: pass the JWT and the tenant it resolves to.

let _tenantId = "default";
let _authHeader: string | undefined;

export function setSession(tenantId: string, authHeader?: string): void {
  _tenantId = tenantId;
  _authHeader = authHeader;
}

/**
 * Options object the import/export helpers expect.
 *
 * `fetcher` matters: import/export are the two LONG flows (one request per
 * poster), so they can easily outlive the ~1h access token. Handing them the
 * live `authedFetch` — rather than only the token string, which would be frozen
 * at call time — means each of their requests reads the current token and
 * transparently refreshes on a 401 instead of failing halfway through.
 */
export function session(): {
  tenantId: string;
  authHeader?: string;
  fetcher: AuthedFetch;
} {
  return { tenantId: _tenantId, authHeader: _authHeader, fetcher: authedFetch };
}

// --- auth ------------------------------------------------------------------
//
// register/login return { access_token, tenant_id } and set an httpOnly refresh
// cookie (scoped to /api/auth). We stash the access token in-memory and mirror
// it into the session so import/export/CRUD all authenticate. The refresh
// cookie survives a reload; call restoreSession() on app boot to swap it for a
// fresh access token without re-prompting.

interface AuthResponse {
  access_token: string;
  tenant_id: string;
}

async function authPost(path: string, body?: unknown): Promise<AuthResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include", // send/receive the refresh cookie
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${path} -> ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<AuthResponse>;
}

function adoptSession(r: AuthResponse): AuthResponse {
  setSession(r.tenant_id, `Bearer ${r.access_token}`);
  return r;
}

export const auth = {
  /** First-run probe: true when no account exists yet, so the gate should offer
   *  "create account" instead of "sign in". Mirrors pm's `/setup`. Fails closed
   *  (false → show login) if the endpoint is unreachable. */
  needsSetup: async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "include" });
      if (!res.ok) return false;
      const j = (await res.json()) as { needs_setup?: boolean };
      return j.needs_setup === true;
    } catch {
      return false;
    }
  },

  register: (email: string, password: string) =>
    authPost("/api/auth/register", { email, password }).then(adoptSession),

  login: (emailOrUsername: string, password: string) =>
    authPost("/api/auth/login", { email: emailOrUsername, password }).then(adoptSession),

  /** Swap the httpOnly refresh cookie for a fresh access token. Returns false
   *  when there is no valid session (fresh visitor or expired refresh). */
  restoreSession: async (): Promise<boolean> => {
    try {
      adoptSession(await authPost("/api/auth/refresh"));
      return true;
    } catch {
      return false;
    }
  },

  logout: async (): Promise<void> => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      setSession("default", undefined);
    }
  },

  isAuthenticated: (): boolean => _authHeader !== undefined,
};

function headers(extra: Record<string, string> = {}): HeadersInit {
  const h: Record<string, string> = { "x-tenant-id": _tenantId, ...extra };
  if (_authHeader) h.authorization = _authHeader;
  return h;
}

// The access token lives ~1h; on a 401 we transparently swap the httpOnly
// refresh cookie for a fresh token (once, deduped across concurrent calls) and
// retry, so a tab left open past the TTL keeps working instead of erroring out.
let refreshing: Promise<boolean> | null = null;

/** fetch() that adds the current auth headers and retries once after a refresh. */
export type AuthedFetch = (
  path: string,
  init?: RequestInit,
  extra?: Record<string, string>,
) => Promise<Response>;

async function authedFetch(path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<Response> {
  const send = () => fetch(path, { ...init, headers: headers(extra) });
  let res = await send();
  if (res.status === 401 && _authHeader) {
    refreshing ??= auth.restoreSession().finally(() => (refreshing = null));
    if (await refreshing) res = await send();
  }
  return res;
}

async function jget<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/** Re-encode any browser-decodable image blob to JPEG bytes via a canvas.
 *  A passthrough for images already JPEG would still need decoding to strip
 *  odd color profiles, so we always round-trip through the canvas. */
async function toJpeg(blob: Blob, quality = 0.9): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

// --- catalog + movie metadata ----------------------------------------------

export interface CatalogInfo extends CatalogRow {
  movie_count: number;
  custom_field_defs: CustomFieldDefRow[];
}

/** One "extra" record attached to a movie (behind-the-scenes clips, trailers…).
 *  The editor manages the text fields + `checked`; `id`/`ordinal`/`pic_path`/
 *  `poster_key` round-trip so the Worker preserves an extra's existing poster. */
export interface Extra {
  id?: string;
  ordinal?: number;
  checked: number;
  tag: string;
  title: string;
  category: string;
  url: string;
  description: string;
  comments: string;
  created_by: string;
  pic_path?: string;
  poster_key?: string | null;
}

export const cf = {
  listCatalogs: () => jget<CatalogRow[]>("/api/catalogs"),

  catalogInfo: (id: string) => jget<CatalogInfo>(`/api/catalog/${encodeURIComponent(id)}/info`),

  // Walk the server's bounded pages and return the full list, so callers keep the
  // simple "all movies in memory" model (instant client-side search) while the
  // Worker never runs one unbounded query.
  listMovies: async (
    id: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<MovieRow[]> => {
    const PAGE = 500;
    const all: MovieRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await jget<{ movies: MovieRow[]; total: number }>(
        `/api/catalog/${encodeURIComponent(id)}/movies?limit=${PAGE}&offset=${offset}`,
      );
      all.push(...res.movies);
      onProgress?.(all.length, res.total);
      if (res.movies.length < PAGE || all.length >= res.total) break;
    }
    return all;
  },

  getMovie: (id: string) => jget<MovieRow & { extras: Extra[] }>(`/api/movies/${encodeURIComponent(id)}`),

  updateMovie: async (
    id: string,
    patch: Partial<MovieRow> & { extras?: Extra[] },
  ): Promise<MovieRow & { extras: Extra[] }> => {
    const res = await authedFetch(`/api/movies/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`update movie -> ${res.status}`);
    return res.json() as Promise<MovieRow & { extras: Extra[] }>;
  },

  deleteMovie: async (id: string): Promise<void> => {
    const res = await authedFetch(`/api/movies/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error(`delete movie -> ${res.status}`);
  },

  /** Delete a catalog and all its posters. */
  deleteCatalog: async (id: string): Promise<void> => {
    const res = await authedFetch(`/api/catalog/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error(`delete catalog -> ${res.status}`);
  },

  /** Adopt a cloud origin for a catalog that had none (first cloud push). */
  setSourceRef: async (id: string, sourceRef: string): Promise<void> => {
    const res = await authedFetch(`/api/catalog/${encodeURIComponent(id)}/source-ref`, {
      method: "POST",
      body: JSON.stringify({ source_ref: sourceRef }),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`set source_ref -> ${res.status}`);
  },

  /** Create a movie in a catalog. The Worker assigns the next on-disk number;
   *  pass any editable columns to prefill (e.g. an OMDb patch). */
  createMovie: async (catalogId: string, patch: Partial<MovieRow> = {}): Promise<MovieRow> => {
    const res = await authedFetch(`/api/catalog/${encodeURIComponent(catalogId)}/movies`, {
      method: "POST",
      body: JSON.stringify(patch),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`create movie -> ${res.status}`);
    return res.json() as Promise<MovieRow>;
  },

  /**
   * Set a movie's poster from an image URL. The heavy lifting stays in the
   * browser (consistent with import/export): the Worker only proxies the fetch
   * to dodge the IMDb CDN's missing CORS headers, then a canvas re-encodes the
   * image to JPEG (the format .amc embeds) before it's stored in R2.
   */
  setPictureFromUrl: async (movie: MovieRow, imageUrl: string): Promise<MovieRow> => {
    const proxied = await authedFetch(`/api/proxy-image?url=${encodeURIComponent(imageUrl)}`);
    if (!proxied.ok) throw new Error(`fetch image -> ${proxied.status}`);
    const jpeg = await toJpeg(await proxied.blob());

    const key = movie.poster_key ?? `${_tenantId}/${movie.catalog_id}/${movie.id}.jpg`;
    const put = await authedFetch("/api/import/poster", {
      method: "PUT",
      body: jpeg as BodyInit,
    }, { "x-poster-key": key, "content-type": "application/octet-stream" });
    if (!put.ok) throw new Error(`store poster -> ${put.status}`);
    return cf.updateMovie(movie.id, { poster_key: key, pic_path: ".jpg" });
  },

  // NOTE: /api/poster is Bearer-gated, so a bare <img src="/api/poster?..."> will
  // 401 — an <img> can't send an Authorization header. Use posterObjectUrl() to
  // fetch the bytes with the session header and bind the returned object URL to
  // the <img>. Remember to URL.revokeObjectURL() when the element goes away.
  posterUrl: (key: string) => `/api/poster?key=${encodeURIComponent(key)}`,

  posterObjectUrl: async (key: string): Promise<string> => {
    // no-store: we turn the bytes into an object URL, so HTTP caching gains us
    // nothing — and it avoids the conditional-request path where the browser
    // has the ETag but not the body and the server answers 304 with no bytes
    // (which surfaced as posters intermittently failing to load on mobile).
    const res = await authedFetch(`/api/poster?key=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`poster -> ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
};

// --- OMDb / IMDb lookup ----------------------------------------------------
//
// The only metadata source kept for the POC. `search` returns pick-list rows;
// `fetch` returns a { patch, poster_url } — apply `patch` to the movie via
// updateMovie, then hand `poster_url` to setPictureFromUrl for the artwork.

export interface OmdbSuggestion {
  label: string;
  tt: string;
  url: string;
}

export interface OmdbResult {
  patch: Partial<MovieRow>;
  poster_url: string;
}

export interface OmdbKeyState {
  hasKey: boolean; // a usable key exists (personal or global fallback)
  personal: boolean; // this user has their own key stored
}

export const omdb = {
  search: (query: string) =>
    jget<OmdbSuggestion[]>(`/api/omdb/search?q=${encodeURIComponent(query)}`),

  fetch: (ttOrUrl: string) =>
    jget<OmdbResult>(`/api/omdb/fetch?i=${encodeURIComponent(ttOrUrl)}`),

  /** Whether an OMDb key is available (never returns the key itself). */
  keyState: () => jget<OmdbKeyState>("/api/omdb/key"),

  /** Set (string), keep ("" / undefined), or clear (null) the personal key. */
  saveKey: async (key: string | null): Promise<OmdbKeyState> => {
    const res = await authedFetch("/api/omdb/key", {
      method: "PUT",
      body: JSON.stringify({ key }),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`save OMDb key -> ${res.status}`);
    return res.json() as Promise<OmdbKeyState>;
  },
};

// --- app settings (field visibility + search field) ------------------------

export interface AppSettings {
  field_visibility: { desktop: Record<string, boolean>; mobile: Record<string, boolean> };
  search_field: string;
}

export const settings = {
  get: () => jget<AppSettings>("/api/settings"),

  save: async (s: AppSettings): Promise<AppSettings> => {
    const res = await authedFetch("/api/settings", {
      method: "PUT",
      body: JSON.stringify(s),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`save settings -> ${res.status}`);
    return res.json() as Promise<AppSettings>;
  },
};

// --- cloud sync config -----------------------------------------------------
//
// Per-user provider + .amc path + an OPTIONAL credential encrypted at rest by
// the Worker (see worker/crypto.ts). `get` never returns the secret — only a
// `hasCredential` flag; `connect` is the explicit call that hands the decrypted
// credential back so the browser can log in to the provider.

export interface CloudConfig {
  provider: string;
  path: string;
  hasCredential: boolean;
  updatedAt: number;
}

export const cloud = {
  /** All of this user's provider rows (empty when nothing configured). */
  get: () => jget<CloudConfig[]>("/api/cloud"),

  /** Save one provider's path and, optionally, its credential:
   *  omit / "" = keep stored, `null` = forget it, a string = encrypt + store. */
  save: async (patch: {
    provider: string;
    path?: string;
    credential?: string | null;
  }): Promise<CloudConfig> => {
    const res = await authedFetch("/api/cloud", {
      method: "PUT",
      body: JSON.stringify(patch),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`save cloud config -> ${res.status}`);
    return res.json() as Promise<CloudConfig>;
  },

  /** Fetch the DECRYPTED credential for one provider to log in with. */
  connect: async (provider: string): Promise<{ provider: string; path: string; credential: string }> => {
    const res = await authedFetch("/api/cloud/connect", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }, { "content-type": "application/json" });
    if (!res.ok) throw new Error(`cloud connect -> ${res.status}`);
    return res.json() as Promise<{ provider: string; path: string; credential: string }>;
  },
};
