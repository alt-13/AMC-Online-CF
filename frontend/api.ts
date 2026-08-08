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

  posterUrl: (key: string) => `/api/poster?key=${encodeURIComponent(key)}`,
};
