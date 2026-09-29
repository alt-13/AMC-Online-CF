// What GET /api/extinfo returns and ext_info caches: the header's data beyond
// the .amc. Display-only — nothing here is ever written to a movie row.

import type { Ratings } from "./omdb";
import type { Providers } from "./tmdb";

export interface ExtInfo {
  ratings: Ratings | null; // null = no OMDb key, or OMDb failed
  providers: Providers | null; // null = no TMDB key, or TMDB failed
  region: string;
  fetched_at: number; // epoch ms
  missing: ("omdb" | "tmdb")[]; // keys the user has not set — the UI hints at Settings
}

/** Offers change monthly and OMDb's free tier is 1000 calls/day: a week keeps
 *  clicking through a catalog nearly free without going badly stale. */
export const EXTINFO_TTL_MS = 7 * 86_400_000;

export const isFresh = (fetchedAt: number, now: number): boolean => now - fetchedAt < EXTINFO_TTL_MS;

/** ISO 3166-1 alpha-2 or nothing — refused before it reaches D1 or TMDB. */
export function normRegion(r: string | null): string | null {
  return r && /^[A-Za-z]{2}$/.test(r) ? r.toUpperCase() : null;
}
