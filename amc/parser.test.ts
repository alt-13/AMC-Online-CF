import { describe, it, expect } from "vitest";
import {
  decodeAmcString,
  encodeAmcString,
  parseCatalog,
  serializeCatalog,
} from "./parser";
import { HEADERS, type AMCCatalog } from "./types";

// Legacy .amc files written by the Delphi desktop app store strings as
// Windows-1252 (ANSI) bytes, not UTF-8. The codec must round-trip those bytes
// byte-for-byte (mirroring Python's errors="surrogateescape") or export would
// corrupt the file. Oracle code points below were produced by CPython:
//   bytes.decode("utf-8", "surrogateescape")  /  str.encode("utf-8", "surrogateescape")

const cp = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

describe("legacy non-UTF-8 (ANSI) string codec", () => {
  it("decodes clean UTF-8 to readable text (fast path)", () => {
    const bytes = new TextEncoder().encode("café — Über"); // valid UTF-8
    expect(decodeAmcString(bytes)).toBe("café — Über");
  });

  it("preserves Windows-1252 bytes as surrogate escapes", () => {
    // "Fußball": ß = 0xDF, a single high byte, invalid standalone UTF-8.
    const ansi = Uint8Array.from([0x46, 0x75, 0xdf, 0x62, 0x61, 0x6c, 0x6c]);
    const s = decodeAmcString(ansi);
    expect(cp(s)).toEqual([0x46, 0x75, 0xdcdf, 0x62, 0x61, 0x6c, 0x6c]);
    expect(encodeAmcString(s)).toEqual(ansi); // byte-exact round-trip
  });

  it("matches CPython surrogateescape on the tricky maximal-subpart cases", () => {
    const cases: Array<[number[], number[]]> = [
      // input bytes            -> expected code points
      [[0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72], [0x4d, 0xdcfc, 0x6c, 0x6c, 0x65, 0x72]], // Müller (ü=0xFC)
      [[0xe4, 0x80, 0x41], [0xdce4, 0xdc80, 0x41]], // 2-byte maximal subpart, then 'A'
      [[0xe4, 0x41], [0xdce4, 0x41]], // truncated lead, then 'A'
      [[0xff], [0xdcff]], // lone invalid byte
      [[0xed, 0xa0, 0x80], [0xdced, 0xdca0, 0xdc80]], // UTF-16 surrogate lead, all escaped
      [[0xf0, 0x28, 0x8c, 0x28], [0xdcf0, 0x28, 0xdc8c, 0x28]], // bad 4-byte start
    ];
    for (const [input, expected] of cases) {
      const bytes = Uint8Array.from(input);
      const s = decodeAmcString(bytes);
      expect(cp(s)).toEqual(expected);
      expect(encodeAmcString(s)).toEqual(bytes);
    }
  });

  it("round-trips a mix of clean UTF-8 and escaped bytes", () => {
    // "café" (valid UTF-8) followed by a raw 0xDF (ANSI ß).
    const mixed = Uint8Array.from([0x63, 0x61, 0x66, 0xc3, 0xa9, 0xdf]);
    const s = decodeAmcString(mixed);
    expect(s.slice(0, 4)).toBe("café");
    expect(encodeAmcString(s)).toEqual(mixed);
  });
});

describe("catalog round-trip with a legacy ANSI string", () => {
  it("is byte-identical through parse → serialize and writes real 1252 bytes", () => {
    // v3.5: header + name/mail/site/description, no custom fields, no movies —
    // the smallest complete catalog, enough to carry a legacy string on disk.
    const name = decodeAmcString(Uint8Array.from([0x46, 0x75, 0xdf, 0x62, 0x61, 0x6c, 0x6c])); // "Fußball"
    const catalog: AMCCatalog = {
      version: 35,
      name,
      mail: "",
      site: "",
      description: "",
      cfpColumnSettings: "",
      cfpGuiProperties: "",
      customFieldDefs: [],
      movies: [],
    };

    const bytes = serializeCatalog(catalog);

    // The name must hit the disk as the raw ANSI byte 0xDF — never UTF-8 (0xC3 0x9F)
    // and never the U+FFFD replacement (0xEF 0xBF 0xBD).
    expect(Array.from(bytes)).toContain(0xdf);
    expect(bytes).not.toContain(0xc3);

    const parsed = parseCatalog(bytes);
    expect(parsed.name).toBe(name);
    expect(serializeCatalog(parsed)).toEqual(bytes); // byte-exact
  });

  it("still round-trips a clean UTF-8 catalog name unchanged", () => {
    const catalog: AMCCatalog = {
      version: 35,
      name: "Æther café",
      mail: "",
      site: "",
      description: "",
      cfpColumnSettings: "",
      cfpGuiProperties: "",
      customFieldDefs: [],
      movies: [],
    };
    const bytes = serializeCatalog(catalog);
    const parsed = parseCatalog(bytes);
    expect(parsed.name).toBe("Æther café");
    expect(serializeCatalog(parsed)).toEqual(bytes);
  });
});

// Sanity: the header table the test relies on exists for v3.5.
it("has a v3.5 header", () => expect(HEADERS[35]).toBeDefined());
