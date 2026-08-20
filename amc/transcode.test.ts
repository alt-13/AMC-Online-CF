import { describe, it, expect } from "vitest";
import { decodeAmcString, encodeAmcString, parseCatalog, serializeCatalog } from "./parser";
import { detectEncoding, toReadable, toRaw } from "./transcode";
import { decodeCp, encodeCp } from "./codepages";
import { catalogToRows, rowsToCatalog, type ImportSinks, type ImportResult } from "./mapping";
import type { AMCCatalog, AMCMovie } from "./types";

// The bug this fixes: legacy (non-UTF-8) .amc strings are decoded by the parser
// into lone surrogates (U+DC80..U+DCFF) so their raw bytes can round-trip. Those
// lone surrogates CANNOT be stored in D1 (SQLite TEXT is UTF-8) — the driver
// replaces them with U+FFFD ("�"), corrupting both display and export.
//
// The transcode layer sits at the browser boundary: on import it re-interprets
// the raw legacy bytes through a codepage so umlauts become real Unicode (D1-safe
// AND readable); on export it reverses that exactly, so the on-disk bytes are
// unchanged (the round-trip hard gate).

function makeMovie(overrides: Partial<AMCMovie> = {}): AMCMovie {
  return {
    number: 1, date: 0, dateWatched: 0, userRating: -1, rating: -1, year: -1,
    length: -1, videoBitrate: 0, audioBitrate: 0, disks: 1, colorTag: 0,
    checked: false, media: "", mediaType: "", source: "", borrower: "",
    originalTitle: "Solaris", translatedTitle: "", director: "", producer: "",
    writer: "", composer: "", country: "", category: "", certification: "",
    actors: "", url: "", description: "", comments: "", filePath: "",
    videoFormat: "", audioFormat: "", resolution: "", framerate: "",
    languages: "", subtitles: "", size: "",
    picture: { picPath: "", picData: new Uint8Array(0) },
    customFieldValues: [], extras: [],
    ...overrides,
  };
}

function makeCatalog(movies: AMCMovie[], over: Partial<AMCCatalog> = {}): AMCCatalog {
  return {
    version: 42, name: "Films", mail: "", site: "", description: "",
    cfpColumnSettings: "", cfpGuiProperties: "", customFieldDefs: [], movies,
    ...over,
  };
}

/** True if a string carries a lone low surrogate — the value D1 would mangle. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return true; // any half of a surrogate pair standalone-ish
  }
  return false;
}

/** Simulate exactly what a D1 TEXT column does: JS string -> UTF-8 bytes -> back. */
function throughD1(s: string): string {
  return new TextDecoder("utf-8").decode(new TextEncoder().encode(s));
}

/** Apply the D1 UTF-8 boundary to every string in a value (deep). Mirrors what
 *  SQLite does to each bound TEXT column; Uint8Array (never a TEXT column) is
 *  left alone. */
