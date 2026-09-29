// Native OMDb / IMDb lookup for the Worker.
//
// This replaces the old `.ifs` / Python subprocess script runner: the only
// metadata source kept for the POC is IMDb+OMDb, and it now runs as plain
// `fetch()` inside the Worker — no WebSocket, no transpiler, no child process.
//
//   * search  -> IMDb suggestion API (v3.sg.media-imdb.com) — no key required
//   * fetch   -> omdbapi.com                                 — needs OMDB_API_KEY
//
// The parse helpers below are pure (data in, patch out) so they unit-test in
// node without the Cloudflare runtime; the two exported async functions are the
// thin network wrappers.

import type { MovieRow } from "../amc/mapping";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

export interface OmdbSuggestion {
  label: string; // "The Matrix (1999) [tvSeries]"
  tt: string; // "tt0133093"
  url: string; // canonical imdb title url
}

export type RatingSource = "imdb" | "rt" | "metacritic";

/** Every rating OMDb knows for a title, on the STORED scale: an integer 0–100
 *  (rule 3). null = the source has no value for this title. */
export interface Ratings {
  imdb: number | null;
  rt: number | null;
  metacritic: number | null;
}

/** Patch of AMC movie columns an OMDb record maps onto, plus a poster URL the
 *  caller can hand to the picture-from-URL flow, plus every rating for the
 *  header. Only present fields are set in `patch`. */
export interface OmdbResult {
  patch: Partial<MovieRow>;
  poster_url: string; // "" when OMDb returned N/A
  ratings: Ratings;
}

/** Pull a full tt-id out of a URL, a bare tt-id, or a plain number. */
export function extractTt(arg: string): string | null {
  const m = /(tt\d+)/.exec(arg);
  if (m) return m[1];
  const s = arg.trim();
  return /^\d+$/.test(s) ? "tt" + s : null;
}

// --- pure parsers (unit-tested) --------------------------------------------

/** IMDb suggestion payload -> at most 15 movie/series picks. */
export function parseSuggestions(data: unknown): OmdbSuggestion[] {
  const d = (data as { d?: unknown[] })?.d;
  if (!Array.isArray(d)) return [];
  const out: OmdbSuggestion[] = [];
  for (const raw of d.slice(0, 15)) {
    const item = raw as { id?: string; l?: string; y?: number; qid?: string };
    const id = item.id ?? "";
    const title = item.l ?? "";
    if (!id.startsWith("tt") || !title) continue;
    let label = title;
    if (item.y) label += ` (${item.y})`;
    if (item.qid && item.qid !== "movie") label += ` [${item.qid}]`;
    out.push({ label, tt: id, url: `https://www.imdb.com/title/${id}/` });
  }
  return out;
}

/** OMDb record -> all three ratings on the stored 0–100 scale. The factor per
 *  source is fixed: IMDb "8.7" ×10, Rotten Tomatoes "93%" ×1, Metacritic
 *  "74/100" ×1 — so a Metacritic 9 is stored 9 and shown 0.9. */
export function parseRatings(data: Record<string, unknown>): Ratings {
  const num = (v: unknown) => parseFloat(String(v ?? "")); // "N/A" -> NaN
  const out: Ratings = { imdb: null, rt: null, metacritic: null };
  const imdb = num(data.imdbRating);
  if (Number.isFinite(imdb)) out.imdb = Math.round(imdb * 10);
  const list = Array.isArray(data.Ratings) ? (data.Ratings as { Source?: string; Value?: string }[]) : [];
  for (const r of list) {
    const n = num(r.Value);
    if (!Number.isFinite(n)) continue;
    if (r.Source === "Rotten Tomatoes") out.rt = Math.round(n);
    else if (r.Source === "Metacritic") out.metacritic = Math.round(n);
  }
  if (out.metacritic === null) {
    const ms = num(data.Metascore);
    if (Number.isFinite(ms)) out.metacritic = Math.round(ms);
  }
  return out;
}

/** OMDb record -> AMC column patch. Mirrors backend/scripts/OMDB.py, except the
 *  Rating comes from `source` (stored ×10 for IMDb, ×1 for the percentage
 *  sources) and "N/A" is treated as empty. */
export function parseOmdb(
  tt: string,
  data: Record<string, unknown>,
  source: RatingSource = "imdb",
): OmdbResult {
  const v = (key: string): string => {
    const raw = data[key];
    return raw === "N/A" || raw == null ? "" : String(raw);
  };

  const patch: Partial<MovieRow> = {};
  const setStr = (col: keyof MovieRow, val: string) => {
    if (val) (patch as Record<string, unknown>)[col] = val;
  };

  setStr("original_title", v("Title"));
  setStr("director", v("Director"));
  setStr("writer", v("Writer"));
  setStr("actors", v("Actors"));
  setStr("country", v("Country"));

  // "2008–2013" (TV) -> take the start year.
  const year = v("Year").split("–")[0].trim();
  if (/^\d+$/.test(year)) patch.year = parseInt(year, 10);

  // "136 min" -> 136
  const runtime = /(\d+)/.exec(v("Runtime"));
  if (runtime) patch.length = parseInt(runtime[1], 10);

  setStr("category", v("Genre"));

  // The chosen source fills Rating. A source with no value for this title leaves
  // Rating untouched — an IMDb fallback would mix scales without saying so.
  const ratings = parseRatings(data);
  const rating = ratings[source];
  if (rating != null) patch.rating = rating;

  setStr("certification", v("Rated"));
  patch.url = `https://www.imdb.com/title/${tt}/`;
  setStr("description", v("Plot"));
  setStr("languages", v("Language"));

  return { patch, poster_url: v("Poster"), ratings };
}

// --- network wrappers ------------------------------------------------------

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

export async function searchImdb(query: string): Promise<OmdbSuggestion[]> {
  const q = encodeURIComponent(query.trim());
  return parseSuggestions(await getJson(`https://v3.sg.media-imdb.com/suggestion/x/${q}.json`));
}

export async function fetchOmdb(tt: string, apiKey: string, source: RatingSource = "imdb"): Promise<OmdbResult> {
  const data = (await getJson(
    `https://www.omdbapi.com/?i=${encodeURIComponent(tt)}&plot=full&apikey=${encodeURIComponent(apiKey)}`,
  )) as Record<string, unknown>;
  if (data.Response !== "True") {
    throw new Error(`OMDb: ${String(data.Error ?? "unknown error")}`);
  }
  return parseOmdb(tt, data, source);
}
