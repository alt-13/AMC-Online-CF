// What counts as a "series" is a per-catalog convention, not a format fact, so
// the interesting cases here are the ones where a plausible-looking rule gives a
// confidently wrong answer.

import { describe, it, expect } from "vitest";
import {
  countSeries, DEFAULT_SETTINGS, DEFAULT_CERTIFICATION_VALUES, type SeriesRule,
} from "./fields";

const rows = (...numbers: number[]) =>
  numbers.map((number) => ({ number, certification: "" }));
const certs = (...values: string[]) =>
  values.map((certification, i) => ({ number: i + 1, certification }));

describe("countSeries", () => {
  it("shows nothing until the user states a rule", () => {
    // The default must not guess: an unconfigured catalog gets no counts at all,
    // not "0 films / 0 series" and not a number derived from someone else's
    // numbering convention.
    expect(DEFAULT_SETTINGS.series_rule).toEqual({ kind: "off" });
    expect(countSeries(rows(1, 1, 2, 3), DEFAULT_SETTINGS.series_rule)).toBeNull();
    expect(countSeries(rows(1, 2), undefined)).toBeNull();
    expect(countSeries(rows(1, 2), { kind: "off" })).toBeNull();
  });

  describe("number_is — every entry with this number is a series", () => {
    const rule: SeriesRule = { kind: "number_is", number: 1 };

    it("counts each entry carrying the number as one series", () => {
      // The catalog convention this serves: all series parked under a single
      // number so they sort alphabetically together.
      expect(countSeries(rows(1, 1, 1, 7, 8, 9), rule)).toEqual({ films: 3, series: 3 });
    });

    it("reports an all-films catalog as zero series", () => {
      expect(countSeries(rows(4, 5, 6), rule)).toEqual({ films: 3, series: 0 });
    });

    it("honours a number other than 1", () => {
      expect(countSeries(rows(1, 99, 99, 2), { kind: "number_is", number: 99 }))
        .toEqual({ films: 2, series: 2 });
    });

    it("handles an empty catalog", () => {
      expect(countSeries([], rule)).toEqual({ films: 0, series: 0 });
    });
  });

  describe("certification_in — certification matches one of the user's values", () => {
    const rule: SeriesRule = { kind: "certification_in", values: DEFAULT_CERTIFICATION_VALUES };

    it("counts entries whose certification is in the list", () => {
      expect(countSeries(
        certs("TV Series", "TV Mini-Series", "PG-13", "R", ""),
        rule,
      )).toEqual({ films: 3, series: 2 });
    });

    it("ignores case and surrounding whitespace on both sides", () => {
      expect(countSeries(certs("  tv series ", "TV SERIES"), rule))
        .toEqual({ films: 0, series: 2 });
      expect(countSeries(certs("TV Series"), { kind: "certification_in", values: ["  TV SERIES  "] }))
        .toEqual({ films: 0, series: 1 });
    });

    it("matches whole values, never substrings", () => {
      // "Not a TV Series" contains the term but is not the certification.
      expect(countSeries(certs("Not a TV Series", "TV Series Vol. 2"), rule))
        .toEqual({ films: 2, series: 0 });
    });

    it("treats an empty or blank-only list as matching nothing", () => {
      // A half-configured rule must read "0 series", never "everything".
      expect(countSeries(certs("TV Series", "R"), { kind: "certification_in", values: [] }))
        .toEqual({ films: 2, series: 0 });
      expect(countSeries(certs("TV Series", "R"), { kind: "certification_in", values: ["", "  "] }))
        .toEqual({ films: 2, series: 0 });
    });

    it("does not count entries with no certification at all", () => {
      expect(countSeries(certs("", "", ""), rule)).toEqual({ films: 3, series: 0 });
    });

    it("accepts values the user added beyond the defaults", () => {
      expect(countSeries(
        certs("Doku-Serie", "TV Series", "R"),
        { kind: "certification_in", values: [...DEFAULT_CERTIFICATION_VALUES, "Doku-Serie"] },
      )).toEqual({ films: 1, series: 2 });
    });

    it("handles an empty catalog", () => {
      expect(countSeries([], rule)).toEqual({ films: 0, series: 0 });
    });
  });

  describe("number_shared — a number used by 2+ entries is one series", () => {
    const rule: SeriesRule = { kind: "number_shared" };

    it("counts a series once, not once per episode", () => {
      // 6 episodes sharing number 1, plus 3 standalone films.
      expect(countSeries(rows(1, 1, 1, 1, 1, 1, 7, 8, 9), rule))
        .toEqual({ films: 3, series: 1 });
    });

    it("does NOT flag the first film in a fresh catalog as a series", () => {
      // nextMovieNumber() hands out MAX+1, i.e. 1 for an empty catalog. Under a
      // naive `number === 1` rule that lone film reads as "0 films / 1 series";
      // grouping gets it right because nothing else shares the number.
      expect(countSeries(rows(1), rule)).toEqual({ films: 1, series: 0 });
    });

    it("counts several distinct series separately", () => {
      expect(countSeries(rows(1, 1, 2, 2, 2, 3), rule)).toEqual({ films: 1, series: 2 });
    });

    it("handles an empty catalog", () => {
      expect(countSeries([], rule)).toEqual({ films: 0, series: 0 });
    });
  });
});
