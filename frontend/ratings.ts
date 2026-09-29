// Display logic for the header's rating chips. Everything arrives on the
// stored 0–100 integer scale (rule 3); this file only decides how to SHOW it.
// The selected source's chip shows the stored Rating field (0.0–10.0); the
// others show their site's own format, so RT's 93 reads "93%", not an
// IMDb-looking "9.3".

import type { RatingSource } from "./fields";
import type { Ratings } from "./api";

export interface SourceMeta { key: RatingSource; short: string; name: string }

export const RATING_SOURCES: readonly SourceMeta[] = [
  { key: "imdb", short: "IMDb", name: "IMDb" },
  { key: "rt", short: "RT", name: "Rotten Tomatoes" },
  { key: "metacritic", short: "MC", name: "Metacritic" },
];

/** Selected first (it is the one mobile keeps), the rest in fixed order. */
export function orderedSources(selected: RatingSource): SourceMeta[] {
  return [
    ...RATING_SOURCES.filter((s) => s.key === selected),
    ...RATING_SOURCES.filter((s) => s.key !== selected),
  ];
}

export function nativeFormat(src: RatingSource, v: number | null): string {
  if (v === null) return "—";
  if (src === "imdb") return (v / 10).toFixed(1);
  return src === "rt" ? `${v}%` : String(v);
}

/** The Rating field as the app shows it everywhere else: 0.0–10.0. */
export const storedFormat = (v: number): string => (v > 0 ? (v / 10).toFixed(1) : "—");

export type Tone = "fresh" | "rotten" | "good" | "mixed" | "bad" | "none";

/** The sites' own conventions: RT "fresh" from 60%; Metacritic green from 61,
 *  yellow 40–60, red below 40. IMDb has none. */
export function toneOf(src: RatingSource, v: number | null): Tone {
  if (v === null || src === "imdb") return "none";
  if (src === "rt") return v >= 60 ? "fresh" : "rotten";
  return v >= 61 ? "good" : v >= 40 ? "mixed" : "bad";
}

/** Full class strings (Tailwind must see them literally). RT's fresh tomato is
 *  red; rotten is muted rather than green so the chips don't shout. */
export const TONE_CLASS: Record<Tone, string> = {
  fresh: "text-danger",
  rotten: "text-muted",
  good: "text-success",
  mixed: "text-warn",
  bad: "text-danger",
  none: "text-text",
};

/** What the source says now, when it disagrees with the stored Rating (hand
 *  edit, or the source moved since the fetch). null = agrees or nothing to
 *  compare — an unset Rating is not "drift", it was simply never fetched. */
export function driftOf(stored: number, ratings: Ratings | null, src: RatingSource): number | null {
  const v = ratings?.[src] ?? null;
  if (v === null || stored <= 0) return null;
  return v === stored ? null : v;
}

/** IMDb id from the URL field — the key ext_info is cached under. */
export const ttOf = (url: string | null | undefined): string | null => /(tt\d+)/.exec(url ?? "")?.[1] ?? null;
