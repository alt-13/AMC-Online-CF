// The Dropbox connector's real logic: the chunked upload-session loop
// (start/append_v2/finish offsets and the overwrite commit), the ASCII-only
// Dropbox-API-Arg header, 409-not_found-vs-transient resolution, and path
// addressing at the account root. Everything else is a fetch away, so a fake
// fetch is the whole harness.

import { describe, it, expect, vi, afterEach } from "vitest";
import { dropboxConnector as dbx } from "./connector-dropbox";

const CHUNK = 8 * 1024 * 1024; // must match the connector's chunk size
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

/** Dropbox reports endpoint errors as 409 + error_summary, not 404. */
const dbxErr = (summary: string, status = 409) => json({ error_summary: summary }, status);

const amcEntry = {
  ".tag": "file",
  id: "id:AAA",
  name: "movies.amc",
  size: 10,
  content_hash: "oldhash",
  path_lower: "/backups/movies.amc",
};

const arg = (init: RequestInit) =>
  JSON.parse((init.headers as Record<string, string>)["Dropbox-API-Arg"]);
const rawArg = (init: RequestInit) => (init.headers as Record<string, string>)["Dropbox-API-Arg"];
const bodyLen = (init: RequestInit) => (init.body as Uint8Array | undefined)?.byteLength ?? 0;

afterEach(() => vi.unstubAllGlobals());

describe("pushToLocator", () => {
  it("chunks through an upload session and commits an in-place overwrite", async () => {
    const bytes = new Uint8Array(CHUNK + 1000); // two chunks
    const calls = fakeFetch((url) => {
      if (url.endsWith("/upload_session/start")) return json({ session_id: "S1" });
      if (url.endsWith("/upload_session/append_v2")) return new Response("", { status: 200 });
      return json({ ...amcEntry, size: bytes.byteLength, content_hash: "new" });
    });

    const seen: number[] = [];
    const stat = await dbx.pushToLocator(session, "/backups:movies.amc", bytes, (done) =>
      seen.push(done),
    );

    expect(stat).toEqual({ fingerprint: "new", size: bytes.byteLength });
    expect(calls.map((c) => c.url)).toEqual([
      "https://content.dropboxapi.com/2/files/upload_session/start",
      "https://content.dropboxapi.com/2/files/upload_session/append_v2",
      "https://content.dropboxapi.com/2/files/upload_session/finish",
    ]);

    // Every byte goes up exactly once, and the append picks up at the offset
    // the start call left behind.
    expect(bodyLen(calls[0].init)).toBe(CHUNK);
    expect(bodyLen(calls[1].init)).toBe(1000);
    expect(arg(calls[1].init).cursor).toEqual({ session_id: "S1", offset: CHUNK });

    const finish = arg(calls[2].init);
    expect(finish.cursor).toEqual({ session_id: "S1", offset: bytes.byteLength });
    expect(finish.commit).toMatchObject({
      path: "/backups/movies.amc",
      mode: "overwrite",
      autorename: false,
    });
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });

  it("uploads a root-level file, where the locator's folder handle is empty", async () => {
    const calls = fakeFetch((url) =>
      url.endsWith("/start") ? json({ session_id: "S1" }) : json({ ...amcEntry, size: 3 }),
    );
    await dbx.pushToLocator(session, ":movies.amc", new Uint8Array(3));
    expect(arg(calls.at(-1)!.init).commit.path).toBe("/movies.amc");
  });

  it("escapes non-ASCII in the Dropbox-API-Arg header", async () => {
    const calls = fakeFetch((url) =>
      url.endsWith("/start") ? json({ session_id: "S1" }) : json({ ...amcEntry, size: 1 }),
    );
    await dbx.pushToLocator(session, "/Filme:Grüße.amc", new Uint8Array(1));

    const header = rawArg(calls.at(-1)!.init);
    // A header is ASCII-only: the umlaut must travel \u-escaped, and must still
    // parse back to the real path.
    expect(header).not.toMatch(/[^\x00-\x7f]/);
    expect(header).toContain("\\u00fc");
    expect(JSON.parse(header).commit.path).toBe("/Filme/Grüße.amc");
  });

  it("surfaces Dropbox's own error summary", async () => {
    fakeFetch(() => dbxErr("path/insufficient_space/..."));
    await expect(
      dbx.pushToLocator(session, "/backups:movies.amc", new Uint8Array(1)),
    ).rejects.toThrow(/insufficient_space/);
  });
});

