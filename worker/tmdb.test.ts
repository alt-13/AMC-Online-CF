import { describe, it, expect } from "vitest";
import { parseFind, parseProviders, tmdbUrl } from "./tmdb";
import { isFresh, normRegion, EXTINFO_TTL_MS } from "./extinfo";

describe("parseFind", () => {
  it("prefers the movie result, falls back to tv, else null", () => {
    expect(parseFind({ movie_results: [{ id: 603 }], tv_results: [{ id: 1 }] })).toEqual({ media: "movie", id: 603 });
    expect(parseFind({ movie_results: [], tv_results: [{ id: 1399 }] })).toEqual({ media: "tv", id: 1399 });
    expect(parseFind({ movie_results: [], tv_results: [] })).toBeNull();
    expect(parseFind(null)).toBeNull();
  });
});

describe("parseProviders", () => {
  const data = {
    results: {
      AT: {
        link: "https://www.themoviedb.org/movie/603/watch?locale=AT",
        flatrate: [
          { provider_id: 2, provider_name: "Disney Plus", logo_path: "/d.jpg", display_priority: 5 },
          { provider_id: 8, provider_name: "Netflix", logo_path: "/n.jpg", display_priority: 1 },
        ],
        ads: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.jpg", display_priority: 1 }],
        free: [{ provider_id: 99, provider_name: "Pluto", logo_path: "/p.jpg", display_priority: 0 }],
        rent: [{ provider_id: 3, provider_name: "Apple TV", logo_path: "/a.jpg", display_priority: 0 }],
      },
    },
  };
  it("lists flat-rate, then free, then ads — priority order, each provider once, no rent/buy", () => {
    const p = parseProviders(data, "AT");
    expect(p.link).toBe("https://www.themoviedb.org/movie/603/watch?locale=AT");
    expect(p.list.map((x) => [x.name, x.kind])).toEqual([
      ["Netflix", "flatrate"], ["Disney Plus", "flatrate"], ["Pluto", "free"],
    ]);
    expect(p.list[0].logo).toBe("https://image.tmdb.org/t/p/w92/n.jpg");
  });
  it("a region with no offers is an empty list, not an error", () => {
    expect(parseProviders(data, "US")).toEqual({ link: "", list: [] });
    expect(parseProviders({}, "AT")).toEqual({ link: "", list: [] });
  });
});

describe("tmdbUrl", () => {
  it("sends a v4 read token as Bearer and a v3 key as a query param", () => {
    const [u4, i4] = tmdbUrl("/find/tt1?external_source=imdb_id", "eyJhbGciOi.x.y");
    expect(u4).toBe("https://api.themoviedb.org/3/find/tt1?external_source=imdb_id");
    expect((i4.headers as Record<string, string>).authorization).toBe("Bearer eyJhbGciOi.x.y");
    const [u3, i3] = tmdbUrl("/find/tt1?external_source=imdb_id", "abc123");
    expect(u3).toBe("https://api.themoviedb.org/3/find/tt1?external_source=imdb_id&api_key=abc123");
    expect((i3.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("extinfo helpers", () => {
  it("normRegion accepts two letters only", () => {
    expect(normRegion("at")).toBe("AT");
    expect(normRegion("AUT")).toBeNull();
    expect(normRegion(null)).toBeNull();
    expect(normRegion("A1")).toBeNull();
  });
  it("isFresh is the 7-day window", () => {
    expect(isFresh(0, EXTINFO_TTL_MS - 1)).toBe(true);
    expect(isFresh(0, EXTINFO_TTL_MS)).toBe(false);
  });
});
