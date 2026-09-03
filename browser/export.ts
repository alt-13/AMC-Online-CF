// Browser-side export: D1 rows + R2 posters  ->  .amc file download.
//
// The inverse of import.ts. Fetches the row bundle (no image bytes) plus each
// poster on demand from R2, rebuilds the in-memory catalog, and serialises it
// back to the exact binary layout the desktop Ant Movie Catalog expects.

import { serializeCatalog } from "../amc/parser";
import { rowsToCatalog } from "../amc/mapping";
import type { CatalogRow, CustomFieldDefRow, MovieRow, ImportResult } from "../amc/mapping";
import { toRaw } from "../amc/transcode";
import type { TextEncoding } from "../amc/codepages";
import { runPool } from "./pool";

/** fetch() that applies the caller's auth headers and can refresh+retry on 401. */
export type AuthedFetch = (
  path: string,
  init?: RequestInit,
  extra?: Record<string, string>,
) => Promise<Response>;

export interface ExportOptions {
  tenantId: string;
  authHeader?: string;
  onProgress?: (done: number, total: number) => void;
  /**
   * Request function to use. Export fetches one poster per movie, so a big
   * catalog can run past the access-token TTL; the app passes its `authedFetch`,
   * which reads the CURRENT token per request and refreshes on a 401. Falls back
   * to plain fetch with the (frozen) `authHeader` for tests/standalone use.
   */
  fetcher?: AuthedFetch;
}

/** How many poster GETs to keep in flight while prefetching. Higher than
 *  import's upload concurrency: downloads are the cheap direction, and export's
 *  serial fetch loop was the single largest cost in a push. */
const PREFETCH_CONCURRENCY = 8;

type ExtraRow = ImportResult["extras"][number];

interface ExportBundle {
  catalog: CatalogRow;
  customFieldDefs: CustomFieldDefRow[];
  movies: MovieRow[];
  extras: ExtraRow[];
}

function headers(o: ExportOptions): HeadersInit {
  return o.authHeader ? { authorization: o.authHeader, "x-tenant-id": o.tenantId }
                      : { "x-tenant-id": o.tenantId };
}

/** The caller's authed fetch, or a plain-fetch fallback using `authHeader`. */
function requester(o: ExportOptions): AuthedFetch {
  return o.fetcher ?? ((path, init = {}) => fetch(path, { ...init, headers: headers(o) }));
}

/** Rebuild an .amc file for `catalogId` and return it as a Blob for download. */
export async function exportAmcFile(catalogId: string, opts: ExportOptions): Promise<Blob> {
  const send = requester(opts);
  const res = await send(`/api/catalog/${encodeURIComponent(catalogId)}/export`);
  if (!res.ok) throw new Error(`export bundle fetch failed (${res.status})`);
  const bundle = (await res.json()) as ExportBundle;

  const extrasByMovie = new Map<string, ExtraRow[]>();
  for (const e of bundle.extras) {
    const list = extrasByMovie.get(e.movie_id) ?? [];
    list.push(e);
    extrasByMovie.set(e.movie_id, list);
  }

  // Collect every distinct key first. A key shared across rows (two movies with
  // the same artwork) is fetched once.
  const posterKeys = new Set<string>();
  for (const mv of bundle.movies) if (mv.poster_key) posterKeys.add(mv.poster_key);
  for (const e of bundle.extras) if (e.poster_key) posterKeys.add(e.poster_key);

  const posterCache = new Map<string, Uint8Array>();

  const fetchPoster = async (key: string): Promise<Uint8Array> => {
    const r = await send(`/api/poster?key=${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(`poster fetch failed (${r.status}) for ${key}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  // PREFETCH. rowsToCatalog awaits getPoster inside its per-movie loop, so
  // leaving the fetches to it makes the whole export a serial chain of
  // round-trips. Filling the cache up front with a bounded pool turns that into
  // ~keys/PREFETCH_CONCURRENCY round-trips instead. Peak memory is unchanged:
  // rowsToCatalog already holds every poster in the movies array before
  // serialising, so the cache is not an extra copy of anything.
  const keys = [...posterKeys];
  if (keys.length) opts.onProgress?.(0, keys.length);
  await runPool(
    keys.map((key) => async () => { posterCache.set(key, await fetchPoster(key)); }),
    PREFETCH_CONCURRENCY,
    (done, total) => opts.onProgress?.(done, total),
  );

  // After the prefetch every key is cached, so this is a map read. The fallback
  // fetch keeps the function correct if a key ever reaches rowsToCatalog without
  // having been in the bundle's key set.
  const getPoster = async (key: string): Promise<Uint8Array> => {
    const cached = posterCache.get(key);
    if (cached) return cached;
    const bytes = await fetchPoster(key);
    posterCache.set(key, bytes);
    return bytes;
  };

  const catalog = await rowsToCatalog({
    catalog: bundle.catalog,
    customFieldDefs: bundle.customFieldDefs,
    movies: bundle.movies,
    extrasByMovie,
    getPoster,
  });

  // Re-encode strings to the catalog's original on-disk codepage so the .amc is
  // byte-identical to what was imported (no-op for UTF-8 catalogs). Older rows
  // predating this column read back as undefined -> treated as UTF-8.
  const enc = (bundle.catalog.text_encoding ?? "utf-8") as TextEncoding;
  const raw = toRaw(catalog, enc);

  return new Blob([serializeCatalog(raw)], { type: "application/octet-stream" });
}

/** Convenience: build the file and trigger a browser download. */
export async function downloadAmcFile(
  catalogId: string,
  filename: string,
  opts: ExportOptions,
): Promise<void> {
  const blob = await exportAmcFile(catalogId, opts);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".amc") ? filename : `${filename}.amc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
