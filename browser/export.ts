// Browser-side export: D1 rows + R2 posters  ->  .amc file download.
//
// The inverse of import.ts. Fetches the row bundle (no image bytes) plus each
// poster on demand from R2, rebuilds the in-memory catalog, and serialises it
// back to the exact binary layout the desktop Ant Movie Catalog expects.

import type { CatalogRow, CustomFieldDefRow, MovieRow, ImportResult } from "../amc/mapping";
import type { TextEncoding } from "../amc/codepages";
import { runPool } from "./pool";
import { runJob } from "./amcworker";

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
  /** Rows per bundle page. Pages are fetched concurrently; keep it large enough
   *  that a big catalog is a handful of requests, not hundreds. */
  pageSize?: number;
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

/** Rebuild an .amc file for `catalogId`, returning both the Blob and the
 *  content_rev its bundle was read at. Shared by exportAmcFile (download path,
 *  rev discarded) and buildAmcFile (push path, rev recorded as synced_rev). */
async function buildInternal(
  catalogId: string,
  opts: ExportOptions,
): Promise<{ blob: Blob; contentRev: number }> {
  const send = requester(opts);
  const pageSize = opts.pageSize ?? 500;
  const base = `/api/catalog/${encodeURIComponent(catalogId)}/export`;

  const jget = async <T>(qs: string): Promise<T> => {
    const res = await send(`${base}?${qs}`);
    if (!res.ok) throw new Error(`export bundle fetch failed (${res.status})`);
    return (await res.json()) as T;
  };

  // Meta first — it tells us how many pages there are. Then every movie and
  // extra page at once: the Worker used to loop these serially inside a single
  // request, which cost a round-trip per 500 rows in sequence.
  const meta = await jget<{
    catalog: CatalogRow;
    customFieldDefs: CustomFieldDefRow[];
    movieCount: number;
    extraCount: number;
    // The revision this bundle was read at. A push records THIS as
    // synced_rev, so an edit made during a multi-minute upload stays pending
    // instead of being silently marked synced.
    content_rev: number;
  }>("part=meta");

  const pageOffsets = (count: number): number[] =>
    Array.from({ length: Math.ceil(count / pageSize) }, (_, i) => i * pageSize);

  const [moviePages, extraPages] = await Promise.all([
    Promise.all(pageOffsets(meta.movieCount).map((offset) =>
      jget<MovieRow[]>(`part=movies&limit=${pageSize}&offset=${offset}`))),
    Promise.all(pageOffsets(meta.extraCount).map((offset) =>
      jget<ExtraRow[]>(`part=extras&limit=${pageSize}&offset=${offset}`))),
  ]);

  const bundle: ExportBundle = {
    catalog: meta.catalog,
    customFieldDefs: meta.customFieldDefs,
    movies: moviePages.flat(),
    extras: extraPages.flat(),
  };

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

  // Rebuild + serialise in a Worker: it is 10-30 s of blocked main thread on a
  // big catalog, which is exactly when a mobile browser kills the tab. The
  // prefetched posters are TRANSFERRED in rather than copied, so peak memory is
  // unchanged — but this side loses them, which is fine, nothing below reads
  // the cache again.
  //
  // The prefetch above filled the cache with every key the rows reference, so
  // the job's poster lookup is a map read; a miss is unreachable by
  // construction and the job throws rather than silently dropping artwork.
  //
  // `text_encoding` re-encodes strings to the catalog's original on-disk
  // codepage so the .amc is byte-identical to what was imported (no-op for
  // UTF-8). Rows predating that column read back as undefined -> UTF-8.
  const posters = [...posterCache.entries()];
  const job = await runJob(
    {
      op: "export",
      catalog: bundle.catalog,
      customFieldDefs: bundle.customFieldDefs,
      movies: bundle.movies,
      extras: bundle.extras,
      posters,
      encoding: (bundle.catalog.text_encoding ?? "utf-8") as TextEncoding,
    },
    posters.map(([, bytes]) => bytes.buffer as ArrayBuffer),
  );
  const out = (job as { result: Uint8Array }).result;

  return {
    blob: new Blob([out as BlobPart], { type: "application/octet-stream" }),
    contentRev: meta.content_rev,
  };
}

/** Rebuild an .amc file for `catalogId` and return it as a Blob for download. */
export async function exportAmcFile(catalogId: string, opts: ExportOptions): Promise<Blob> {
  return (await buildInternal(catalogId, opts)).blob;
}

/** The built `.amc` plus the revision its bundle was read at. The push path
 *  needs both: the bytes to upload, and the rev to record as synced. */
export interface BuiltAmc {
  bytes: Uint8Array;
  contentRev: number;
}

/** Like exportAmcFile, but also reports the content_rev the bundle was read at. */
export async function buildAmcFile(catalogId: string, opts: ExportOptions): Promise<BuiltAmc> {
  const { blob, contentRev } = await buildInternal(catalogId, opts);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), contentRev };
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
