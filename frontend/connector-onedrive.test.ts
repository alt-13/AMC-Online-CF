// The OneDrive connector's real logic: the chunked upload-session loop (offsets,
// Content-Range, 202 + nextExpectedRanges), 404-vs-transient resolution, and
// Graph's path addressing. Everything else is a fetch away, so a fake fetch is
// the whole harness.

import { describe, it, expect, vi, afterEach } from "vitest";
import { onedriveConnector as od } from "./connector-onedrive";

const CHUNK = 320 * 1024 * 30; // must match the connector's chunk size
const session = { token: "tok", request: async () => "fresh-tok" };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const uploadSession = { uploadUrl: "https://upload.example/session" };
const amcItem = {
  id: "ITEM1",
  name: "movies.amc",
  size: 10,
  file: { hashes: { quickXorHash: "oldhash" } },
  parentReference: { id: "FOLDER1" },
};

const rangeHeader = (init: RequestInit) =>
  (init.headers as Record<string, string> | undefined)?.["Content-Range"];

afterEach(() => vi.unstubAllGlobals());

describe("pushToLocator", () => {
  it("replaces the file in place and chunks the upload", async () => {
    const bytes = new Uint8Array(CHUNK + 1000); // two chunks
    let put = 0;
    const calls = fakeFetch((url) => {
      if (url.includes("createUploadSession")) return json(uploadSession);
      put += 1;
      if (put === 1) return json({ nextExpectedRanges: [`${CHUNK}-`] }, 202);
      return json({ ...amcItem, size: bytes.byteLength, file: { hashes: { quickXorHash: "new" } } });
    });

    const seen: number[] = [];
    const stat = await od.pushToLocator(session, "FOLDER1:movies.amc", bytes, (done) =>
      seen.push(done),
    );

    expect(stat).toEqual({ fingerprint: "new", size: bytes.byteLength });

    // Addressed by parent + name, replacing rather than creating a copy.
    const initiate = calls[0];
    expect(initiate.url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/items/FOLDER1:/movies.amc:/createUploadSession",
    );
    expect(initiate.init.method).toBe("POST");
    expect(String(initiate.init.body)).toContain('"@microsoft.graph.conflictBehavior":"replace"');

    const puts = calls.filter((c) => c.url === uploadSession.uploadUrl);
    expect(puts.map((c) => rangeHeader(c.init))).toEqual([
      `bytes 0-${CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${CHUNK}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    ]);
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });

  it("resumes from the range Graph committed, not from what we sent", async () => {
    const bytes = new Uint8Array(CHUNK + 1000);
    let put = 0;
    const calls = fakeFetch((url) => {
      if (url.includes("createUploadSession")) return json(uploadSession);
      put += 1;
      // Graph says it kept only the first megabyte of the chunk.
      if (put === 1) return json({ nextExpectedRanges: ["1048576-"] }, 202);
      return json({ ...amcItem, size: bytes.byteLength });
    });

    await od.pushToLocator(session, "FOLDER1:movies.amc", bytes);

    const puts = calls.filter((c) => c.url === uploadSession.uploadUrl);
    expect(rangeHeader(puts[1].init)).toBe(`bytes 1048576-${bytes.byteLength - 1}/${bytes.byteLength}`);
  });

  it("re-reads the item when the upload reply carries no hash yet", async () => {
    const calls = fakeFetch((url) => {
      if (url.includes("createUploadSession")) return json(uploadSession);
      if (url === uploadSession.uploadUrl) return json({ id: "ITEM1", name: "movies.amc", size: 3 });
      return json({ ...amcItem, size: 3, file: { hashes: { quickXorHash: "late" } } });
    });

    const stat = await od.pushToLocator(session, "FOLDER1:movies.amc", new Uint8Array(3));
    expect(stat).toEqual({ fingerprint: "late", size: 3 });
    expect(calls.at(-1)!.url).toBe("https://graph.microsoft.com/v1.0/me/drive/items/ITEM1");
  });

  it("surfaces Graph's own error message", async () => {
    fakeFetch(() => json({ error: { message: "Insufficient permissions" } }, 403));
    await expect(
      od.pushToLocator(session, "FOLDER1:movies.amc", new Uint8Array(1)),
    ).rejects.toThrow(/Insufficient permissions/);
  });
});

describe("resolveLocator", () => {
  it("encodes the name into Graph's path addressing", async () => {
    const calls = fakeFetch(() => json({ error: { message: "not found" } }, 404));
    expect(await od.resolveLocator(session, "FOLDER1:Dad's films.amc")).toBeNull();
    expect(calls[0].url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/items/FOLDER1:/Dad's%20films.amc",
    );
  });

  it("reports the hash and size as the file's fingerprint", async () => {
    fakeFetch(() => json(amcItem));
    const file = await od.resolveLocator(session, "FOLDER1:movies.amc");
    expect(file).toMatchObject({ name: "movies.amc", size: 10, fingerprint: "oldhash" });
    expect(od.sourceRefOf(file!)).toBe("onedrive:FOLDER1:movies.amc");
  });

  it("reports 404 as gone but lets a transient failure through", async () => {
    fakeFetch(() => json({ error: { message: "itemNotFound" } }, 404));
    expect(await od.resolveLocator(session, "FOLDER1:movies.amc")).toBeNull();

    // A 5xx must NOT read as "the file is gone" — cloud.ts keeps the cached
    // verdict instead of marking the catalog remote-gone.
    fakeFetch(() => json({ error: { message: "serviceNotAvailable" } }, 503));
    await expect(od.resolveLocator(session, "FOLDER1:movies.amc")).rejects.toThrow(
      /serviceNotAvailable/,
    );
  });

  it("does not mistake a folder of the same name for the file", async () => {
    fakeFetch(() => json({ id: "F", name: "movies.amc", folder: { childCount: 0 } }));
    expect(await od.resolveLocator(session, "FOLDER1:movies.amc")).toBeNull();
  });
});

describe("listAmc", () => {
  it("keeps only .amc files, skips folders, and follows pagination", async () => {
    let page = 0;
    fakeFetch((url) => {
      if (url.endsWith("/me/drive/root")) return json({ id: "ROOT", name: "root", folder: {} });
      page += 1;
      if (page === 1) {
        return json({
          value: [
            { id: "a", name: "movies.amc", size: 1, file: { hashes: { quickXorHash: "x" } } },
            { id: "b", name: "notes.txt", size: 1, file: {} },
            { id: "c", name: "Backups", folder: {} },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
        });
      }
      return json({ value: [{ id: "d", name: "second.amc", size: 2, file: {} }] });
    });

    const files = await od.listAmc(session, "", false);
    expect(files.map((f) => f.name)).toEqual(["movies.amc", "second.amc"]);
    expect(files[1].fingerprint).toBe(""); // unknown hash, never a match
  });
});

describe("sameContent", () => {
  it("matches on hash + size and never on an unknown hash", () => {
    expect(od.sameContent({ fingerprint: "h", size: 5 }, { fingerprint: "h", size: 5 })).toBe(true);
    expect(od.sameContent({ fingerprint: "h", size: 5 }, { fingerprint: "h", size: 6 })).toBe(false);
    expect(od.sameContent({ fingerprint: "", size: 5 }, { fingerprint: "", size: 5 })).toBe(false);
  });
});
