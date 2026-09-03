// Mega file fingerprint — the `c` node attribute the MEGAsync desktop client
// requires ("file fingerprint missing" when absent).
//
// WHY THIS EXISTS: megajs (like go-mega, like rclone historically) uploads only
// the name attribute `n` — it never sets `c`. That's the exact gap that pushed
// the self-hosted app off rclone onto the native MEGAcmd binary. A Worker can't
// run a native binary, so we compute the fingerprint ourselves (here) and pass
// it to megajs as an extra attribute (see mega.ts).
//
// Algorithm is a faithful port of MEGA SDK src/filefingerprint.cpp
// (FileFingerprint::genfingerprint + serializefingerprint):
//   * 4 CRC32 "lanes", stored big-endian → 16 bytes
//   * followed by the mtime, variable-length encoded (Serialize64)
//   * the whole thing base64url-encoded (MEGA's Base64::btoa, no padding)
//
// Correctness is proven two ways: the CRC32 primitive is checked against the
// canonical test vector (crc32("123456789") === 0xCBF43926) in the unit tests,
// and the full closed loop (upload with our `c` → download → recompute → compare)
// is exercised by the gated integration test — that recompute path is the same
// one the desktop client runs, so a passing loop means the desktop client will
// accept the file.

const MAXFULL = 8192;
const CRC_SIZE = 16; // 4 × uint32
const BLOCK = 64; // sparse sample block size (large-file branch)
const BLOCKS_PER_LANE = MAXFULL / (4 * BLOCK); // = 32

// --- CRC32 (IEEE, reflected — same polynomial as zlib/zip/PNG) --------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Streaming CRC32 so a lane can absorb several disjoint blocks. */
class Crc32 {
  private c = 0xffffffff;
  add(bytes: Uint8Array, begin = 0, end = bytes.length): void {
    let c = this.c;
    for (let i = begin; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    this.c = c;
  }
  result(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

export function crc32(bytes: Uint8Array, begin = 0, end = bytes.length): number {
  const c = new Crc32();
  c.add(bytes, begin, end);
  return c.result();
}

// --- Serialize64 (MEGA variable-length int) --------------------------------
//
// b[0] = number of value bytes, then that many little-endian bytes (at least
// one, so mtime 0 → [1, 0]). Mirrors Serialize64::serialize.

export function serialize64(v: number): Uint8Array {
  const out: number[] = [0];
  let n = Math.max(0, Math.floor(v));
  do {
    out.push(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  out[0] = out.length - 1;
  return Uint8Array.from(out);
}

// --- MEGA base64url (Base64::btoa — url-safe alphabet, no padding) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function megaB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    if (b1 < 0) break;
    out += B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    if (b2 < 0) break;
    out += B64[b2 & 63];
  }
  return out;
}

// --- the 16 CRC bytes -------------------------------------------------------

function writeBE(out: Uint8Array, off: number, v: number): void {
  out[off] = (v >>> 24) & 0xff;
  out[off + 1] = (v >>> 16) & 0xff;
  out[off + 2] = (v >>> 8) & 0xff;
  out[off + 3] = v & 0xff;
}

/** The raw 16-byte CRC portion, exposed for tests. */
export function fingerprintCrc(data: Uint8Array): Uint8Array {
  const crc = new Uint8Array(CRC_SIZE);
  const size = data.length;

  if (size <= CRC_SIZE) {
    // Tiny: the file bytes themselves, NUL-padded to 16.
    crc.set(data.subarray(0, size));
    return crc;
  }

  if (size <= MAXFULL) {
    // Small: one CRC32 per contiguous quarter.
    for (let i = 0; i < 4; i++) {
      const begin = Math.floor((i * size) / 4);
      const end = Math.floor(((i + 1) * size) / 4);
      writeBE(crc, i * 4, crc32(data, begin, end));
    }
    return crc;
  }

  // Large: 4 lanes × 32 blocks of 64 bytes, sampled evenly across the file.
  // Global block index runs 0..127; offset = (size-BLOCK)*idx/127.
  const denom = 4 * BLOCKS_PER_LANE - 1; // 127
  for (let i = 0; i < 4; i++) {
    const lane = new Crc32();
    for (let j = 0; j < BLOCKS_PER_LANE; j++) {
      const idx = i * BLOCKS_PER_LANE + j;
      const offset = Math.floor(((size - BLOCK) * idx) / denom);
      lane.add(data, offset, offset + BLOCK);
    }
    writeBE(crc, i * 4, lane.result());
  }
  return crc;
}

/**
 * Compute the `c` fingerprint attribute value.
 * @param data     the full file bytes
 * @param mtimeSec modification time in whole seconds (File.lastModified/1000,
 *                 or Date.now()/1000 for a freshly built export)
 */
export function computeFingerprint(data: Uint8Array, mtimeSec: number): string {
  const crc = fingerprintCrc(data);
  const mtime = serialize64(mtimeSec);
  const buf = new Uint8Array(crc.length + mtime.length);
  buf.set(crc, 0);
  buf.set(mtime, crc.length);
  return megaB64(buf);
}

// --- reading a fingerprint back --------------------------------------------
//
// Sync status compares the fingerprint we pushed against the one on the remote
// node. But `c` is 4 CRC32 lanes followed by Serialize64(mtime), so comparing
// the whole string also compares the mtime — and a touch that changes only the
// mtime would then read as a CONTENT change and prompt a needless re-import.
//
// So compare the CRC half only. The base64 encoding runs across the CRC/mtime
// join (16 bytes is not a multiple of 3), so the prefix MUST be taken after
// decoding — slicing the string would mix in mtime bits.

/** Inverse of megaB64: decode MEGA's url-safe, unpadded base64. Returns null on
 *  any character outside the alphabet. */
function megaB64Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The CONTENT half of a Mega fingerprint as hex: the 4 CRC32 lanes, with the
 * trailing mtime discarded. Two fingerprints over identical bytes taken at
 * different times give the same value.
 *
 * Returns "" for anything malformed, so a comparison against a garbled stored
 * value reads as "differs" — the safe direction (it prompts a re-check, and a
 * re-import is idempotent).
 */
export function contentCrcOf(fingerprint: string): string {
  const raw = megaB64Decode(fingerprint);
  if (!raw || raw.length < CRC_SIZE) return "";
  return Array.from(raw.subarray(0, CRC_SIZE), (b) => b.toString(16).padStart(2, "0")).join("");
}
