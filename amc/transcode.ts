// Codepage transcoding at the browser storage boundary.
//
// Why this exists: the parser preserves legacy (non-UTF-8) bytes as lone
// surrogates (U+DC80..U+DCFF) so a no-edit round-trip is byte-exact. But those
// lone surrogates are destroyed the moment they are stored in D1 (SQLite TEXT is
// UTF-8 — a lone surrogate becomes U+FFFD "�"), so both display and export break
// for ANSI catalogs. See cf/amc/codepages.ts and CLAUDE.md rule 5.
//
// The fix, run entirely in the browser (import.ts / export.ts):
//   import:  toReadable  — reinterpret the raw legacy bytes through a codepage so
//                          umlauts become real Unicode (readable AND D1-safe).
//   export:  toRaw       — the exact inverse, reproducing the on-disk bytes so
//                          serializeCatalog stays byte-identical (the hard gate).
//
// The bridge to raw bytes reuses the already byte-exact parser codec:
//   readable  =  decodeCp( encodeAmcString(parserString), cp )
//   parserStr =  decodeAmcString( encodeCp(readable, cp) )
// encodeAmcString reconstructs the exact original bytes of a parser string, and
// codepage decode/encode is a total bijection, so the full chain is lossless.

import { decodeAmcString, encodeAmcString } from "./parser";
import { decodeCp, encodeCp, type LegacyEncoding, type TextEncoding } from "./codepages";
import type { AMCCatalog } from "./types";

/** A parser string carries a lone low surrogate iff its source bytes were not
 *  valid UTF-8 — i.e. it came from a legacy ANSI catalog. */
function hasSurrogateEscape(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff) return true;
  }
  return false;
}

// --- automatic codepage detection -----------------------------------------
//
// Which legacy codepage a file uses can't be asked of the user (they rarely
// know), so we guess it: decode the non-ASCII bytes with each candidate and
// score how word-like the result is. The right codepage turns high bytes into
// real letters (ä, ł, я); a wrong one turns them into stray symbols (¹, ¾, ¤)
// or C1 controls. Cyrillic (1251) separates cleanly from Latin; among the Latin
// pages, ties (e.g. plain German, whose ä/ö/ü/ß coincide in 1250 and 1252)
// resolve to the first candidate — Windows-1252, the common Western default.

// Candidate order matters: earlier wins ties. Western first (most common),
// then Central-European, then Cyrillic.
const LEGACY_CANDIDATES: readonly LegacyEncoding[] = [
  "windows-1252",
  "windows-1250",
  "windows-1251",
];

// Punctuation that legitimately appears in the 0x80+ range of a Windows page
// (curly quotes, dashes, ellipsis, euro, bullet, section/degree marks).
const COMMON_HIGH_PUNCT = new Set(Array.from("’‘“”„‚–—…€•·§°™«»"));

// "Expected" high letters for each Latin page — the accented letters actually
// common in the languages it serves. Membership scores high; a generic letter
// that isn't expected scores low. This is the crucial discriminator: Cyrillic
// bytes ALIAS to accented-Latin letters under 1252, so counting "letters" alone
// can't tell Russian from Western — but those aliased letters mostly fall
// OUTSIDE these curated sets, while a real Western/CE doc lands inside them.
const WESTERN_HIGH = new Set(
  Array.from(
    "àáâäãåæçèéêëìíîïñòóôõöøùúûüýÿœšžßÀÁÂÄÃÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜŸŒŠŽ",
  ),
);
const CE_HIGH = new Set(
  Array.from(
    // Polish, Czech/Slovak, Hungarian + the accented letters shared with Western.
    "ąćęłńóśźżčďěľĺňŕřšťůžáéíóúäöüőűàâçèêî" +
      "ĄĆĘŁŃÓŚŹŻČĎĚĽĹŇŔŘŠŤŮŽÁÉÍÓÚÄÖÜŐŰ",
  ),
);

const isCyrillic = (cp: number): boolean => cp >= 0x0400 && cp <= 0x04ff;

// Cap how much text we score — a few hundred KB of samples is plenty of signal
// and keeps a huge catalog's import fast.
const SCORE_BYTE_BUDGET = 256 * 1024;

/**
 * Score how well one candidate codepage explains a decoded string. Only 0x80+
 * chars matter (ASCII is identical across candidates, so it can't shift the
 * argmax). Coverage of the page's expected letters is the signal; controls,
 * replacement chars, and stray symbols are penalties.
 */
