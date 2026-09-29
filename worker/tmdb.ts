// TMDB streaming-offer lookup for the Worker. TMDB's watch-provider data is
// JustWatch's (attribution required — the header says "via JustWatch"). It
// offers ONE link per title and region — TMDB's "where to watch" page — not a
// deep link per service, so every provider icon points at that page.
//
// Pure parsers (unit-tested) + one thin network wrapper, like omdb.ts.

export type ProviderKind = "flatrate" | "free" | "ads";

export interface Provider {
  id: number;
  name: string;
  logo: string; // absolute TMDB image URL, "" when TMDB has none
  kind: ProviderKind;
}

export interface Providers {
  link: string; // TMDB/JustWatch watch page for the region, "" when none
  list: Provider[];
}

const API = "https://api.themoviedb.org/3";
const LOGO_BASE = "https://image.tmdb.org/t/p/w92";
// Rent/buy are deliberately absent: the header shows what you can stream now.
const KINDS: ProviderKind[] = ["flatrate", "free", "ads"];

/** TMDB accepts a v3 API key (?api_key=) or a v4 read-access token (a JWT,
 *  sent as Bearer). Users paste whichever the TMDB settings page shows them. */
export function tmdbUrl(path: string, key: string): [string, RequestInit] {
  const url = new URL(API + path);
  const headers: Record<string, string> = { accept: "application/json" };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  return [url.toString(), { headers }];
}

/** /find by IMDb id -> the TMDB id to ask for providers. Movie wins over TV. */
export function parseFind(data: unknown): { media: "movie" | "tv"; id: number } | null {
  const d = data as { movie_results?: { id?: unknown }[]; tv_results?: { id?: unknown }[] } | null;
  const movie = d?.movie_results?.[0]?.id;
  if (typeof movie === "number") return { media: "movie", id: movie };
  const tv = d?.tv_results?.[0]?.id;
  if (typeof tv === "number") return { media: "tv", id: tv };
  return null;
}

type RawProvider = { provider_id?: unknown; provider_name?: string; logo_path?: string; display_priority?: number };

/** One region's offers: flat-rate first, then free, then with-ads, each in
 *  TMDB's display order. A service listed under several kinds (Netflix in both
 *  flatrate and ads) shows once, under the first. */
export function parseProviders(data: unknown, region: string): Providers {
  const r = (data as { results?: Record<string, Record<string, unknown>> } | null)?.results?.[region];
  if (!r) return { link: "", list: [] };
  const seen = new Set<number>();
  const list: Provider[] = [];
  for (const kind of KINDS) {
    const raw = Array.isArray(r[kind]) ? (r[kind] as RawProvider[]) : [];
    const ordered = [...raw].sort((a, b) => (a.display_priority ?? 0) - (b.display_priority ?? 0));
    for (const p of ordered) {
      if (typeof p.provider_id !== "number" || seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      list.push({
        id: p.provider_id,
        name: p.provider_name ?? "",
        logo: p.logo_path ? LOGO_BASE + p.logo_path : "",
        kind,
      });
    }
  }
  return { link: typeof r.link === "string" ? r.link : "", list };
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

/** IMDb id -> this region's streaming offers (two TMDB calls). */
export async function fetchProviders(tt: string, key: string, region: string): Promise<Providers> {
  const found = parseFind(
    await getJson(...tmdbUrl(`/find/${encodeURIComponent(tt)}?external_source=imdb_id`, key)),
  );
  if (!found) return { link: "", list: [] };
  return parseProviders(
    await getJson(...tmdbUrl(`/${found.media}/${found.id}/watch/providers`, key)),
    region,
  );
}
