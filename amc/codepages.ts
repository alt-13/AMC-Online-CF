// Single-byte legacy codepage codecs (Windows-125x) for legacy .amc strings.
//
// Files written by the Delphi desktop app store text in a Windows ANSI codepage,
// not UTF-8 (see CLAUDE.md rule 5). The parser preserves those raw bytes as lone
// surrogates so a no-edit round-trip is byte-exact — but lone surrogates cannot
// be stored in D1 (SQLite TEXT is UTF-8; they become U+FFFD "�") and never
// display as the intended umlaut. This module re-interprets the raw bytes through
// the correct codepage: decode makes them readable + D1-safe, encode reverses it.
//
// Each Windows-125x page is a TOTAL, BIJECTIVE single-byte mapping (verified: all
// 256 byte values decode to distinct code points, none to U+FFFD), so
// decodeCp/encodeCp is a lossless round-trip — the byte-exact export hard gate
// depends on that.
//
// NOTE: decode uses the platform TextDecoder, which supports these encodings in
// browsers and Node. All transcoding runs in the BROWSER (import.ts / export.ts),
// never in the Worker, so the Worker's limited TextDecoder is never involved.

export type LegacyEncoding = "windows-1252" | "windows-1250" | "windows-1251";
export type TextEncoding = "utf-8" | LegacyEncoding;

/** Legacy codepages offered in the UI, most common first. */
export const LEGACY_ENCODINGS: ReadonlyArray<{ id: LegacyEncoding; label: string }> = [
  { id: "windows-1252", label: "Western European (Windows-1252)" },
  { id: "windows-1250", label: "Central European (Windows-1250)" },
  { id: "windows-1251", label: "Cyrillic (Windows-1251)" },
];

const decoders = new Map<LegacyEncoding, TextDecoder>();
const reverseMaps = new Map<LegacyEncoding, Map<string, number>>();

function decoderFor(cp: LegacyEncoding): TextDecoder {
  let d = decoders.get(cp);
  if (!d) {
    d = new TextDecoder(cp);
    decoders.set(cp, d);
  }
  return d;
}

/** char -> byte, built once per codepage by decoding every byte value. */
function reverseFor(cp: LegacyEncoding): Map<string, number> {
  let rev = reverseMaps.get(cp);
  if (!rev) {
    rev = new Map();
    const d = decoderFor(cp);
    const one = new Uint8Array(1);
    for (let b = 0; b < 256; b++) {
      one[0] = b;
      rev.set(d.decode(one), b);
    }
    reverseMaps.set(cp, rev);
  }
  return rev;
}

/** Decode raw legacy bytes to readable Unicode. */
export function decodeCp(bytes: Uint8Array, cp: LegacyEncoding): string {
  return decoderFor(cp).decode(bytes);
}

/**
 * Encode readable Unicode back to the codepage's raw bytes. Every char that came
 * from decodeCp maps back to exactly one byte (bijection). A char OUTSIDE the
 * codepage — only possible if a user typed one while editing — has no byte in
 * this ANSI page and is written as '?' (0x3F), the same lossy fallback the
 * desktop app would apply. Imported data never hits that path.
 */
export function encodeCp(s: string, cp: LegacyEncoding): Uint8Array {
  const rev = reverseFor(cp);
  const out: number[] = [];
  for (const ch of s) {
    const b = rev.get(ch);
    out.push(b ?? 0x3f);
  }
  return Uint8Array.from(out);
}
