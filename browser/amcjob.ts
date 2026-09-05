// The two CPU-bound halves of the port, in one place so they can run either on
// the main thread or inside a Web Worker without duplicating logic.
//
// WHY: `parseCatalog` and `serializeCatalog` are synchronous passes over a
// possibly 90 MB buffer — 10-30 s of blocked main thread on a phone, which is
// exactly when a mobile browser kills the tab. Nothing here touches the DOM,
// `fetch`, or auth, so it all moves off-thread as-is; `amc.worker.ts` is a
// six-line shim over `runAmcJob`, and `amcworker.ts` falls back to calling it
// inline where `Worker` is unavailable (tests, ancient browsers).

import { parseCatalog, serializeCatalog } from "../amc/parser";
import { catalogToRows, rowsToCatalog } from "../amc/mapping";
import type {
  CatalogRow,
  CustomFieldDefRow,
  ImportResult,
  MovieRow,
} from "../amc/mapping";
import { detectEncoding, toReadable, toRaw } from "../amc/transcode";
import type { LegacyEncoding, TextEncoding } from "../amc/codepages";
import { sha256Hex, blobKey } from "../amc/posterkey";

/** One poster's bytes plus the content-addressed R2 key they belong at. */
export interface PosterJob {
  data: Uint8Array;
  key: string;
}

export interface ImportJob {
  op: "import";
  /** The raw .amc bytes. Transferred in, so the caller loses its copy. */
  bytes: ArrayBuffer;
  tenantId: string;
  catalogId: string;
  sourceRef: string | null;
  legacyEncoding?: LegacyEncoding;
}

export interface ImportJobResult {
  rows: ImportResult;
  posterJobs: PosterJob[];
  textEncoding: TextEncoding;
}

export interface ExportJob {
  op: "export";
  catalog: CatalogRow;
  customFieldDefs: CustomFieldDefRow[];
  movies: MovieRow[];
  extras: ImportResult["extras"];
  /** Poster bytes by R2 key. Transferred in; every key a row references must
   *  be present (export.ts prefetches them all before calling). */
  posters: Array<[string, Uint8Array]>;
  encoding: TextEncoding;
}

export type AmcJob = ImportJob | ExportJob;

export type JobProgress = { done: number; total: number; phase: "hashing" };

export type JobResult =
  | { op: "import"; result: ImportJobResult }
  | { op: "export"; result: Uint8Array };

/**
 * Run one job. Pure compute: no network, no DOM, no auth — which is what lets
 * it run in a Worker. `onProgress` is only emitted for the import hashing pass
 * (content-addressing every poster is a long serial stretch that would
 * otherwise look frozen).
 *
 * Returns the result plus the buffers safe to hand over as transferables.
 */
export async function runAmcJob(
  job: AmcJob,
  onProgress?: (p: JobProgress) => void,
): Promise<{ payload: JobResult; transfer: ArrayBuffer[] }> {
  if (job.op === "import") {
    const parsed = parseCatalog(new Uint8Array(job.bytes));
    // Detect the on-disk text encoding (auto for legacy ANSI files;
    // `legacyEncoding` is an optional override) and, for legacy catalogs,
    // reinterpret every string through the codepage so umlauts are readable AND
    // survive D1 (lone surrogates would be stored as U+FFFD). Byte-exact export
    // reverses this (rule 5).
    const textEncoding = detectEncoding(parsed, job.legacyEncoding);
    const catalog = toReadable(parsed, textEncoding);

    const posterJobs: PosterJob[] = [];
    // Distinct keys already queued. Content addressing makes this exact: two
    // movies with the same artwork hash to the same key, so it is stored and
    // uploaded once.
    const posterKeys = new Set<string>();
    onProgress?.({ done: 0, total: catalog.movies.length, phase: "hashing" });

    const rows = await catalogToRows(
      catalog,
      job.tenantId,
      {
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
        // Content-address the poster: the key IS the hash of the bytes, so the
        // R2 object is immutable (cacheable for a year) and identical artwork
        // shared by several movies is stored once. `putPoster`'s contract is
        // that the sink returns the key it actually used, so the suggested
        // per-movie key is deliberately ignored — mapping.ts needs no change.
        putPoster: async (data) => {
          const key = blobKey(job.tenantId, job.catalogId, await sha256Hex(data));
          if (!posterKeys.has(key)) {
            posterKeys.add(key);
            posterJobs.push({ data, key });
          }
          return key;
        },
        onMovie: (done, total) => onProgress?.({ done, total, phase: "hashing" }),
      },
      job.catalogId,
      job.sourceRef,
      textEncoding,
    );

    return {
      payload: { op: "import", result: { rows, posterJobs, textEncoding } },
      // Each poster came out of the parser as its own `.slice()`, so handing the
      // buffers over is a pointer move rather than a copy of the whole catalog.
      transfer: posterJobs.map((j) => j.data.buffer as ArrayBuffer),
    };
  }

  const extrasByMovie = new Map<string, ImportResult["extras"]>();
  for (const e of job.extras) {
    const list = extrasByMovie.get(e.movie_id) ?? [];
    list.push(e);
    extrasByMovie.set(e.movie_id, list);
  }
  const posters = new Map(job.posters);
  const catalog = await rowsToCatalog({
    catalog: job.catalog,
    customFieldDefs: job.customFieldDefs,
    movies: job.movies,
    extrasByMovie,
    getPoster: async (key) => {
      const bytes = posters.get(key);
      if (!bytes) throw new Error(`poster not prefetched: ${key}`);
      return bytes;
    },
  });
  // Re-encode strings to the catalog's original on-disk codepage so the .amc is
  // byte-identical to what was imported (no-op for UTF-8 catalogs).
  const out = serializeCatalog(toRaw(catalog, job.encoding));
  return { payload: { op: "export", result: out }, transfer: [out.buffer as ArrayBuffer] };
}
