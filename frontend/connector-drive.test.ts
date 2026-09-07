// The Drive connector's two pieces of real logic: the resumable upload loop
// (chunk offsets, Content-Range, 308 "resume incomplete") and query escaping.
// Everything else is a fetch away, so a fake fetch is the whole harness.

import { describe, it, expect, vi, afterEach } from "vitest";
import { driveConnector } from "./connector-drive";

const CHUNK = 8 * 1024 * 1024; // must match the connector's chunk size
const session = { token: "tok", request: async () => "fresh-tok" };

interface Call {
  url: string;
  init: RequestInit;
}

/** Install a fetch that answers from `handler` and records every call. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  });
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const existingFile = {
  files: [
    {
      id: "FILE1",
      name: "movies.amc",
      mimeType: "application/octet-stream",
      size: "10",
      md5Checksum: "oldmd5",
      parents: ["FOLDER1"],
    },
  ],
};

const rangeHeader = (init: RequestInit) =>
  (init.headers as Record<string, string> | undefined)?.["Content-Range"];

afterEach(() => vi.unstubAllGlobals());

describe("pushToLocator", () => {
  it("updates the existing file in place and chunks the upload", async () => {
    const bytes = new Uint8Array(CHUNK + 1000); // two chunks
    let put = 0;
    const calls = fakeFetch((url) => {
      if (url.includes("uploadType=resumable")) {
        return json({}, 200, { location: "https://upload.example/session" });
      }
      if (url.includes("/drive/v3/files?")) return json(existingFile);
      // the chunk PUTs
      put += 1;
      if (put === 1) return new Response(null, { status: 308, headers: { range: `bytes=0-${CHUNK - 1}` } });
      return json({ id: "FILE1", name: "movies.amc", size: String(bytes.byteLength), md5Checksum: "newmd5" });
    });

    const seen: number[] = [];
    const stat = await driveConnector.pushToLocator(
      session,
      "FOLDER1:movies.amc",
      bytes,
      (done) => seen.push(done),
    );

    expect(stat).toEqual({ fingerprint: "newmd5", size: bytes.byteLength });

    // Overwrite in place: PATCH on the found id, never a create.
    const initiate = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(initiate.url).toContain("/files/FILE1?");
    expect(initiate.init.method).toBe("PATCH");
    // Drive rejects `parents` on an update.
    expect(String(initiate.init.body)).not.toContain("parents");
    expect((initiate.init.headers as Record<string, string>)["X-Upload-Content-Length"]).toBe(
      String(bytes.byteLength),
    );

    const puts = calls.filter((c) => c.url === "https://upload.example/session");
    expect(puts.map((c) => rangeHeader(c.init))).toEqual([
      `bytes 0-${CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${CHUNK}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    ]);
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });

  it("resumes from the range Drive committed, not from what we sent", async () => {
    const bytes = new Uint8Array(CHUNK + 1000);
    let put = 0;
    const calls = fakeFetch((url) => {
      if (url.includes("uploadType=resumable")) {
        return json({}, 200, { location: "https://upload.example/session" });
      }
      if (url.includes("/drive/v3/files?")) return json(existingFile);
      put += 1;
      // Drive says it kept only the first megabyte of the 8 MiB chunk.
      if (put === 1) return new Response(null, { status: 308, headers: { range: "bytes=0-1048575" } });
      return json({ id: "FILE1", size: String(bytes.byteLength), md5Checksum: "m" });
    });

    await driveConnector.pushToLocator(session, "FOLDER1:movies.amc", bytes);

    const puts = calls.filter((c) => c.url === "https://upload.example/session");
    expect(rangeHeader(puts[1].init)).toBe(`bytes 1048576-${bytes.byteLength - 1}/${bytes.byteLength}`);
  });

  it("creates the file when the folder has no such name", async () => {
    const calls = fakeFetch((url) => {
      if (url.includes("uploadType=resumable")) {
        return json({}, 200, { location: "https://upload.example/session" });
      }
      if (url.includes("/drive/v3/files?")) return json({ files: [] });
      return json({ id: "NEW", size: "3", md5Checksum: "m" });
    });

    await driveConnector.pushToLocator(session, "FOLDER1:movies.amc", new Uint8Array(3));

    const initiate = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(initiate.init.method).toBe("POST");
    expect(String(initiate.init.body)).toContain('"parents":["FOLDER1"]');
  });

  it("surfaces Drive's own error message", async () => {
    fakeFetch(() => json({ error: { message: "Insufficient permissions" } }, 403));
    await expect(
      driveConnector.pushToLocator(session, "FOLDER1:movies.amc", new Uint8Array(1)),
    ).rejects.toThrow(/Insufficient permissions/);
  });
});

describe("resolveLocator", () => {
  it("escapes apostrophes in the name so the query is not broken", async () => {
    const calls = fakeFetch(() => json({ files: [] }));
    await driveConnector.resolveLocator(session, "FOLDER1:Dad's films.amc");
    const q = decodeURIComponent(new URL(calls[0].url).searchParams.get("q") ?? "");
    expect(q).toContain("name='Dad\\'s films.amc'");
  });

  it("is null when the file is gone", async () => {
    fakeFetch(() => json({ files: [] }));
    expect(await driveConnector.resolveLocator(session, "FOLDER1:movies.amc")).toBeNull();
  });

  it("reports the md5 and size as the file's fingerprint", async () => {
    fakeFetch(() => json(existingFile));
    const file = await driveConnector.resolveLocator(session, "FOLDER1:movies.amc");
    expect(file).toMatchObject({ name: "movies.amc", size: 10, fingerprint: "oldmd5" });
    expect(driveConnector.sourceRefOf(file!)).toBe("drive:FOLDER1:movies.amc");
  });
});

describe("listAmc", () => {
  it("keeps only .amc files and skips folders", async () => {
    fakeFetch(() =>
      json({
        files: [
          { id: "a", name: "movies.amc", size: "1", md5Checksum: "x" },
          { id: "b", name: "notes.txt", size: "1" },
          { id: "c", name: "Backups", mimeType: "application/vnd.google-apps.folder" },
        ],
      }),
    );
    const files = await driveConnector.listAmc(session, "", false);
    expect(files.map((f) => f.name)).toEqual(["movies.amc"]);
  });
});

describe("sameContent", () => {
  it("matches on md5 + size", () => {
    expect(driveConnector.sameContent({ fingerprint: "m", size: 5 }, { fingerprint: "m", size: 5 })).toBe(true);
    expect(driveConnector.sameContent({ fingerprint: "m", size: 5 }, { fingerprint: "m", size: 6 })).toBe(false);
    expect(driveConnector.sameContent({ fingerprint: "m", size: 5 }, { fingerprint: "n", size: 5 })).toBe(false);
  });

  it("never calls an unknown fingerprint a match", () => {
    expect(driveConnector.sameContent({ fingerprint: "", size: 5 }, { fingerprint: "", size: 5 })).toBe(false);
  });
});

describe("resolveLocator error handling", () => {
  it("reports 404 as gone but lets a transient failure through", async () => {
    fakeFetch(() => json({ error: { message: "File not found: FOLDER1." } }, 404));
    expect(await driveConnector.resolveLocator(session, "FOLDER1:movies.amc")).toBeNull();

    // A 5xx must NOT read as "the file is gone" — cloud.ts keeps the cached
    // verdict instead of marking the catalog remote-gone.
    fakeFetch(() => json({ error: { message: "Backend Error" } }, 503));
    await expect(driveConnector.resolveLocator(session, "FOLDER1:movies.amc")).rejects.toThrow(
      /Backend Error/,
    );
  });
});
