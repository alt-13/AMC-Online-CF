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

/** Options object the import/export helpers expect. */
export function session(): { tenantId: string; authHeader?: string } {
  return { tenantId: _tenantId, authHeader: _authHeader };
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

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// --- catalog + movie metadata ----------------------------------------------

export interface CatalogInfo extends CatalogRow {
  movie_count: number;
  custom_field_defs: CustomFieldDefRow[];
}

export const cf = {
  listCatalogs: () => jget<CatalogRow[]>("/api/catalogs"),

  catalogInfo: (id: string) => jget<CatalogInfo>(`/api/catalog/${encodeURIComponent(id)}/info`),

  listMovies: (id: string) => jget<MovieRow[]>(`/api/catalog/${encodeURIComponent(id)}/movies`),

  getMovie: (id: string) => jget<MovieRow & { extras: unknown[] }>(`/api/movies/${encodeURIComponent(id)}`),

  updateMovie: async (id: string, patch: Partial<MovieRow>): Promise<MovieRow> => {
    const res = await fetch(`/api/movies/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`update movie -> ${res.status}`);
    return res.json() as Promise<MovieRow>;
  },

  deleteMovie: async (id: string): Promise<void> => {
    const res = await fetch(`/api/movies/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(),
    });
    if (!res.ok && res.status !== 204) throw new Error(`delete movie -> ${res.status}`);
  },

  // NOTE: /api/poster is Bearer-gated, so a bare <img src="/api/poster?..."> will
  // 401 — an <img> can't send an Authorization header. Use posterObjectUrl() to
  // fetch the bytes with the session header and bind the returned object URL to
  // the <img>. Remember to URL.revokeObjectURL() when the element goes away.
  posterUrl: (key: string) => `/api/poster?key=${encodeURIComponent(key)}`,

  posterObjectUrl: async (key: string): Promise<string> => {
    const res = await fetch(`/api/poster?key=${encodeURIComponent(key)}`, { headers: headers() });
    if (!res.ok) throw new Error(`poster -> ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
};
