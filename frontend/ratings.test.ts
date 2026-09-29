import { describe, it, expect } from "vitest";
import { orderedSources, nativeFormat, storedFormat, toneOf, driftOf, ttOf, visibleProviders } from "./ratings";

describe("visibleProviders", () => {
  const P = (id: number, kind: "flatrate" | "free" | "ads") => ({ id, name: "", logo: "", kind });
  const list = [P(8, "flatrate"), P(2, "flatrate"), P(99, "free"), P(7, "ads")];
  it("shows everything unless mine-only is on", () => {
    expect(visibleProviders(list, { streaming_mine_only: false, streaming_subs: [] })).toEqual(list);
  });
  it("keeps subscribed services plus every free / ads offer", () => {
    expect(visibleProviders(list, { streaming_mine_only: true, streaming_subs: [2] }).map((p) => p.id))
      .toEqual([2, 99, 7]);
  });
});

const R = (imdb: number | null, rt: number | null, metacritic: number | null) => ({ imdb, rt, metacritic });

describe("rating chips", () => {
  it("puts the selected source first, the rest in fixed order", () => {
    expect(orderedSources("rt").map((s) => s.key)).toEqual(["rt", "imdb", "metacritic"]);
    expect(orderedSources("imdb").map((s) => s.key)).toEqual(["imdb", "rt", "metacritic"]);
  });
  it("shows each source in its own site's format", () => {
    expect(nativeFormat("imdb", 87)).toBe("8.7");
    expect(nativeFormat("rt", 93)).toBe("93%");
    expect(nativeFormat("metacritic", 9)).toBe("9");
    expect(nativeFormat("rt", null)).toBe("—");
  });
  it("shows the stored Rating on the app's 0–10 scale", () => {
    expect(storedFormat(93)).toBe("9.3");
    expect(storedFormat(-1)).toBe("—");
    expect(storedFormat(0)).toBe("—");
  });
  it("follows the sites' colour conventions", () => {
    expect(toneOf("rt", 60)).toBe("fresh");
    expect(toneOf("rt", 59)).toBe("rotten");
    expect(toneOf("metacritic", 61)).toBe("good");
    expect(toneOf("metacritic", 40)).toBe("mixed");
    expect(toneOf("metacritic", 39)).toBe("bad");
    expect(toneOf("imdb", 90)).toBe("none");
    expect(toneOf("rt", null)).toBe("none");
  });
  it("flags a stored Rating that no longer matches its source", () => {
    expect(driftOf(87, R(89, null, null), "imdb")).toBe(89);
    expect(driftOf(87, R(87, null, null), "imdb")).toBeNull();
    expect(driftOf(-1, R(87, null, null), "imdb")).toBeNull(); // nothing stored yet
    expect(driftOf(87, R(null, null, null), "imdb")).toBeNull(); // nothing to compare
    expect(driftOf(87, null, "imdb")).toBeNull();
  });
  it("finds the IMDb id in the URL field", () => {
    expect(ttOf("https://www.imdb.com/title/tt0133093/")).toBe("tt0133093");
    expect(ttOf("")).toBeNull();
    expect(ttOf(null)).toBeNull();
  });
});
