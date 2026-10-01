// Bulk add: a pasted "title + year" list -> one IMDb pick per line, or none.
//
// Pure (no network) so it unit-tests in node; BulkImportDialog.vue does the
// search/fetch/create loop around it.

import type { OmdbSuggestion } from "./api";

export interface BulkLine {
  raw: string; // the line as typed, echoed back in the "not found" list
  title: string;
  year: number | null;
}

/** One film per line. The year is a trailing 4-digit number, optionally in
 *  parens/brackets or after a comma/semicolon/tab/dash: "Heat (1995)",
 *  "Heat, 1995", "Heat\t1995", "Heat 1995". Blank lines are dropped. */
export function parseBulkList(text: string): BulkLine[] {
  const out: BulkLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const m = /^(.*?)[\s,;\t–-]*[([]?((?:18|19|20)\d\d)[)\]]?$/.exec(raw);
    const title = m?.[1].trim();
    out.push(title ? { raw, title, year: +m![2] } : { raw, title: raw, year: null });
  }
  return out;
}

const norm = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

/** The best suggestion for a line, or null when nothing is close enough to
 *  trust unattended. Same title + same year wins; a year off by one is allowed
 *  (festival vs. release year); a different title only counts with an exact
 *  year. Without a year, only an exact title match is accepted. Ties keep
 *  IMDb's own (popularity) order. */
export function bestMatch(line: BulkLine, sugs: OmdbSuggestion[]): OmdbSuggestion | null {
  const want = norm(line.title);
  let best: OmdbSuggestion | null = null;
  let bestScore = Infinity;
  for (const s of sugs) {
    const sameTitle = norm(s.label.replace(/ \(\d{4}\)( \[.*\])?$/, "")) === want;
    const dy = line.year == null || s.year == null ? null : Math.abs(s.year - line.year);
    let score: number;
    if (line.year == null) score = sameTitle ? 0 : Infinity;
    else if (dy === 0) score = sameTitle ? 0 : 2;
    else if (dy === 1 && sameTitle) score = 1;
    else score = Infinity;
    if (score < bestScore) [best, bestScore] = [s, score];
  }
  return best;
}