describe("resolveLocator", () => {
  it("reports the content hash and size as the file's fingerprint", async () => {
    fakeFetch(() => json(amcEntry));
    const file = await dbx.resolveLocator(session, "/backups:movies.amc");
    expect(file).toMatchObject({ name: "movies.amc", size: 10, fingerprint: "oldhash" });
    expect(dbx.sourceRefOf(file!)).toBe("dropbox:/backups:movies.amc");
  });

  it("round-trips a root-level file through its source_ref", async () => {
    const calls = fakeFetch(() => json({ ...amcEntry, path_lower: "/movies.amc" }));
    const file = await dbx.resolveLocator(session, ":movies.amc");
    expect(JSON.parse(String(calls[0].init.body)).path).toBe("/movies.amc");
    expect(dbx.sourceRefOf(file!)).toBe("dropbox::movies.amc");
  });

  it("reports 409 not_found as gone but lets a transient failure through", async () => {
    fakeFetch(() => dbxErr("path/not_found/..."));
    expect(await dbx.resolveLocator(session, "/backups:movies.amc")).toBeNull();

    // A 5xx must NOT read as "the file is gone" — cloud.ts keeps the cached
    // verdict instead of marking the catalog remote-gone.
    fakeFetch(() => new Response("service unavailable", { status: 503 }));
    await expect(dbx.resolveLocator(session, "/backups:movies.amc")).rejects.toThrow(/503|service/);
  });

  it("does not mistake a folder of the same name for the file", async () => {
    fakeFetch(() => json({ ".tag": "folder", name: "movies.amc", path_lower: "/movies.amc" }));
    expect(await dbx.resolveLocator(session, ":movies.amc")).toBeNull();
  });
});

describe("listAmc", () => {
  it("keeps only .amc files, skips folders, and follows the cursor", async () => {
    let page = 0;
    fakeFetch(() => {
      page += 1;
      if (page === 1) {
        return json({
          entries: [
            { ".tag": "file", name: "movies.amc", size: 1, content_hash: "x", path_lower: "/m.amc" },
            { ".tag": "file", name: "notes.txt", size: 1, path_lower: "/notes.txt" },
            { ".tag": "folder", name: "Backups", path_lower: "/backups" },
          ],
          cursor: "CUR",
          has_more: true,
        });
      }
      return json({ entries: [{ ".tag": "file", name: "second.amc", size: 2 }], has_more: false });
    });

    const files = await dbx.listAmc(session, "", true);
    expect(files.map((f) => f.name)).toEqual(["movies.amc", "second.amc"]);
    expect(files[1].fingerprint).toBe(""); // unknown hash, never a match
  });

  it("asks for the account root as \"\", not \"/\"", async () => {
    const calls = fakeFetch(() => json({ entries: [] }));
    await dbx.listAmc(session, "/", false);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ path: "", recursive: false });
  });
});

describe("sameContent", () => {
  it("matches on hash + size and never on an unknown hash", () => {
    expect(dbx.sameContent({ fingerprint: "h", size: 5 }, { fingerprint: "h", size: 5 })).toBe(true);
    expect(dbx.sameContent({ fingerprint: "h", size: 5 }, { fingerprint: "h", size: 6 })).toBe(
      false,
    );
    expect(dbx.sameContent({ fingerprint: "", size: 5 }, { fingerprint: "", size: 5 })).toBe(false);
  });
});
