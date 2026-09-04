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
import { runPool } from "./pool";
import { sha256Hex, blobKey } from "../amc/posterkey";

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
  /**
   * Force the new catalog's id instead of generating one. Normally omitted — the
   * import mints a UUID. Set by the re-import path (which writes into an
   * existing catalog) and by tests that need a predictable poster key.
   */
  catalogId?: string;
  /**
   * Re-import INTO this existing catalog instead of creating a new one. The
   * catalog id, its source_ref and its sync bookkeeping survive, and — because
   * the R2 prefix is unchanged — the blob dedup probe skips re-uploading every
   * poster whose bytes are already there.
   *
   * Changes the failure policy: a failed re-import must NOT purge, because the
   * catalog's only other copy may be the .amc on the cloud. Retry instead.
   */
  reimportInto?: string;
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
 *  latency without overwhelming a phone connection or the Worker. Deliberately
 *  lower than export's prefetch concurrency: uploads from a phone are the
 *  asymmetric direction. */
const POSTER_CONCURRENCY = 6;

/** PUT every poster to R2 with a bounded pool of concurrent workers. Rejects (so
 *  the import rolls back) on the first failure. Reports "posters" progress. */
async function uploadPosters(
  send: AuthedFetch,
  jobs: Array<{ data: Uint8Array; key: string }>,
  onProgress?: (done: number, total: number, phase: "reading" | "posters" | "rows") => void,
): Promise<void> {
  if (!jobs.length) return;
  onProgress?.(0, jobs.length, "posters");
  await runPool(
    jobs.map((job) => async () => {
      const res = await send(
        "/api/import/poster",
        { method: "PUT", body: job.data as BodyInit },
        { "x-poster-key": job.key, "content-type": "application/octet-stream" },
      );
      if (!res.ok) throw new Error(`poster upload failed (${res.status}) for ${job.key}`);
    }),
    POSTER_CONCURRENCY,
    (done, total) => onProgress?.(done, total, "posters"),
  );
}

/**
 * Blob keys R2 already holds for this catalog, so an import can skip re-
 * uploading bytes that are already there. Content addressing is what makes this
 * exact — the key IS the hash, so "already present" needs no movie identity.
 *
 * Best-effort by design: a failure here must never fail an import, it just
 * means we upload everything (correct, only slower). Returns an empty set on
 * any error.
 */
// Hard cap on pages fetched. At up to ~1000 keys/page this is far beyond any
// real catalog, so it never bites in practice — it exists only so a
// misbehaving/looping server can't hang this "best-effort" helper forever.
// This function's whole contract is "never break an import", and an infinite
// loop with no error and no progress is worse than the safe fallback (upload
// everything) that every other failure path here already takes.
const EXISTING_BLOBS_MAX_PAGES = 50;

