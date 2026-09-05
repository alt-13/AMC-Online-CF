import { describe, it, expect } from "vitest";
import { sweepAll } from "./sweep";
import type { AuthedFetch } from "./import";

// The R2 sweeps behind DELETE /api/catalog/:id, /import/abort, /supersede and
// /reimport-begin are bounded server-side (a Worker request must not loop over
// an unbounded prefix — rule 7), so correctness now depends on the CLIENT
// finishing the job. These pin that loop.

/** Serves `pages` cursors then reports done; records every path it was called with. */
function stub(cursors: string[], status = 200) {
  const calls: string[] = [];
  let i = 0;
  const fetcher: AuthedFetch = async (path) => {
    calls.push(path);
    const next = i < cursors.length ? cursors[i++] : null;
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ next, superseded: 7 }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetcher };
}

describe("sweepAll", () => {
  it("stops after one request when the server reports no cursor", async () => {
    const { calls, fetcher } = stub([]);
    await sweepAll(fetcher, "/api/catalog/c1", "DELETE");
    expect(calls).toEqual(["/api/catalog/c1"]);
  });

  it("follows the cursor until the prefix is clear", async () => {
    const { calls, fetcher } = stub(["a", "b"]);
    await sweepAll(fetcher, "/api/catalog/c1", "DELETE");
    expect(calls).toEqual(["/api/catalog/c1", "/api/catalog/c1?cursor=a", "/api/catalog/c1?cursor=b"]);
  });

  it("appends the cursor with & when the path already has a query", async () => {
    const { calls, fetcher } = stub(["a"]);
    await sweepAll(fetcher, "/api/import/abort?catalogId=c1");
    expect(calls[1]).toBe("/api/import/abort?catalogId=c1&cursor=a");
  });

  it("resumes from a caller-supplied cursor (supersede hands these back)", async () => {
    const { calls, fetcher } = stub([]);
    await sweepAll(fetcher, "/api/catalog/c2", "DELETE", "page2");
    expect(calls).toEqual(["/api/catalog/c2?cursor=page2"]);
  });

  it("returns the FIRST response body, not the last", async () => {
    const { fetcher } = stub(["a"]);
    const body = await sweepAll<{ superseded?: number }>(fetcher, "/api/catalog/c1/supersede");
    expect(body?.superseded).toBe(7);
  });

  it("treats a 204 (pre-paging Worker) as done", async () => {
    const { calls, fetcher } = stub(["a", "b"], 204);
    await sweepAll(fetcher, "/api/catalog/c1", "DELETE");
    expect(calls).toEqual(["/api/catalog/c1"]);
  });

  it("throws on a failed request rather than looping", async () => {
    const fetcher: AuthedFetch = async () => new Response("nope", { status: 500 });
    await expect(sweepAll(fetcher, "/api/catalog/c1", "DELETE")).rejects.toThrow("500");
  });
});