function throughD1Deep<T>(v: T): T {
  if (typeof v === "string") return throughD1(v) as unknown as T;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(throughD1Deep) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k in v) o[k] = throughD1Deep((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
}

function throughD1Rows(rows: ImportResult): ImportResult {
  return throughD1Deep(rows);
}

describe("codepage transcode (fixes legacy umlaut corruption)", () => {
  it("decodeCp/encodeCp is a byte-exact bijection for Windows-1252", () => {
    const raw = Uint8Array.of(0x46, 0xfc, 0x72, 0x73, 0x74); // "Fürst" (ü=0xFC)
    expect(decodeCp(raw, "windows-1252")).toBe("Fürst");
    expect(encodeCp("Fürst", "windows-1252")).toEqual(raw);
  });

  it("detects a clean UTF-8 catalog as utf-8 and leaves it untouched", () => {
    const cat = makeCatalog([makeMovie({ originalTitle: "café — Über" })]);
    expect(detectEncoding(cat)).toBe("utf-8");
    expect(toReadable(cat, "utf-8")).toBe(cat); // identity, no clone
    expect(toRaw(cat, "utf-8")).toBe(cat);
  });

  it("detects a legacy catalog and makes umlauts readable AND D1-safe", () => {
    // "Müller" in Windows-1252: ü = single byte 0xFC (invalid standalone UTF-8).
    const rawBytes = Uint8Array.of(0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72);
    const parserStr = decodeAmcString(rawBytes); // what parseCatalog produces
    expect(hasLoneSurrogate(parserStr)).toBe(true); // the pre-fix corruption source

    const cat = makeCatalog([makeMovie({ originalTitle: parserStr })]);
    expect(detectEncoding(cat)).toBe("windows-1252");

    const readable = toReadable(cat, "windows-1252");
    const title = readable.movies[0].originalTitle;
    expect(title).toBe("Müller"); // readable
    expect(hasLoneSurrogate(title)).toBe(false); // D1-safe
    expect(throughD1(title)).toBe(title); // survives the D1 UTF-8 boundary intact
    expect(title.includes("�")).toBe(false); // no replacement char
  });

  it("round-trips byte-exact: toRaw(toReadable(x)) reproduces the on-disk bytes", () => {
    const rawBytes = Uint8Array.of(0x44, 0xf6, 0x72, 0x74, 0x68, 0x20, 0xe4, 0xfc, 0xdf); // "Dörth äüß"
    const parserStr = decodeAmcString(rawBytes);
    const cat = makeCatalog(
      [makeMovie({ originalTitle: parserStr, actors: parserStr, extras: [] })],
      { name: parserStr, description: parserStr },
    );
    const enc = detectEncoding(cat);
    const readable = toReadable(cat, enc);
    const back = toRaw(readable, enc);
    // The surrogate representation must be identical, so serializeCatalog is byte-exact.
    expect(back.movies[0].originalTitle).toBe(parserStr);
    expect(back.name).toBe(parserStr);
    expect(encodeAmcString(back.movies[0].originalTitle)).toEqual(rawBytes);
    expect(encodeAmcString(back.movies[0].actors)).toEqual(rawBytes);
  });

  it("auto-detects Cyrillic (Windows-1251) and reads it correctly", () => {
    const rawBytes = encodeCp("Война и мир", "windows-1251");
    const cat = makeCatalog([makeMovie({ originalTitle: decodeAmcString(rawBytes) })]);
    const enc = detectEncoding(cat);
    expect(enc).toBe("windows-1251");
    expect(toReadable(cat, enc).movies[0].originalTitle).toBe("Война и мир");
  });

  it("auto-detects Central-European (Windows-1250) from its distinctive letters", () => {
    // Polish pangram: ł ż ó ć ę ś ą ź ń are junk symbols in 1252 but letters in 1250.
    const rawBytes = encodeCp("Zażółć gęślą jaźń", "windows-1250");
    const cat = makeCatalog([makeMovie({ originalTitle: decodeAmcString(rawBytes) })]);
    const enc = detectEncoding(cat);
    expect(enc).toBe("windows-1250");
    expect(toReadable(cat, enc).movies[0].originalTitle).toBe("Zażółć gęślą jaźń");
  });

  it("auto-detects Western German as Windows-1252 (ä/ö/ü/ß tie-break to 1252)", () => {
    const rawBytes = encodeCp("Fußball Köln Müller Straße Gefährten", "windows-1252");
    const cat = makeCatalog([makeMovie({ originalTitle: decodeAmcString(rawBytes) })]);
    expect(detectEncoding(cat)).toBe("windows-1252");
  });

  it("does NOT misdetect a German catalog as Cyrillic (the schöner→schцner bug)", () => {
    // Reproduces the real failure: a German (ASCII-dominant) catalog whose ö byte
    // 0xF6 was read as Windows-1251 'ц'. The description carries a few bytes that
    // are stray symbols in 1252 (¸¨´) but Cyrillic letters in 1251 — enough to tip
    // the raw coverage score to Cyrillic. The Cyrillic-dominance gate must still
    // keep it Latin, because the catalog is overwhelmingly ASCII.
    const title = decodeAmcString(encodeCp("Wunderschöner", "windows-1252"));
    const asciiDesc = new TextEncoder().encode(
      "Ein wunderschoener Film ueber Liebe und Leben in Berlin mit Herz und Seele",
    );
    const tippingBytes = Uint8Array.of(0xb8, 0xb8, 0xb8, 0xb8, 0xa8, 0xb4); // ё ё ё ё Ё ґ in 1251
    const desc = decodeAmcString(Uint8Array.from([...asciiDesc, ...tippingBytes]));
    const cat = makeCatalog([makeMovie({ originalTitle: title, description: desc })]);

    const enc = detectEncoding(cat);
    expect(enc).toBe("windows-1252"); // NOT windows-1251
    expect(toReadable(cat, enc).movies[0].originalTitle).toBe("Wunderschöner");
  });

  it("honours an explicit legacy-encoding override over auto-detection", () => {
    const rawBytes = encodeCp("Война и мир", "windows-1251");
    const cat = makeCatalog([makeMovie({ originalTitle: decodeAmcString(rawBytes) })]);
    expect(detectEncoding(cat, "windows-1250")).toBe("windows-1250"); // forced
  });

  it("is byte-exact through the FULL browser→D1→browser→export path", async () => {
    // This is the regression guard the original in-memory round-trip test missed:
    // it crosses the real D1 boundary (SQLite TEXT is UTF-8). A v3.5 catalog with
    // a legacy ANSI name + movie title, serialized to the exact on-disk bytes.
    const name = decodeAmcString(Uint8Array.of(0x46, 0x75, 0xdf, 0x62, 0x61, 0x6c, 0x6c)); // "Fußball"
    const title = decodeAmcString(Uint8Array.of(0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72)); // "Müller"
    const original = serializeCatalog({
      version: 35, name, mail: "", site: "", description: "",
      cfpColumnSettings: "", cfpGuiProperties: "", customFieldDefs: [],
      movies: [makeMovie({ originalTitle: title })],
    });

    // 1. import: parse -> detect -> make readable
    const parsed = parseCatalog(original);
    const enc = detectEncoding(parsed);
    expect(enc).toBe("windows-1252");
    const readable = toReadable(parsed, enc);

    // 2. flatten to rows (browser import.ts)
    const sinks: ImportSinks = { newId: () => "id", now: () => 0, putPoster: async (_b, k) => k };
    const rows = await catalogToRows(readable, "tenant", sinks, "cat", null, enc);
    expect(rows.catalog.text_encoding).toBe("windows-1252");

    // 3. store in D1: every TEXT column round-trips through UTF-8. A lone surrogate
    //    here would silently become U+FFFD — so this step must be a no-op.
    const stored = throughD1Rows(rows);
    expect(JSON.stringify(stored)).not.toContain("�");
    expect(stored.movies[0].original_title).toBe("Müller"); // readable, intact
    expect(stored.catalog.name).toBe("Fußball");

    // 4. export: rows -> catalog -> re-encode to on-disk codepage -> serialize
    const rebuilt = await rowsToCatalog({
      catalog: stored.catalog,
      customFieldDefs: stored.customFieldDefs,
      movies: stored.movies,
      extrasByMovie: new Map(),
      getPoster: async () => new Uint8Array(0),
    });
    const out = serializeCatalog(toRaw(rebuilt, stored.catalog.text_encoding as never));

    expect(Array.from(out)).toEqual(Array.from(original)); // byte-identical
  });

  it("never transcodes binary poster bytes (picData)", () => {
    const rawBytes = Uint8Array.of(0x4d, 0xfc); // legacy title, forces legacy mode
    const picData = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00); // JPEG-ish bytes
    const cat = makeCatalog([
      makeMovie({
        originalTitle: decodeAmcString(rawBytes),
        picture: { picPath: "x.jpg", picData },
      }),
    ]);
    const readable = toReadable(cat, "windows-1252");
    expect(readable.movies[0].picture.picData).toEqual(picData); // untouched
  });
});
