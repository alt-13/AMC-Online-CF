// Offline unit tests for the MEGA fingerprint primitives.
//
// These pin the algorithm to its spec (MEGA SDK src/filefingerprint.cpp) without
// needing a live account: CRC32 against the canonical vector, Serialize64 against
// known encodings, MEGA base64url against Node's own base64url, and the three
// size branches of the CRC portion against hand-computed expectations. The
// closed-loop proof (upload → download → recompute) lives in the gated
// integration test — it can't run offline, but everything it depends on is
// verified here.

import { describe, it, expect } from "vitest";
import {
  crc32,
  serialize64,
  megaB64,
  fingerprintCrc,
  computeFingerprint,
} from "./mega-fingerprint.ts";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
  it("matches the canonical IEEE test vector", () => {
    // The standard check value: crc32("123456789") === 0xCBF43926.
    expect(crc32(ascii("123456789")) >>> 0).toBe(0xcbf43926);
  });

  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0)) >>> 0).toBe(0x00000000);
  });

  it("honours begin/end bounds (matches a manual slice)", () => {
    const data = ascii("XX123456789YY");
    expect(crc32(data, 2, 11) >>> 0).toBe(crc32(ascii("123456789")) >>> 0);
  });
});

describe("serialize64", () => {
  it("encodes 0 as one value byte", () => {
    expect([...serialize64(0)]).toEqual([1, 0]);
  });

  it("encodes small single-byte values", () => {
    expect([...serialize64(255)]).toEqual([1, 255]);
  });

  it("encodes 256 as little-endian two bytes", () => {
    expect([...serialize64(256)]).toEqual([2, 0, 1]);
  });

  it("encodes 0x010203 little-endian", () => {
    expect([...serialize64(0x010203)]).toEqual([3, 3, 2, 1]);
  });

  it("round-trips a plausible mtime (2026-08-08T21:22:24Z)", () => {
    const t = 1786332144; // whole seconds
    const enc = serialize64(t);
    // count byte then LE value bytes; decode and compare.
    let v = 0;
    for (let i = enc[0]; i >= 1; i--) v = v * 256 + enc[i];
    expect(v).toBe(t);
  });
});

describe("megaB64", () => {
  it("uses the url-safe alphabet with no padding, matching Node base64url", () => {
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.from([0]),
      Uint8Array.from([0, 0]),
      Uint8Array.from([255]),
      Uint8Array.from([255, 254, 253]),
      Uint8Array.from([1, 2, 3, 4, 5]), // length % 3 == 2
      Uint8Array.from([1, 2, 3, 4]), //    length % 3 == 1
      Uint8Array.from([251, 255, 191, 254, 255]), // exercises - and _
    ];
    for (const s of samples) {
      const expected = Buffer.from(s).toString("base64url");
      expect(megaB64(s)).toBe(expected);
    }
  });
});

describe("fingerprintCrc — size branches", () => {
  it("tiny (<= 16 bytes): raw bytes, NUL-padded to 16", () => {
    const data = Uint8Array.from([1, 2, 3, 4, 5]);
    const crc = fingerprintCrc(data);
    expect(crc.length).toBe(16);
    expect([...crc.subarray(0, 5)]).toEqual([1, 2, 3, 4, 5]);
    expect([...crc.subarray(5)]).toEqual(new Array(11).fill(0));
  });

  it("tiny boundary (exactly 16 bytes): raw, no padding", () => {
    const data = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    expect([...fingerprintCrc(data)]).toEqual([...data]);
  });

  it("small (16 < size <= 8192): one big-endian CRC32 per contiguous quarter", () => {
    const size = 100;
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) & 0xff);
    const crc = fingerprintCrc(data);
    expect(crc.length).toBe(16);
    for (let i = 0; i < 4; i++) {
      const begin = Math.floor((i * size) / 4);
      const end = Math.floor(((i + 1) * size) / 4);
      const v = crc32(data, begin, end) >>> 0;
      const be = [
        (v >>> 24) & 0xff,
        (v >>> 16) & 0xff,
        (v >>> 8) & 0xff,
        v & 0xff,
      ];
      expect([...crc.subarray(i * 4, i * 4 + 4)]).toEqual(be);
    }
  });

  it("large (> 8192): sparse 4-lane sampling, deterministic and distinct", () => {
    const size = 20000;
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);
    const a = fingerprintCrc(data);
    const b = fingerprintCrc(data);
    expect(a.length).toBe(16);
    expect([...a]).toEqual([...b]); // deterministic

    // Reproduce lane 0 (blocks 0..31, offset = (size-64)*idx/127).
    const BLOCK = 64;
    const BLOCKS_PER_LANE = 32;
    const denom = 127;
    // manual streaming CRC over lane 0's 32 blocks
    let c = 0xffffffff;
    const table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let x = n;
        for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
        t[n] = x >>> 0;
      }
      return t;
    })();
    for (let j = 0; j < BLOCKS_PER_LANE; j++) {
      const idx = 0 * BLOCKS_PER_LANE + j;
      const offset = Math.floor(((size - BLOCK) * idx) / denom);
      for (let k = offset; k < offset + BLOCK; k++) c = table[(c ^ data[k]) & 0xff] ^ (c >>> 8);
    }
    const lane0 = (c ^ 0xffffffff) >>> 0;
    const be0 = [
      (lane0 >>> 24) & 0xff,
      (lane0 >>> 16) & 0xff,
      (lane0 >>> 8) & 0xff,
      lane0 & 0xff,
    ];
    expect([...a.subarray(0, 4)]).toEqual(be0);
  });
});

describe("computeFingerprint", () => {
  const data = Uint8Array.from({ length: 500 }, (_, i) => (i * 13 + 1) & 0xff);

  it("is deterministic for the same data + mtime", () => {
    expect(computeFingerprint(data, 1786332144)).toBe(
      computeFingerprint(data, 1786332144),
    );
  });

  it("changes when the mtime changes", () => {
    expect(computeFingerprint(data, 1786332144)).not.toBe(
      computeFingerprint(data, 1786332145),
    );
  });

  it("changes when the data changes", () => {
    const other = Uint8Array.from(data);
    other[0] ^= 0xff;
    expect(computeFingerprint(data, 1786332144)).not.toBe(
      computeFingerprint(other, 1786332144),
    );
  });

  it("equals megaB64(crcBytes ++ serialize64(mtime))", () => {
    const mtime = 1786332144;
    const crc = fingerprintCrc(data);
    const s64 = serialize64(mtime);
    const buf = new Uint8Array(crc.length + s64.length);
    buf.set(crc, 0);
    buf.set(s64, crc.length);
    expect(computeFingerprint(data, mtime)).toBe(megaB64(buf));
  });
});