function scoreDecoded(text: string, cand: LegacyEncoding): number {
  const expected =
    cand === "windows-1251"
      ? (_ch: string, cp: number) => isCyrillic(cp)
      : cand === "windows-1250"
        ? (ch: string) => CE_HIGH.has(ch)
        : (ch: string) => WESTERN_HIGH.has(ch);
  let s = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) continue;
    if ((cp >= 0x80 && cp <= 0x9f) || cp === 0xfffd) s -= 6; // control / replacement
    else if (expected(ch, cp)) s += 4; // an expected letter for this page
    else if (COMMON_HIGH_PUNCT.has(ch)) s += 1; // plausible punctuation
    else if (/\p{L}/u.test(ch)) s += 1; // a letter, but not one this page expects
    else s -= 2; // stray symbol
  }
  return s;
}

/** Pick the legacy codepage that best explains a catalog's non-UTF-8 bytes. */
function detectLegacyEncoding(legacyRawParts: Uint8Array[]): LegacyEncoding {
  let best = LEGACY_CANDIDATES[0];
  let bestScore = -Infinity;
  for (const cand of LEGACY_CANDIDATES) {
    let score = 0;
    for (const part of legacyRawParts) score += scoreDecoded(decodeCp(part, cand), cand);
    if (score > bestScore) {
      bestScore = score; // strict > keeps the earlier candidate on ties
      best = cand;
    }
  }
  return best;
}

/**
 * Deep-clone a value, applying `fn` to every string. Uint8Array (poster bytes)
 * is passed through untouched — binary is never text. Numbers/booleans/null are
 * returned as-is. Every string in the AMC model is an on-disk Pascal string, so
 * mapping them all is exactly the set that needs transcoding.
 */
function deepMapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === "string") return fn(v) as unknown as T;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map((x) => deepMapStrings(x, fn)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k in v) out[k] = deepMapStrings((v as Record<string, unknown>)[k], fn);
    return out as T;
  }
  return v;
}

/**
 * Detect the on-disk text encoding of a freshly-parsed catalog: "utf-8" when
 * every string decoded cleanly, otherwise the legacy single-byte codepage that
 * best explains the non-UTF-8 bytes (auto-detected — see detectLegacyEncoding).
 * Pass `override` to force a specific legacy page (e.g. to correct a rare
 * Latin-2-vs-Latin-1 misdetection); it's ignored for clean UTF-8 catalogs.
 */
export function detectEncoding(cat: AMCCatalog, override?: LegacyEncoding): TextEncoding {
  const legacyRawParts: Uint8Array[] = [];
  let budget = SCORE_BYTE_BUDGET;
  deepMapStrings(cat, (s) => {
    if (budget > 0 && hasSurrogateEscape(s)) {
      const raw = encodeAmcString(s);
      legacyRawParts.push(raw);
      budget -= raw.length;
    }
    return s;
  });
  if (legacyRawParts.length === 0) return "utf-8";
  return override ?? detectLegacyEncoding(legacyRawParts);
}

/**
 * Parsed catalog -> catalog with readable, D1-safe strings. For a UTF-8 catalog
 * this is the identity (returns the same object). For a legacy catalog every
 * string's raw bytes are reinterpreted through `enc`.
 */
export function toReadable(cat: AMCCatalog, enc: TextEncoding): AMCCatalog {
  if (enc === "utf-8") return cat;
  return deepMapStrings(cat, (s) => decodeCp(encodeAmcString(s), enc));
}

/**
 * Readable catalog -> catalog with the parser's raw-byte (surrogate) strings,
 * ready for serializeCatalog. The exact inverse of toReadable.
 */
export function toRaw(cat: AMCCatalog, enc: TextEncoding): AMCCatalog {
  if (enc === "utf-8") return cat;
  return deepMapStrings(cat, (s) => decodeAmcString(encodeCp(s, enc)));
}

/**
 * Re-interpret already-stored readable strings under a different codepage,
 * without going back to the .amc file: reconstruct the raw bytes with the OLD
 * codepage, then decode them with the NEW one. Used by the post-import "change
 * text encoding" override. `from`/`to` must both be legacy pages (there is no
 * ambiguity to fix for a true UTF-8 catalog).
 */
export function reinterpretString(s: string, from: LegacyEncoding, to: LegacyEncoding): string {
  if (from === to) return s;
  return decodeCp(encodeCp(s, from), to);
}
