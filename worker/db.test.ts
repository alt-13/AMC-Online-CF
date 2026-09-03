// updateMovie's editable-column whitelist.
//
// `movies.number` is the AMC on-disk catalog number, and in AMC it doubles as
// the SERIES GROUPING key — every entry of a series shares one number (real
// catalogs are full of duplicate 1s, which is why schema.sql deliberately has no
// UNIQUE(catalog_id, number)). The detail form exposes it as "Number (#)", so an
// edit must reach D1.

import { describe, it, expect } from "vitest";
import { updateMovie, normalizeMovieNumber, MAX_MOVIE_NUMBER, type Env } from "./db";

/** Minimal D1 stand-in: records the SQL + bound values of every statement. */
function fakeEnv() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            calls.push({ sql, binds });
            return { run: async () => ({}) };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("updateMovie", () => {
  it("persists an edited movie number", async () => {
    const { env, calls } = fakeEnv();
    await updateMovie(env, "m1", { number: 1, original_title: "Episode 2" });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("number = ?");
    expect(calls[0].binds).toContain(1);
  });

  it("never lets a client move a movie between catalogs or reassign its id", async () => {
    const { env, calls } = fakeEnv();
    await updateMovie(env, "m1", {
      id: "other",
      catalog_id: "someone-elses",
      year: 2001,
    } as never);
    // updated_at is stamped server-side on every update (sync tracking) —
    // it rides along after every explicitly-patched column.
    expect(calls[0].sql).toBe("UPDATE movies SET year = ?, updated_at = ? WHERE id = ?");
    expect(calls[0].binds).toEqual([2001, expect.any(Number), "m1"]);
  });

  it("coerces a client-sent number and drops an unusable one", async () => {
    const { env, calls } = fakeEnv();
    await updateMovie(env, "m1", { number: "3" as never });
    expect(calls[0].binds).toEqual([3, expect.any(Number), "m1"]);

    // `number` is NOT NULL in the schema: a junk value must be ignored, not
    // bound (which would 500 the whole save).
    await updateMovie(env, "m1", { number: null as never, year: 1999 });
    expect(calls[1].sql).toBe("UPDATE movies SET year = ?, updated_at = ? WHERE id = ?");
  });

  it("still stamps updated_at when the patch has nothing else editable", async () => {
    // A PUT reaching updateMovie IS the touch — the row mtime must move even
    // when every other field in the patch is server-owned identity (id/
    // catalog_id) and gets stripped, or the conflict dialog would undercount.
    const { env, calls } = fakeEnv();
    await updateMovie(env, "m1", { id: "x" } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe("UPDATE movies SET updated_at = ? WHERE id = ?");
    expect(calls[0].binds).toEqual([expect.any(Number), "m1"]);
  });
});

describe("normalizeMovieNumber", () => {
  it("accepts non-negative integers, truncates, floors at 0", () => {
    expect(normalizeMovieNumber(1)).toBe(1);
    expect(normalizeMovieNumber(0)).toBe(0); // blank input in the form
    expect(normalizeMovieNumber("42")).toBe(42);
    expect(normalizeMovieNumber(2.7)).toBe(2);
    expect(normalizeMovieNumber(-5)).toBe(0);
  });

  // The exporter writes `number` with setInt32(v | 0), which wraps silently, so
  // anything wider than int32 would come back out of the .amc as a negative.
  it("clamps to what the .amc int32 field can actually hold", () => {
    expect(normalizeMovieNumber(MAX_MOVIE_NUMBER)).toBe(MAX_MOVIE_NUMBER);
    expect(normalizeMovieNumber(3_000_000_000)).toBe(MAX_MOVIE_NUMBER);
    expect(normalizeMovieNumber(Number.MAX_SAFE_INTEGER)).toBe(MAX_MOVIE_NUMBER);
    expect(normalizeMovieNumber("9999999999")).toBe(MAX_MOVIE_NUMBER);
    // Whatever survives normalization must survive the int32 round-trip.
    for (const v of [0, 1, 2.7, -5, 3_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const n = normalizeMovieNumber(v)!;
      expect(n | 0).toBe(n);
    }
  });

  it("rejects values that cannot go in a NOT NULL INTEGER column", () => {
    expect(normalizeMovieNumber(null)).toBeNull();
    expect(normalizeMovieNumber(undefined)).toBeNull();
    expect(normalizeMovieNumber("")).toBeNull();
    expect(normalizeMovieNumber("abc")).toBeNull();
    expect(normalizeMovieNumber(NaN)).toBeNull();
    expect(normalizeMovieNumber(Infinity)).toBeNull();
  });
});
