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

function movie(title: string): AMCMovie {
  return {
    number: 1, date: 0, dateWatched: 0, userRating: -1, rating: -1, year: -1,
    length: -1, videoBitrate: 0, audioBitrate: 0, disks: 1, colorTag: 0,
    checked: false, media: "", mediaType: "", source: "", borrower: "",
    originalTitle: title, translatedTitle: "", director: "", producer: "",
    writer: "", composer: "", country: "", category: "", certification: "",
    actors: "", url: "", description: "", comments: "", filePath: "",
    videoFormat: "", audioFormat: "", resolution: "", framerate: "",
    languages: "", subtitles: "", size: "",
    picture: { picPath: "", picData: new Uint8Array(0) },
    customFieldValues: [], extras: [],
  };
}

function amcBlob(): Blob {
  const cat: AMCCatalog = {
    version: 42, name: "Films", mail: "", site: "", description: "",
    cfpColumnSettings: "", cfpGuiProperties: "", customFieldDefs: [],
    movies: [movie("Stalker")],
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
});
