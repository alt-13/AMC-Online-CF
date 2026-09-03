// Poster object keys.
//
// Keys used to be per-movie (`{tenant}/{catalog}/{movie}.jpg`) and were
// OVERWRITTEN when a poster changed. That made them uncacheable: /api/poster had
// to send `must-revalidate`, so every export re-downloaded every poster, and a
// re-import could not tell which bytes R2 already held.
//
// Content-addressed keys fix both at once. The key IS the SHA-256 of the bytes,
// so the object is immutable by construction (cacheable for a year) and "do I
// already have these bytes?" is answerable without any notion of movie identity
// — which the .amc format does not provide anyway (see the design doc on why
// `number + title` is not a merge key).
//
// Per-catalog rather than per-tenant so deleting a catalog can still sweep one
// R2 prefix (worker/index.ts purgeCatalog) without refcounting shared blobs.
//
// Legacy keys are never rewritten; both shapes coexist and `isBlobKey` decides
// which cache policy a key gets.

/** SHA-256 of `bytes` as lowercase hex. WebCrypto, so this works unchanged in
 *  the browser and in a Worker. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Pass the view itself, NOT `bytes.buffer`. Web Crypto accepts any
  // ArrayBufferView and reads only that view's own byteOffset/byteLength, so
  // this is already scoped to just `bytes` — no copy needed. `amc/parser.ts`
  // hands out picture bytes as a `subarray` over the whole multi-megabyte file
  // buffer; passing `.buffer` would hash the entire file's backing buffer
  // instead of just the poster, which is why a `.slice()` copy used to be here.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The content-addressed key for a poster: `{tenant}/{catalog}/blobs/{sha}.jpg`. */
export function blobKey(tenantId: string, catalogId: string, hashHex: string): string {
  return `${tenantId}/${catalogId}/blobs/${hashHex}.jpg`;
}

// Strict on purpose: this predicate is what promises immutability to the browser
// cache for a year. Anything unrecognised falls back to revalidation, which is
// the safe direction. `[^/]+` for the id segments matches a literal ".."
// segment perfectly well (it excludes only "/") — it does NOT reject traversal.
// The explicit `key.includes("..")` check below is the only thing that does:
// a traversal segment substituted for an id segment (e.g.
// "../{catalogId}/blobs/{hash}.jpg") still has four path segments and matches
// this regex, so isBlobKey relies on the guard, not the regex, to reject it.
const BLOB_KEY_RE = /^[^/]+\/[^/]+\/blobs\/[0-9a-f]{64}\.jpg$/;

/** True if `key` is a content-addressed blob key (hence immutable). */
export function isBlobKey(key: string): boolean {
  if (key.includes("..")) return false;
  return BLOB_KEY_RE.test(key);
}
