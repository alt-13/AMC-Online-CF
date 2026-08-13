// Browser-side import: .amc file  ->  D1 rows + R2 posters.
//
// This is the half of the port that must run in the browser, where memory is
// plentiful. It parses the (potentially multi-hundred-MB) binary blob, lifts
// every embedded poster into R2 via the Worker, then streams the resulting
// rows to D1 in small chunks so no single Worker request is large or slow.

import { parseCatalog } from "../amc/parser";
import { catalogToRows } from "../amc/mapping";
import type { ImportResult } from "../amc/mapping";

export interface ImportOptions {
  tenantId: string;
  /** Bearer token / auth header value, once the auth layer is ported. */
  authHeader?: string;
  /** Movies per commit request. Keep small to respect the Free-plan CPU cap. */
  chunkSize?: number;
  /** Progress callback: (done, total, phase). */
  onProgress?: (done: number, total: number, phase: "posters" | "rows") => void;
}

function headers(o: ImportOptions, extra: Record<string, string> = {}): HeadersInit {
  return o.authHeader ? { ...extra, authorization: o.authHeader, "x-tenant-id": o.tenantId }
                      : { ...extra, "x-tenant-id": o.tenantId };
}

/**
 * Parse an .amc file and import it. Returns the new catalog id.
 * `file` is a File/Blob from an <input type="file"> or drag-and-drop.
 */
export async function importAmcFile(file: Blob, opts: ImportOptions): Promise<string> {
  const chunkSize = opts.chunkSize ?? 200;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const catalog = parseCatalog(bytes);

  // Flatten to rows; each poster is PUT to R2 as it is encountered.
  let posterCount = 0;
  const rows: ImportResult = await catalogToRows(catalog, opts.tenantId, {
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    putPoster: async (data, key) => {
      const res = await fetch("/api/import/poster", {
        method: "PUT",
        headers: headers(opts, { "x-poster-key": key, "content-type": "application/octet-stream" }),
        body: data as BodyInit,
      });
      if (!res.ok) throw new Error(`poster upload failed (${res.status}) for ${key}`);
      opts.onProgress?.(++posterCount, catalog.movies.length, "posters");
      return key;
    },
  });

  // 1. Create the catalog + custom field definitions.
  const created = await fetch("/api/import/catalog", {
    method: "POST",
    headers: headers(opts, { "content-type": "application/json" }),
    body: JSON.stringify({ catalog: rows.catalog, customFieldDefs: rows.customFieldDefs }),
  });
  if (!created.ok) throw new Error(`catalog create failed (${created.status})`);
  const { catalogId } = (await created.json()) as { catalogId: string };

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
    const res = await fetch(`/api/import/movies?catalogId=${encodeURIComponent(catalogId)}`, {
      method: "POST",
      headers: headers(opts, { "content-type": "application/json" }),
      body: JSON.stringify({ movies, extras }),
    });
    if (!res.ok) throw new Error(`movie chunk ${i} failed (${res.status})`);
    opts.onProgress?.(Math.min(i + chunkSize, rows.movies.length), rows.movies.length, "rows");
  }

  return catalogId;
}