async function existingBlobKeys(send: AuthedFetch, catalogId: string): Promise<Set<string>> {
  const found = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < EXISTING_BLOBS_MAX_PAGES; page++) {
      const qs = new URLSearchParams({ catalogId });
      if (cursor) qs.set("cursor", cursor);
      const res = await send(`/api/import/existing-blobs?${qs}`);
      if (!res.ok) return new Set();
      const body = (await res.json()) as { keys: string[]; next: string | null };
      for (const k of body.keys) found.add(k);
      cursor = body.next;
      if (!cursor) return found;
    }
    // Exceeded the page cap without exhausting the cursor — bail out to the
    // same safe fallback as any other failure: upload everything.
    return new Set();
  } catch {
    return new Set();
  }
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
  const reimport = !!opts.reimportInto;
  const catalogId = opts.reimportInto ?? opts.catalogId ?? crypto.randomUUID();
  const send = requester(opts);

  try {
    // Flatten to rows. Poster keys are deterministic, so we just RECORD each
    // upload here and return the key immediately; the bytes are pushed to R2
    // afterwards with bounded concurrency. Uploading one-at-a-time was the main
    // slowdown — a big catalog is thousands of serial round-trips over a phone.
    const posterJobs: Array<{ data: Uint8Array; key: string }> = [];
    // Distinct keys already queued. Content addressing makes this exact: two
    // movies with the same artwork hash to the same key, so we upload it once.
    const posterKeys = new Set<string>();
    const rows: ImportResult = await catalogToRows(
      catalog,
      opts.tenantId,
      {
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        // Content-address the poster: the key IS the hash of the bytes, so the
        // R2 object is immutable (cacheable for a year) and identical artwork
        // shared by several movies is stored and uploaded ONCE. `putPoster`'s
        // contract is that the sink returns the key it actually used, so the
        // suggested per-movie key is deliberately ignored — mapping.ts needs no
        // change for this.
        putPoster: async (data, _suggestedKey) => {
          const key = blobKey(opts.tenantId, catalogId, await sha256Hex(data));
          if (!posterKeys.has(key)) {
            posterKeys.add(key);
            posterJobs.push({ data, key });
          }
          return key;
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

    // Drop posters R2 already holds. On a re-import where a few movies changed
    // this removes almost all of the poster traffic. Skipped for a brand-new
    // catalog: at this point its row does not exist in D1 yet, so the probe
    // would just 404 and fall back to uploading everything anyway.
    const existingCatalogId = opts.reimportInto ?? opts.catalogId;
    const present = existingCatalogId ? await existingBlobKeys(send, existingCatalogId) : new Set<string>();
    const toUpload = present.size ? posterJobs.filter((j) => !present.has(j.key)) : posterJobs;

    // Upload posters with a small pool of concurrent PUTs (overlaps latency).
    await uploadPosters(send, toUpload, opts.onProgress);

    // 1. Create the catalog + custom field definitions — or, for a re-import,
    //    clear the existing catalog's contents and keep the row.
    if (reimport) {
      const begun = await send(
        `/api/catalog/${encodeURIComponent(catalogId)}/reimport-begin`,
        { method: "POST" },
      );
      if (!begun.ok) throw new Error(`reimport begin failed (${begun.status})`);
      const defs = await send(
        "/api/import/custom-field-defs",
        { method: "POST", body: JSON.stringify({ catalogId, customFieldDefs: rows.customFieldDefs }) },
        { "content-type": "application/json" },
      );
      if (!defs.ok) throw new Error(`custom field defs failed (${defs.status})`);
    } else {
      const created = await send(
        "/api/import/catalog",
        {
          method: "POST",
          body: JSON.stringify({ catalog: rows.catalog, customFieldDefs: rows.customFieldDefs }),
        },
        { "content-type": "application/json" },
      );
      if (!created.ok) throw new Error(`catalog create failed (${created.status})`);
    }

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

    // 3. For a cloud re-pull that created a NEW catalog, drop older copies of
    //    the same source now that the fresh one is fully committed. A re-import
    //    wrote into the existing catalog, so there is nothing to supersede.
    //    Best-effort: a failure here only leaves a harmless duplicate, never a
    //    missing catalog.
    if (opts.sourceRef && !reimport) {
      try {
        await send(`/api/catalog/${encodeURIComponent(catalogId)}/supersede`, { method: "POST" });
      } catch {
        /* keep the duplicate; the user can delete it manually */
      }
    }

    return catalogId;
  } catch (e) {
    // Best-effort rollback so a failed import never leaves a half-catalog or
    // orphan posters behind.
    //
    // NOT for a re-import: that catalog already existed, and its only other
    // copy may be the .amc on the cloud — purging it on a failed re-import
    // would destroy the user's data. A half-applied re-import is recoverable by
    // retrying (reimport-begin is idempotent), so leave it dirty and surface
    // the error.
    if (!reimport) {
      try {
        await send(`/api/import/abort?catalogId=${encodeURIComponent(catalogId)}`, { method: "POST" });
      } catch {
        /* leave any residue for the next import/abort to clear */
      }
    }
    throw e;
  }
}
