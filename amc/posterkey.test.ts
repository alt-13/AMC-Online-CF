import { describe, it, expect } from "vitest";
import { sha256Hex, blobKey, isBlobKey } from "./posterkey";

const T = "11111111-1111-1111-1111-111111111111";
const C = "22222222-2222-2222-2222-222222222222";
const H = "a".repeat(64);

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex digest", async () => {
    const h = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical bytes", async () => {
    const a = await sha256Hex(new Uint8Array([9, 8, 7]));
    const b = await sha256Hex(new Uint8Array([9, 8, 7]));
    expect(a).toBe(b);
  });

  it("differs for different bytes", async () => {
    const a = await sha256Hex(new Uint8Array([1]));
    const b = await sha256Hex(new Uint8Array([2]));
    expect(a).not.toBe(b);
  });

  it("matches the known digest of the empty input", async () => {
    // Canonical SHA-256 of zero bytes.
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("blobKey", () => {
  it("builds the per-catalog blobs path", () => {
    expect(blobKey(T, C, H)).toBe(`${T}/${C}/blobs/${H}.jpg`);
  });
});

describe("isBlobKey", () => {
  it("accepts a well-formed blob key", () => {
    expect(isBlobKey(blobKey(T, C, H))).toBe(true);
  });

  it("rejects legacy per-movie keys", () => {
    expect(isBlobKey(`${T}/${C}/33333333-3333-3333-3333-333333333333.jpg`)).toBe(false);
  });

  it("rejects legacy extra keys", () => {
    expect(isBlobKey(`${T}/${C}/33333333-3333-3333-3333-333333333333/extra-0.jpg`)).toBe(false);
  });

  it("rejects a short, long, or uppercase hash", () => {
    expect(isBlobKey(`${T}/${C}/blobs/${"a".repeat(63)}.jpg`)).toBe(false);
    expect(isBlobKey(`${T}/${C}/blobs/${"a".repeat(65)}.jpg`)).toBe(false);
    expect(isBlobKey(`${T}/${C}/blobs/${"A".repeat(64)}.jpg`)).toBe(false);
  });

  it("rejects a hash with a non-hex character", () => {
    expect(isBlobKey(`${T}/${C}/blobs/${"g".repeat(64)}.jpg`)).toBe(false);
    expect(isBlobKey(`${T}/${C}/blobs/${"z" + "a".repeat(63)}.jpg`)).toBe(false);
  });

  it("rejects extra path segments and traversal", () => {
    expect(isBlobKey(`${T}/${C}/x/blobs/${H}.jpg`)).toBe(false);
    expect(isBlobKey(`${T}/../${C}/blobs/${H}.jpg`)).toBe(false);
  });

  it("rejects a traversal segment standing in for an id segment (4 segments, matches the regex on shape)", () => {
    // `[^/]+` for the id segments matches a literal ".." fine — it's the
    // explicit `key.includes("..")` guard in isBlobKey that must catch this,
    // not BLOB_KEY_RE. This has the same segment count as a real blob key, so
    // it's the case the old (wrong) comment claimed the regex alone rejected.
    expect(isBlobKey(`../${C}/blobs/${H}.jpg`)).toBe(false);
  });

  it("rejects a non-jpg extension", () => {
    expect(isBlobKey(`${T}/${C}/blobs/${H}.png`)).toBe(false);
  });
});
