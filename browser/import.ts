// Browser-side import: .amc file  ->  D1 rows + R2 posters.
//
// This is the half of the port that must run in the browser, where memory is
// plentiful. It parses the (potentially multi-hundred-MB) binary blob, lifts
// every embedded poster into R2 via the Worker, then streams the resulting
// rows to D1 in small chunks so no single Worker request is large or slow.

import { parseCatalog } from "../amc/parser";
import { catalogToRows } from "../amc/mapping";
import type { ImportResult } from "../amc/mapping";
import { detectEncoding, toReadable } from "../amc/transcode";
import type { LegacyEncoding } from "../amc/codepages";

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
  /** Progress callback: (done, total, phase). "reading" = parsing the binary
   *  (done/total are 0 — it's a synchronous step, not countable). */
  onProgress?: (done: number, total: number, phase: "reading" | "posters" | "rows") => void;
  /**
   * Stable origin key for a cloud pull (e.g. "mega:<folder>:<file>.amc"). When
   * set, once the import succeeds every older catalog with the same key is
   * dropped, so re-pulling the same file replaces rather than duplicates it.
   * Omitted for direct file uploads.
   */
  sourceRef?: string | null;
  /**
   * Name to use when the .amc has no internal catalog name (most files don't) —
   * typically the source filename, so the library shows "Filme" not "(untitled)".
   */
  fallbackName?: string;
  /**
   * OPTIONAL override for the legacy-codepage auto-detection. Normally omitted:
   * a non-UTF-8 (ANSI) catalog's codepage is detected automatically. Set this
   * only to force a specific page (windows-1252/1250/1251) when correcting a
   * rare misdetection. Ignored for clean UTF-8 catalogs.
   */
  legacyEncoding?: LegacyEncoding;
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

/** How many poster PUTs to keep in flight at once. Enough to hide round-trip
 *  latency without overwhelming a phone connection or the Worker. */
const POSTER_CONCURRENCY = 6;

/** PUT every poster to R2 with a bounded pool of concurrent workers. Rejects (so
 *  the import rolls back) on the first failure. Reports "posters" progress. */
async function uploadPosters(
  send: AuthedFetch,
  jobs: Array<{ data: Uint8Array; key: string }>,
  onProgress?: (done: number, total: number, phase: "reading" | "posters" | "rows") => void,
): Promise<void> {
  const total = jobs.length;
  if (!total) return;
  onProgress?.(0, total, "posters");
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const job = jobs[next++];
      const res = await send(
        "/api/import/poster",
        { method: "PUT", body: job.data as BodyInit },
        { "x-poster-key": job.key, "content-type": "application/octet-stream" },
      );
      if (!res.ok) throw new Error(`poster upload failed (${res.status}) for ${job.key}`);
      onProgress?.(++done, total, "posters");
    }
  }
  await Promise.all(Array.from({ length: Math.min(POSTER_CONCURRENCY, total) }, worker));
}

/**
 * Parse an .amc file and import it. Returns the new catalog id.
 * `file` is a File/Blob from an <input type="file"> or drag-and-drop.
 */
export async function importAmcFile(file: Blob, opts: ImportOptions): Promise<string> {
  const chunkSize = opts.chunkSize ?? 200;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Parsing a large .amc is synchronous and blocks the thread; signal "reading"
  // and yield one macrotask so the UI paints that state before the parse locks up.
  opts.onProgress?.(0, 0, "reading");
  await new Promise((r) => setTimeout(r));
  const parsed = parseCatalog(bytes);

  // Detect the on-disk text encoding (auto for legacy ANSI files; opts.legacyEncoding
  // is an optional override) and, for legacy catalogs, reinterpret every string
  // through the codepage so umlauts are readable AND survive D1 (lone surrogates
  // would be stored as U+FFFD). Byte-exact export reverses this.
  const textEncoding = detectEncoding(parsed, opts.legacyEncoding);
  const catalog = toReadable(parsed, textEncoding);

  // Fix the catalog id up front so a failure anywhere below — even during the
  // poster phase — can be rolled back by its prefix. Import is otherwise a
  // sequence of independent requests with no server-side transaction.
  const catalogId = crypto.randomUUID();
  const send = requester(opts);

  try {
    // Flatten to rows. Poster keys are deterministic, so we just RECORD each
    // upload here and return the key immediately; the bytes are pushed to R2
    // afterwards with bounded concurrency. Uploading one-at-a-time was the main
    // slowdown — a big catalog is thousands of serial round-trips over a phone.
    const posterJobs: Array<{ data: Uint8Array; key: string }> = [];
    const rows: ImportResult = await catalogToRows(
      catalog,
      opts.tenantId,
      {
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        putPoster: (data, key) => {
          posterJobs.push({ data, key });
          return Promise.resolve(key);
        },
      },
      catalogId,
      opts.sourceRef ?? null,
      textEncoding,
    );

    // Most .amc files carry no internal catalog name — fall back to the source
    // filename so the library shows something meaningful, not "(untitled)".
    if (!rows.catalog.name.trim() && opts.fallbackName?.trim()) {
      rows.catalog.name = opts.fallbackName.trim();
    }

    // Upload posters with a small pool of concurrent PUTs (overlaps latency).
    await uploadPosters(send, posterJobs, opts.onProgress);

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
