import { describe, it, expect } from "vitest";
import { importAmcFile, type AuthedFetch } from "./import";
import { serializeCatalog } from "../amc/parser";
import type { AMCCatalog, AMCMovie } from "../amc/types";

// Import is a sequence of independent requests with no server-side transaction,
// so its failure handling is the interesting part: a partial import must roll
// itself back, and a cloud re-pull must supersede its previous catalog only
// AFTER the new one is fully committed. These drive the flow through a stub
// `fetcher` — which also pins that import honours the injected request function
// (the app passes one that refreshes an expired token mid-import).

function movie(title: string, poster?: Uint8Array): AMCMovie {
  return {
    number: 1, date: 0, dateWatched: 0, userRating: -1, rating: -1, year: -1,
    length: -1, videoBitrate: 0, audioBitrate: 0, disks: 1, colorTag: 0,
    checked: false, media: "", mediaType: "", source: "", borrower: "",
    originalTitle: title, translatedTitle: "", director: "", producer: "",
    writer: "", composer: "", country: "", category: "", certification: "",
    actors: "", url: "", description: "", comments: "", filePath: "",
    videoFormat: "", audioFormat: "", resolution: "", framerate: "",
    languages: "", subtitles: "", size: "",
    picture: { picPath: poster ? "p.jpg" : "", picData: poster ?? new Uint8Array(0) },
    customFieldValues: [], extras: [],
  };
}

function amcBlob(movies: AMCMovie[] = [movie("Stalker")]): Blob {
  const cat: AMCCatalog = {
    version: 42, name: "Films", mail: "", site: "", description: "",
    cfpColumnSettings: "", cfpGuiProperties: "", customFieldDefs: [],
    movies,
  };
  return new Blob([serializeCatalog(cat) as BlobPart]);
}

/** Records every path the import hits; `failOn` makes one of them return 500. */
function stub(failOn?: string) {
  const calls: string[] = [];
  const fetcher: AuthedFetch = async (path) => {
    calls.push(path);
    if (failOn && path.startsWith(failOn)) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetcher };
}

describe("importAmcFile", () => {
  it("routes every request through the injected fetcher", async () => {
    const { calls, fetcher } = stub();
    const id = await importAmcFile(amcBlob(), { tenantId: "t1", fetcher });

    expect(calls).toContain("/api/import/catalog");
    expect(calls.some((c) => c.startsWith("/api/import/movies?catalogId="))).toBe(true);
    // The id it returns is the one it committed rows against.
    expect(calls).toContain(`/api/import/movies?catalogId=${encodeURIComponent(id)}`);
    // No rollback on a clean run.
    expect(calls.some((c) => c.startsWith("/api/import/abort"))).toBe(false);
  });

  it("rolls back via /import/abort when a movie chunk fails", async () => {
    const { calls, fetcher } = stub("/api/import/movies");
    await expect(importAmcFile(amcBlob(), { tenantId: "t1", fetcher })).rejects.toThrow(/movie chunk/);

    const abort = calls.find((c) => c.startsWith("/api/import/abort"));
    expect(abort).toBeDefined();
    // Aborts the same catalog it was building, so the sweep hits the right prefix.
    const failed = calls.find((c) => c.startsWith("/api/import/movies?catalogId="))!;
    expect(abort).toBe(
      `/api/import/abort?catalogId=${new URL(failed, "http://x").searchParams.get("catalogId")}`,
    );
  });

  it("aborts a failure that happens before the catalog row exists", async () => {
    const { calls, fetcher } = stub("/api/import/catalog");
    await expect(importAmcFile(amcBlob(), { tenantId: "t1", fetcher })).rejects.toThrow(/catalog create/);
    expect(calls.some((c) => c.startsWith("/api/import/abort"))).toBe(true);
  });

  it("supersedes older copies only for a cloud pull, and only after committing", async () => {
    const { calls, fetcher } = stub();
    const id = await importAmcFile(amcBlob(), {
      tenantId: "t1",
      fetcher,
      sourceRef: "mega:folderX:films.amc",
    });

    const supersede = `/api/catalog/${encodeURIComponent(id)}/supersede`;
    expect(calls).toContain(supersede);
    // Rows are committed before anything old is dropped, so a failed pull can
    // never destroy the previous catalog.
    const lastChunk = calls.lastIndexOf(`/api/import/movies?catalogId=${encodeURIComponent(id)}`);
    expect(calls.indexOf(supersede)).toBeGreaterThan(lastChunk);
  });

  it("does not supersede for a plain file upload (no sourceRef)", async () => {
    const { calls, fetcher } = stub();
    await importAmcFile(amcBlob(), { tenantId: "t1", fetcher });
    expect(calls.some((c) => c.endsWith("/supersede"))).toBe(false);
  });

  it("uploads every poster (in parallel) before creating the catalog", async () => {
    const { calls, fetcher } = stub();
    const movies = [
      movie("A", new Uint8Array([1, 2, 3])),
      movie("B", new Uint8Array([4, 5, 6])),
      movie("C", new Uint8Array([7, 8, 9])),
    ];
    await importAmcFile(amcBlob(movies), { tenantId: "t1", fetcher, chunkSize: 50 });

    const posters = calls.filter((c) => c === "/api/import/poster");
    expect(posters).toHaveLength(3);
    // Posters land before the catalog row (export/UI expect the bytes present).
    expect(calls.lastIndexOf("/api/import/poster")).toBeLessThan(calls.indexOf("/api/import/catalog"));
  });

  it("rolls back if a poster upload fails", async () => {
    const { calls, fetcher } = stub("/api/import/poster");
    const movies = [movie("A", new Uint8Array([1, 2, 3]))];
    await expect(
      importAmcFile(amcBlob(movies), { tenantId: "t1", fetcher }),
    ).rejects.toThrow(/poster upload failed/);
    expect(calls.some((c) => c.startsWith("/api/import/abort"))).toBe(true);
    // Never reached catalog creation.
    expect(calls).not.toContain("/api/import/catalog");
  });
});
