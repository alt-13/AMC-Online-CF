import { describe, it, expect } from "vitest";
import { parseBulkList, bestMatch } from "./bulk";
import type { OmdbSuggestion } from "./api";

const sug = (l: string, y: number, tt: string): OmdbSuggestion => ({
  label: `${l} (${y})`, tt, url: "", year: y, kind: "movie",
});

describe("parseBulkList", () => {
  it("reads the year in every common shape and skips blanks", () => {
    expect(parseBulkList("Heat (1995)\n\nAlien, 1979\r\nBlade Runner\t1982\n2001: A Space Odyssey 1968\nUp\n"))
      .toEqual([
        { raw: "Heat (1995)", title: "Heat", year: 1995 },
        { raw: "Alien, 1979", title: "Alien", year: 1979 },
        { raw: "Blade Runner\t1982", title: "Blade Runner", year: 1982 },
        { raw: "2001: A Space Odyssey 1968", title: "2001: A Space Odyssey", year: 1968 },
        { raw: "Up", title: "Up", year: null },
      ]);
  });
  it("a bare year-title stays a title", () => {
    expect(parseBulkList("1917")).toEqual([{ raw: "1917", title: "1917", year: null }]);
  });
});

describe("bestMatch", () => {
  const sugs = [sug("Heat", 2013, "tt1"), sug("Heat Wave", 1995, "tt2"), sug("Heat", 1995, "tt3")];
  const line = (title: string, year: number | null) => ({ raw: title, title, year });

  it("prefers same title + year over IMDb order", () => {
    expect(bestMatch(line("heat", 1995), sugs)?.tt).toBe("tt3");
  });
  it("allows a year off by one only for the same title", () => {
    expect(bestMatch(line("Heat", 1996), sugs)?.tt).toBe("tt3");
    expect(bestMatch(line("Heat Waves", 1996), sugs)).toBeNull();
  });
  it("takes a different title only with an exact year", () => {
    expect(bestMatch(line("Hitze", 2013), sugs)?.tt).toBe("tt1");
    expect(bestMatch(line("Hitze", 2000), sugs)).toBeNull();
  });
  it("without a year needs an exact title", () => {
    expect(bestMatch(line("Heat", null), sugs)?.tt).toBe("tt1");
    expect(bestMatch(line("Heat W", null), sugs)).toBeNull();
  });
  it("ignores punctuation/accents and the [kind] suffix", () => {
    expect(bestMatch(line("Amelie", 2001), [{ ...sug("Amélie", 2001, "tt9"), label: "Amélie (2001) [tvMovie]" }])?.tt).toBe("tt9");
  });
});
