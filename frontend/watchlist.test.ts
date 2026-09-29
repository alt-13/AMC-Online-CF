// The watchlist is not a table: it is every entry that is not watched, derived
// by ONE function so the list filter, the counts and the header badge can never
// disagree. Rule 13 decides what "watched" means per user.

import { describe, it, expect } from "vitest";
import { isWatched, filterByWatch, watchSplitTip, DEFAULT_SETTINGS } from "./fields";

const synced = { checked_separate: false };
const separate = { checked_separate: true };
const row = (checked: number, date_watched: number) => ({ checked, date_watched });

describe("isWatched", () => {
  it("synced mode reads the stored flag — a legacy tick with no date is still watched", () => {
    expect(isWatched(row(1, 0), synced)).toBe(true);
    expect(isWatched(row(1, 45000), synced)).toBe(true);
    expect(isWatched(row(0, 0), synced)).toBe(false);
  });
  it("separate mode reads only the date; unset (0 or -1) is not watched", () => {
    expect(isWatched(row(1, 0), separate)).toBe(false);
    expect(isWatched(row(0, -1), separate)).toBe(false);
    expect(isWatched(row(0, 45000), separate)).toBe(true);
  });
});

describe("filterByWatch", () => {
  const rows = [row(1, 45000), row(0, 0), row(1, 0)];
  it("'all' is the identity", () => {
    expect(filterByWatch(rows, "all", synced)).toBe(rows);
  });
  it("watched and watchlist partition the rows", () => {
    const w = filterByWatch(rows, "watched", synced);
    const l = filterByWatch(rows, "watchlist", synced);
    expect(w).toEqual([rows[0], rows[2]]);
    expect(l).toEqual([rows[1]]);
    expect(w.length + l.length).toBe(rows.length);
  });
  it("follows the mode", () => {
    expect(filterByWatch(rows, "watchlist", separate)).toEqual([rows[1], rows[2]]);
  });
});

describe("settings defaults", () => {
  it("default to IMDb and the browser's region", () => {
    expect(DEFAULT_SETTINGS.rating_source).toBe("imdb");
    expect(DEFAULT_SETTINGS.streaming_region).toBe("");
  });
});

describe("watchSplitTip", () => {
  it("names both halves", () => {
    expect(watchSplitTip("films", 12, 3)).toBe("12 films watched · 3 on watchlist");
  });
});
