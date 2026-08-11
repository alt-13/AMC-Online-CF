import { describe, it, expect } from "vitest";
import { parseSuggestions, parseOmdb, extractTt } from "./omdb";
import { newMovieRow, todayDelphi } from "./movie-new";

describe("extractTt", () => {
  it("pulls a tt-id from a URL, a bare id, and a number", () => {
    expect(extractTt("https://www.imdb.com/title/tt0133093/")).toBe("tt0133093");
    expect(extractTt("tt0133093")).toBe("tt0133093");
    expect(extractTt("0133093")).toBe("tt0133093");
  });
  it("returns null for a plain title query", () => {
    expect(extractTt("The Matrix")).toBeNull();
  });
});

describe("parseSuggestions", () => {
  it("keeps only tt-prefixed movie/series picks and labels them", () => {
    const picks = parseSuggestions({
      d: [
        { id: "tt0133093", l: "The Matrix", y: 1999, qid: "movie" },
        { id: "tt0234215", l: "The Matrix Reloaded", y: 2003, qid: "tvSeries" },
        { id: "nm0000206", l: "Keanu Reeves", qid: "name" }, // person -> dropped
        { l: "no id" }, // no id -> dropped
      ],
    });
    expect(picks).toHaveLength(2);
    expect(picks[0]).toEqual({
      label: "The Matrix (1999)",
      tt: "tt0133093",
      url: "https://www.imdb.com/title/tt0133093/",
    });
    // non-"movie" qid is appended in brackets
    expect(picks[1].label).toBe("The Matrix Reloaded (2003) [tvSeries]");
  });
  it("caps at 15 and tolerates junk", () => {
    expect(parseSuggestions({})).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
    const many = { d: Array.from({ length: 30 }, (_, i) => ({ id: `tt${i}`, l: `T${i}` })) };
    expect(parseSuggestions(many)).toHaveLength(15);
  });
});

describe("parseOmdb", () => {
  it("maps OMDb fields to AMC columns, N/A -> empty, rating ×10", () => {
    const { patch, poster_url } = parseOmdb("tt0133093", {
      Response: "True",
      Title: "The Matrix",
      Year: "1999",
      Rated: "R",
      Runtime: "136 min",
      Genre: "Action, Sci-Fi",
      Director: "Lana Wachowski, Lilly Wachowski",
      Writer: "Lilly Wachowski",
      Actors: "Keanu Reeves, Laurence Fishburne",
      Plot: "A hacker learns the truth.",
      Language: "English",
      Country: "United States",
      imdbRating: "8.7",
      Poster: "https://example.com/matrix.jpg",
    });
    expect(patch.original_title).toBe("The Matrix");
    expect(patch.year).toBe(1999);
    expect(patch.length).toBe(136);
    expect(patch.category).toBe("Action, Sci-Fi");
    expect(patch.rating).toBe(87);
    expect(patch.certification).toBe("R");
    expect(patch.url).toBe("https://www.imdb.com/title/tt0133093/");
    expect(patch.languages).toBe("English");
    expect(poster_url).toBe("https://example.com/matrix.jpg");
  });

  it("treats N/A as absent and takes the start year of a TV range", () => {
    const { patch, poster_url } = parseOmdb("tt0903747", {
      Title: "Breaking Bad",
      Year: "2008–2013",
      Runtime: "N/A",
      imdbRating: "N/A",
      Poster: "N/A",
    });
    expect(patch.year).toBe(2008);
    expect("length" in patch).toBe(false);
    expect("rating" in patch).toBe(false);
    expect(poster_url).toBe("");
  });
});

describe("newMovieRow", () => {
  const epochMs = Date.UTC(2026, 0, 1); // 2026-01-01

  it("assigns identity/number and fills schema defaults", () => {
    const row = newMovieRow("uuid-1", "cat-1", 42, {}, epochMs);
    expect(row.id).toBe("uuid-1");
    expect(row.catalog_id).toBe("cat-1");
    expect(row.number).toBe(42);
    expect(row.rating).toBe(-1);
    expect(row.year).toBe(-1);
    expect(row.poster_key).toBeNull();
    expect(row.custom_values).toBe("{}");
    expect(row.date).toBe(todayDelphi(epochMs)); // defaults to "today"
  });

  it("overlays the patch and derives sort_title", () => {
    const row = newMovieRow("id", "cat", 1, {
      original_title: "Inception",
      translated_title: "Inception (DE)",
      year: 2010,
    }, epochMs);
    expect(row.year).toBe(2010);
    expect(row.sort_title).toBe("inception (de)"); // prefers translated title
  });

  it("respects an explicit date in the patch", () => {
    const row = newMovieRow("id", "cat", 1, { date: 1000 }, epochMs);
    expect(row.date).toBe(1000);
  });
});

describe("todayDelphi", () => {
  it("counts whole days from the 1899-12-30 Delphi epoch", () => {
    // 1899-12-31 is day 1.
    expect(todayDelphi(Date.UTC(1899, 11, 31))).toBe(1);
    expect(todayDelphi(Date.UTC(1900, 0, 1))).toBe(2);
  });
});
