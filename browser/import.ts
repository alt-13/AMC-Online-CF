// Browser-side import: .amc file  ->  D1 rows + R2 posters.
//
// This is the half of the port that must run in the browser, where memory is
// plentiful. It parses the (potentially multi-hundred-MB) binary blob, lifts
// every embedded poster into R2 via the Worker, then streams the resulting
// rows to D1 in small chunks so no single Worker request is large or slow.

import { parseCatalog } from "../amc/parser";
import { catalogToRows } from "../amc/mapping";
import type { ImportResult } from "../amc/mapping";

/** fetch() that applies the caller's auth headers and can refresh+retry on 401. */
export type AuthedFetch = (
  path: string,
  init?: RequestInit,
  extra?: Record<string, string>,
) => Promise<Response>;

export interface ImportOptions {
  tenantId: string;
  /** Bearer token / auth header value, once the auth layer is ported. */
  authHeader?: string;
  /**
   * Request function to use. An import issues one request per poster, so it can
   * run past the access-token TTL; the app passes its `authedFetch`, which reads
   * the CURRENT token per request and refreshes on a 401. Without it we fall back
   * to plain fetch with the (frozen) `authHeader` — fine for tests/standalone use.
   */
  fetcher?: AuthedFetch;
  /** Movies per commit request. Keep small to respect the Free-plan CPU cap. */
  chunkSize?: number;
  /** Progress callback: (done, total, phase). */
  onProgress?: (done: number, total: number, phase: "posters" | "rows") => void;
  /**
   * Stable origin key for a cloud pull (e.g. "mega:<folder>:<file>.amc"). When
   * set, once the import succeeds every older catalog with the same key is
   * dropped, so re-pulling the same file replaces rather than duplicates it.
   * Omitted for direct file uploads.
   */
  sourceRef?: string | null;
}

function headers(o: ImportOptions, extra: Record<string, string> = {}): HeadersInit {
  return o.authHeader ? { ...extra, authorization: o.authHeader, "x-tenant-id": o.tenantId }
                      : { ...extra, "x-tenant-id": o.tenantId };
}

/** The caller's authed fetch, or a plain-fetch fallback using `authHeader`. */
function requester(o: ImportOptions): AuthedFetch {
  return (
    o.fetcher ??
    ((path, init = {}, extra = {}) => fetch(path, { ...init, headers: headers(o, extra) }))
  );
}

/**
 * Parse an .amc file and import it. Returns the new catalog id.
 * `file` is a File/Blob from an <input type="file"> or drag-and-drop.
 */
export async function importAmcFile(file: Blob, opts: ImportOptions): Promise<string> {
  const chunkSize = opts.chunkSize ?? 200;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const catalog = parseCatalog(bytes);

  // Fix the catalog id up front so a failure anywhere below — even during the
  // poster phase — can be rolled back by its prefix. Import is otherwise a
  // sequence of independent requests with no server-side transaction.
  const catalogId = crypto.randomUUID();
  const send = requester(opts);

  try {
    // Flatten to rows; each poster is PUT to R2 as it is encountered.
    let posterCount = 0;
    const rows: ImportResult = await catalogToRows(
      catalog,
      opts.tenantId,
      {
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        putPoster: async (data, key) => {
          const res = await send(
            "/api/import/poster",
            { method: "PUT", body: data as BodyInit },
            { "x-poster-key": key, "content-type": "application/octet-stream" },
          );
          if (!res.ok) throw new Error(`poster upload failed (${res.status}) for ${key}`);
          opts.onProgress?.(++posterCount, catalog.movies.length, "posters");
          return key;
        },
      },
      catalogId,
      opts.sourceRef ?? null,
    );

    // 1. Create the catalog + custom field definitions.
    const created = await send(
      "/api/import/catalog",
      {
        method: "POST",
        body: JSON.stringify({ catalog: rows.catalog, customFieldDefs: rows.customFieldDefs }),
      },
      { "content-type": "application/json" },
    );
    if (!created.ok) throw new Error(`catalog create failed (${created.status})`);

    // 2. Insert movies in chunks, carrying each chunk's extras alongside.
    const extrasByMovie = new Map<string, ImportResult["extras"]>();
    for (const e of rows.extras) {
      const list = extrasByMovie.get(e.movie_id) ?? [];
      list.push(e);
      extrasByMovie.set(e.movie_id, list);
    }

    for (let i = 0; i < rows.movies.length; i += chunkSize) {
      const movies = rows.movies.slice(i, i + chunkSize);
      const extras = movies.flatMap((mv) => extrasByMovie.get(mv.id) ?? []);
      const res = await send(
        `/api/import/movies?catalogId=${encodeURIComponent(catalogId)}`,
        { method: "POST", body: JSON.stringify({ movies, extras }) },
        { "content-type": "application/json" },
      );
      if (!res.ok) throw new Error(`movie chunk ${i} failed (${res.status})`);
      opts.onProgress?.(Math.min(i + chunkSize, rows.movies.length), rows.movies.length, "rows");
    }

    // 3. For a cloud re-pull, drop older copies of the same source now that the
    //    fresh one is fully committed. Best-effort: a failure here only leaves a
    //    harmless duplicate, never a missing catalog.
    if (opts.sourceRef) {
      try {
        await send(`/api/catalog/${encodeURIComponent(catalogId)}/supersede`, { method: "POST" });
      } catch {
        /* keep the duplicate; the user can delete it manually */
      }
    }

    return catalogId;
  } catch (e) {
    // Best-effort rollback so a failed import never leaves a half-catalog or
    // orphan posters behind. Swallow cleanup errors — surface the real cause.
    try {
      await send(`/api/import/abort?catalogId=${encodeURIComponent(catalogId)}`, { method: "POST" });
    } catch {
      /* leave any residue for the next import/abort to clear */
    }
    throw e;
  }
}
