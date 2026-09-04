import { describe, it, expect } from "vitest";
import { importAmcFile, type AuthedFetch } from "./import";
import { serializeCatalog } from "../amc/parser";
import type { AMCCatalog, AMCMovie } from "../amc/types";
import { isBlobKey, blobKey, sha256Hex } from "../amc/posterkey";

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
    // Real .amc files always write ".jpg" for an embedded picture's path (rule 4
    // — GetPictureStatus() only cares that it's non-empty), so the fixture uses
    // the actual on-disk value rather than an arbitrary placeholder.
    picture: { picPath: poster ? ".jpg" : "", picData: poster ?? new Uint8Array(0) },
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

describe("content-addressed poster keys", () => {
  it("uploads every poster under a blob key", async () => {
    const keys: string[] = [];
    const fetcher: AuthedFetch = async (path, _init, extra) => {
      if (path === "/api/import/poster") keys.push(extra!["x-poster-key"]);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await importAmcFile(amcBlob([movie("Stalker", new Uint8Array([1, 2, 3]))]), {
      tenantId: "t1", fetcher,
    });
    expect(keys).toHaveLength(1);
    expect(isBlobKey(keys[0])).toBe(true);
  });

  it("uploads identical poster bytes only once", async () => {
    const keys: string[] = [];
    const fetcher: AuthedFetch = async (path, _init, extra) => {
      if (path === "/api/import/poster") keys.push(extra!["x-poster-key"]);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const same = new Uint8Array([7, 7, 7]);
    await importAmcFile(
      amcBlob([movie("Stalker", same), movie("Solaris", same), movie("Mirror", new Uint8Array([9]))]),
      { tenantId: "t1", fetcher },
    );
    expect(keys).toHaveLength(2); // two distinct byte sequences, not three movies
    expect(new Set(keys).size).toBe(2);
  });

  it("points the committed rows at the uploaded keys", async () => {
    const uploaded: string[] = [];
    const committed: string[] = [];
    const fetcher: AuthedFetch = async (path, init, extra) => {
      if (path === "/api/import/poster") uploaded.push(extra!["x-poster-key"]);
      if (path.startsWith("/api/import/movies")) {
        const body = JSON.parse(String(init!.body)) as { movies: Array<{ poster_key: string | null; pic_path: string }> };
        for (const mv of body.movies) {
          if (mv.poster_key) {
            committed.push(mv.poster_key);
            expect(mv.pic_path).toBe(".jpg"); // rule 4
          }
        }
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await importAmcFile(amcBlob([movie("Stalker", new Uint8Array([1]))]), {
      tenantId: "t1", fetcher,
    });
    expect(committed).toEqual(uploaded);
  });

  // The Set in import.ts gates whether an UPLOAD job is queued; it must never
  // gate the KEY the sink returns. A regression that short-circuits the return
  // for a deduped movie (leaving its poster_key null or stale) would still pass
  // both tests above — one only counts uploads, the other only imports a single
  // poster-bearing movie. This ties row assignment to the upload set directly.
  it("assigns the same key to both deduped movies, a different key to the third, and both are among the uploaded keys", async () => {
    const uploaded: string[] = [];
    const committed: Array<{ title: string; poster_key: string | null }> = [];
    const fetcher: AuthedFetch = async (path, init, extra) => {
      if (path === "/api/import/poster") uploaded.push(extra!["x-poster-key"]);
      if (path.startsWith("/api/import/movies")) {
        const body = JSON.parse(String(init!.body)) as {
          movies: Array<{ original_title: string; poster_key: string | null }>;
        };
        for (const mv of body.movies) committed.push({ title: mv.original_title, poster_key: mv.poster_key });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const shared = new Uint8Array([5, 5, 5]);
    const different = new Uint8Array([6, 6, 6]);
    await importAmcFile(
      amcBlob([movie("Stalker", shared), movie("Solaris", shared), movie("Mirror", different)]),
      { tenantId: "t1", fetcher },
    );

    expect(uploaded).toHaveLength(2); // the dedup: 3 movies, 2 distinct byte sequences

    const byTitle = new Map(committed.map((c) => [c.title, c.poster_key]));
    const stalkerKey = byTitle.get("Stalker");
    const solarisKey = byTitle.get("Solaris");
    const mirrorKey = byTitle.get("Mirror");

    expect(stalkerKey).toBeTruthy();
    expect(solarisKey).toBeTruthy();
    expect(mirrorKey).toBeTruthy();
    expect(solarisKey).toBe(stalkerKey); // the deduped pair shares one key
    expect(mirrorKey).not.toBe(stalkerKey);

    // The point: every committed key is one of the keys actually uploaded — a
    // deduped movie's key isn't just present, it's the SAME key R2 received.
    expect(uploaded).toContain(stalkerKey);
    expect(uploaded).toContain(mirrorKey);
  });

  it("gives an extra's poster a blob key too", async () => {
    const uploaded: string[] = [];
    const extraRows: Array<{ poster_key: string | null }> = [];
    const fetcher: AuthedFetch = async (path, init, extra) => {
      if (path === "/api/import/poster") uploaded.push(extra!["x-poster-key"]);
      if (path.startsWith("/api/import/movies")) {
        const body = JSON.parse(String(init!.body)) as {
          extras: Array<{ poster_key: string | null }>;
        };
        extraRows.push(...body.extras);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const withExtra = movie("Stalker");
    withExtra.extras = [
      {
        checked: false, tag: "", title: "Behind the Scenes", category: "",
        url: "", description: "", comments: "", createdBy: "",
        picture: { picPath: ".jpg", picData: new Uint8Array([4, 4, 4]) },
      },
    ];

    await importAmcFile(amcBlob([withExtra]), { tenantId: "t1", fetcher });

    expect(extraRows).toHaveLength(1);
    expect(extraRows[0].poster_key).toBeTruthy();
    expect(isBlobKey(extraRows[0].poster_key!)).toBe(true);
    expect(uploaded).toContain(extraRows[0].poster_key);
  });
});

describe("blob dedup on import", () => {
  const existing = `t1/CAT/blobs/${"0".repeat(64)}.jpg`;

  /** Stub that reports one already-present blob, chosen to match `bytes`. */
  function dedupStub(presentKeys: string[]) {
    const uploaded: string[] = [];
    const committed: string[] = [];
    const fetcher: AuthedFetch = async (path, init, extra) => {
      if (path.startsWith("/api/import/existing-blobs")) {
        return new Response(JSON.stringify({ keys: presentKeys, next: null }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/import/poster") uploaded.push(extra!["x-poster-key"]);
      if (path.startsWith("/api/import/movies")) {
        const body = JSON.parse(String(init!.body)) as { movies: Array<{ poster_key: string | null }> };
        for (const mv of body.movies) if (mv.poster_key) committed.push(mv.poster_key);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    return { fetcher, uploaded, committed };
  }

  it("skips uploading a poster whose hash R2 already holds", async () => {
    const bytes = new Uint8Array([1]);
    const key = blobKey("t1", "CAT", await sha256Hex(bytes));
    const { fetcher, uploaded, committed } = dedupStub([key]);
    await importAmcFile(amcBlob([movie("Stalker", bytes)]), {
      tenantId: "t1", fetcher, catalogId: "CAT",
    });
    expect(uploaded).toEqual([]);        // nothing re-uploaded
    expect(committed).toEqual([key]);    // but the row still points at it
  });

  it("uploads posters R2 does not hold", async () => {
    const bytes = new Uint8Array([2]);
    const key = blobKey("t1", "CAT", await sha256Hex(bytes));
    const { fetcher, uploaded } = dedupStub([existing]);
    await importAmcFile(amcBlob([movie("Stalker", bytes)]), {
      tenantId: "t1", fetcher, catalogId: "CAT",
    });
    expect(uploaded).toEqual([key]);
  });

  it("uploads everything when the dedup probe fails", async () => {
    const bytes = new Uint8Array([3]);
    const key = blobKey("t1", "CAT", await sha256Hex(bytes));
    const uploaded: string[] = [];
    const fetcher: AuthedFetch = async (path, _init, extra) => {
      if (path.startsWith("/api/import/existing-blobs")) return new Response("boom", { status: 500 });
      if (path === "/api/import/poster") uploaded.push(extra!["x-poster-key"]);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await importAmcFile(amcBlob([movie("Stalker", bytes)]), {
      tenantId: "t1", fetcher, catalogId: "CAT",
    });
    expect(uploaded).toEqual([key]);
  });
});

describe("re-import into an existing catalog", () => {
  it("calls reimport-begin and skips catalog-create and supersede", async () => {
    const calls: string[] = [];
    const fetcher: AuthedFetch = async (path) => {
      calls.push(path.split("?")[0]);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const id = await importAmcFile(amcBlob(), {
      tenantId: "t1", fetcher, reimportInto: "CAT", sourceRef: "mega:f:films.amc",
    });
    expect(id).toBe("CAT");
    expect(calls).toContain("/api/catalog/CAT/reimport-begin");
    expect(calls).not.toContain("/api/import/catalog");
    expect(calls).not.toContain("/api/catalog/CAT/supersede");
  });

  it("does NOT abort-purge when a re-import fails", async () => {
    const calls: string[] = [];
    const fetcher: AuthedFetch = async (path) => {
      calls.push(path.split("?")[0]);
      if (path.startsWith("/api/import/movies")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(
      importAmcFile(amcBlob(), { tenantId: "t1", fetcher, reimportInto: "CAT" }),
    ).rejects.toThrow();
    // Purging here would destroy a catalog whose only other copy is the .amc on
    // Mega. Retrying the re-import is the recovery path instead.
    expect(calls).not.toContain("/api/import/abort");
  });

  it("still abort-purges a normal (non-re-import) failure", async () => {
    const calls: string[] = [];
    const fetcher: AuthedFetch = async (path) => {
      calls.push(path.split("?")[0]);
      if (path.startsWith("/api/import/movies")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(importAmcFile(amcBlob(), { tenantId: "t1", fetcher })).rejects.toThrow();
    expect(calls).toContain("/api/import/abort");
  });
});
