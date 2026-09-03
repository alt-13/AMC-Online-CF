import { describe, it, expect } from "vitest";
import { exportAmcFile, type AuthedFetch } from "./export";
import { parseCatalog } from "../amc/parser";
import { clampPagingParam } from "../worker/index";

// Export used to await one poster fetch per movie inside the rebuild loop, so a
// catalog with N posters cost N sequential round-trips. These tests pin the two
// properties that must hold once the fetches run concurrently: each distinct key
// is fetched once, and the rebuilt file does not depend on completion order.

const T = "tenant-1";
const KEY_A = `${T}/cat-1/blobs/${"a".repeat(64)}.jpg`;
const KEY_B = `${T}/cat-1/blobs/${"b".repeat(64)}.jpg`;
const KEY_C = `${T}/cat-1/blobs/${"c".repeat(64)}.jpg`;

function movieRow(id: string, number: number, title: string, poster_key: string | null) {
  return {
    id, catalog_id: "cat-1", number, date: 0, date_watched: 0, user_rating: -1,
    rating: -1, year: -1, length: -1, video_bitrate: 0, audio_bitrate: 0,
    disks: 1, color_tag: 0, checked: 0, media: "", media_type: "", source: "",
    borrower: "", original_title: title, translated_title: "", director: "",
    producer: "", writer: "", composer: "", country: "", category: "",
    certification: "", actors: "", url: "", description: "", comments: "",
    file_path: "", video_format: "", audio_format: "", resolution: "",
    framerate: "", languages: "", subtitles: "", size: "",
    pic_path: poster_key ? ".jpg" : "", poster_key,
    custom_values: "{}", sort_title: title.toLowerCase(),
  };
}

/** An extras row (movie_id must match one of `BUNDLE.movies`' ids). */
function extraRow(id: string, movie_id: string, ordinal: number, poster_key: string | null) {
  return {
    id, movie_id, ordinal, checked: 0, tag: "", title: "Behind the scenes",
    category: "", url: "", description: "", comments: "", created_by: "",
    pic_path: poster_key ? ".jpg" : "", poster_key,
  };
}

const BUNDLE = {
  catalog: {
    id: "cat-1", tenant_id: T, version: 42, name: "Films", mail: "", site: "",
    description: "", cfp_column_settings: "", cfp_gui_properties: "",
    text_encoding: "utf-8", source_ref: null, created_at: 0, updated_at: 0,
  },
  customFieldDefs: [],
  // Two movies deliberately SHARE key A, so a correct implementation fetches it once.
  movies: [
    movieRow("m1", 1, "Stalker", KEY_A),
    movieRow("m2", 2, "Solaris", KEY_A),
    movieRow("m3", 3, "Mirror", KEY_B),
    movieRow("m4", 4, "No Poster", null),
  ],
  extras: [],
};

/**
 * Answer the three `?part=` shapes export.ts requests (meta/movies/extras —
 * the only shapes the Worker route supports) for a given bundle. Shared by
 * every stub below so each only has to describe its posters.
 */
function exportResponse(bundle: typeof BUNDLE, path: string): Response {
  const u = new URL(path, "http://x");
  const part = u.searchParams.get("part");
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (part === "meta") {
    return json({
      catalog: bundle.catalog,
      customFieldDefs: bundle.customFieldDefs,
      movieCount: bundle.movies.length,
      extraCount: bundle.extras.length,
    });
  }
  if (part === "movies" || part === "extras") {
    const rows = part === "movies" ? bundle.movies : bundle.extras;
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? rows.length);
    return json(rows.slice(offset, offset + limit));
  }
  throw new Error(`exportResponse: unexpected part ${String(part)}`);
}

/** Stub fetcher. `delay(key)` lets a test invert completion order. */
function stub(opts: { delay?: (key: string) => number; failKey?: string } = {}) {
  const posterCalls: string[] = [];
  const fetcher: AuthedFetch = async (path) => {
    if (path.includes("/export")) {
      return exportResponse(BUNDLE, path);
    }
    if (path.startsWith("/api/poster")) {
      const key = decodeURIComponent(new URL(path, "http://x").searchParams.get("key")!);
      posterCalls.push(key);
      if (opts.failKey === key) return new Response("nope", { status: 500 });
      const ms = opts.delay?.(key) ?? 0;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      // One deterministic byte per key, so the rebuilt file encodes which bytes
      // landed on which movie.
      return new Response(new Uint8Array([key === KEY_A ? 0xaa : 0xbb]));
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { fetcher, posterCalls };
}

describe("exportAmcFile poster prefetch", () => {
  it("fetches each distinct poster key exactly once", async () => {
    const { fetcher, posterCalls } = stub();
    await exportAmcFile("cat-1", { tenantId: T, fetcher });
    expect(posterCalls.sort()).toEqual([KEY_A, KEY_B]);
  });

  it("prefetches an extra's poster key too, not just movies'", async () => {
    // Mirror's extra deliberately uses a THIRD key so this can't pass by
    // accident via the movie-level KEY_A/KEY_B coverage above.
    const bundle = { ...BUNDLE, extras: [extraRow("x1", "m3", 0, KEY_C)] };
    const posterCalls: string[] = [];
    const fetcher: AuthedFetch = async (path) => {
      if (path.includes("/export")) {
        return exportResponse(bundle, path);
      }
      if (path.startsWith("/api/poster")) {
        const key = decodeURIComponent(new URL(path, "http://x").searchParams.get("key")!);
        posterCalls.push(key);
        const byte = key === KEY_A ? 0xaa : key === KEY_B ? 0xbb : 0xcc;
        return new Response(new Uint8Array([byte]));
      }
      throw new Error(`unexpected path ${path}`);
    };

    const blob = await exportAmcFile("cat-1", { tenantId: T, fetcher });
    expect(posterCalls).toContain(KEY_C);

    // Pin the whole path, not just the fetch: the extra's bytes must land on
    // the right movie's extra in the rebuilt file.
    const parsed = parseCatalog(new Uint8Array(await blob.arrayBuffer()));
    const mirror = parsed.movies.find((mv) => mv.originalTitle === "Mirror")!;
    expect(mirror.extras).toHaveLength(1);
    expect(Array.from(mirror.extras[0].picture.picData)).toEqual([0xcc]);
  });

  it("rebuilds identically when responses complete out of order", async () => {
    // Run once with A slow, once with B slow; the bytes must match.
    const slowA = stub({ delay: (k) => (k === KEY_A ? 20 : 0) });
    const slowB = stub({ delay: (k) => (k === KEY_B ? 20 : 0) });
    const [one, two] = await Promise.all([
      exportAmcFile("cat-1", { tenantId: T, fetcher: slowA.fetcher }),
      exportAmcFile("cat-1", { tenantId: T, fetcher: slowB.fetcher }),
    ]);
    const a = new Uint8Array(await one.arrayBuffer());
    const b = new Uint8Array(await two.arrayBuffer());
    expect(a).toEqual(b);
  });

  it("puts the right bytes on the right movies", async () => {
    const { fetcher } = stub();
    const blob = await exportAmcFile("cat-1", { tenantId: T, fetcher });
    const parsed = parseCatalog(new Uint8Array(await blob.arrayBuffer()));
    const byTitle = new Map(parsed.movies.map((mv) => [mv.originalTitle, mv]));
    expect(Array.from(byTitle.get("Stalker")!.picture.picData)).toEqual([0xaa]);
    expect(Array.from(byTitle.get("Solaris")!.picture.picData)).toEqual([0xaa]);
    expect(Array.from(byTitle.get("Mirror")!.picture.picData)).toEqual([0xbb]);
    expect(byTitle.get("No Poster")!.picture.picData.length).toBe(0);
  });

  it("reports progress against the distinct-key count", async () => {
    const { fetcher } = stub();
    const seen: Array<[number, number]> = [];
    await exportAmcFile("cat-1", {
      tenantId: T, fetcher,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.every(([, total]) => total === 2)).toBe(true);
    expect(seen[seen.length - 1][0]).toBe(2);
  });

  it("rejects when a poster fetch fails", async () => {
    const { fetcher } = stub({ failKey: KEY_B });
    await expect(exportAmcFile("cat-1", { tenantId: T, fetcher })).rejects.toThrow(/poster fetch failed/);
  });

  it("fetches posters concurrently, not one after another", async () => {
    let live = 0;
    let peak = 0;
    // Enough distinct keys to exceed PREFETCH_CONCURRENCY, so the pool is
    // genuinely exercised rather than trivially satisfied.
    const keys = Array.from({ length: 12 }, (_, i) => `${T}/cat-1/blobs/${String(i).padStart(64, "0")}.jpg`);
    const movies = keys.map((k, i) => movieRow(`m${i}`, i + 1, `Film ${i}`, k));
    const bundle = { ...BUNDLE, movies };

    const fetcher: AuthedFetch = async (path) => {
      if (path.includes("/export")) {
        return exportResponse(bundle, path);
      }
      if (path.startsWith("/api/poster")) {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live -= 1;
        return new Response(new Uint8Array([1]));
      }
      throw new Error(`unexpected path ${path}`);
    };

    await exportAmcFile("cat-1", { tenantId: T, fetcher });
    // Serial fetching would never exceed 1 in flight.
    expect(peak).toBeGreaterThan(1);
  });
});

describe("paged export bundle", () => {
  it("fetches meta once and the row pages concurrently, matching the unpaged result", async () => {
    const paths: string[] = [];
    const PAGE = 2;
    const fetcher: AuthedFetch = async (path) => {
      paths.push(path);
      const u = new URL(path, "http://x");
      const part = u.searchParams.get("part");
      if (part === "meta") {
        return new Response(JSON.stringify({
          catalog: BUNDLE.catalog,
          customFieldDefs: [],
          movieCount: BUNDLE.movies.length,
          extraCount: 0,
        }), { headers: { "content-type": "application/json" } });
      }
      if (part === "movies") {
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const limit = Number(u.searchParams.get("limit") ?? PAGE);
        return new Response(JSON.stringify(BUNDLE.movies.slice(offset, offset + limit)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (part === "extras") {
        return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
      }
      if (path.startsWith("/api/poster")) {
        const key = decodeURIComponent(u.searchParams.get("key")!);
        return new Response(new Uint8Array([key === KEY_A ? 0xaa : 0xbb]));
      }
      throw new Error(`unexpected path ${path}`);
    };

    const paged = await exportAmcFile("cat-1", { tenantId: T, fetcher, pageSize: PAGE });
    // "default-paged": same client, default pageSize (500) instead of PAGE (2) —
    // still always goes through part=meta/movies/extras, there is no bare/
    // unparameterised request left to compare against (the Worker route no
    // longer serves one; see worker/index.ts).
    const defaultPaged = await exportAmcFile("cat-1", { tenantId: T, fetcher: stub().fetcher });

    expect(new Uint8Array(await paged.arrayBuffer()))
      .toEqual(new Uint8Array(await defaultPaged.arrayBuffer()));
    expect(paths.filter((p) => p.includes("part=meta"))).toHaveLength(1);
    // 4 movies at page size 2 => 2 movie pages.
    expect(paths.filter((p) => p.includes("part=movies"))).toHaveLength(2);
  });
});

// clampPagingParam backs the Worker's `limit`/`offset` query-param handling
// for GET /api/catalog/:id/export (worker/index.ts). It is exported as a pure
// function specifically so this boundary logic can be unit-tested without
// standing up a Worker (D1/R2 bindings, auth, routing) — see worker/db.test.ts's
// normalizeMovieNumber for the established pattern this mirrors.
describe("clampPagingParam", () => {
  it("falls back to the default when the param is absent", () => {
    expect(clampPagingParam(null, 500, 1, 500)).toBe(500);
  });

  it("falls back to the default for a non-numeric value (would otherwise bind NaN to D1)", () => {
    expect(clampPagingParam("banana", 500, 1, 500)).toBe(500);
    expect(clampPagingParam("", 0, 0, 500)).toBe(0);
    expect(clampPagingParam("NaN", 500, 1, 500)).toBe(500);
  });

  it("falls back to the default for non-finite input (Infinity)", () => {
    expect(clampPagingParam("Infinity", 500, 1, 500)).toBe(500);
    expect(clampPagingParam("-Infinity", 0, 0, 500)).toBe(0);
  });

  it("clamps a negative limit to the minimum, defeating SQLite's negative-LIMIT-means-unlimited behaviour", () => {
    expect(clampPagingParam("-1", 500, 1, 500)).toBe(1);
  });

  it("clamps an over-large limit to the server's page cap", () => {
    expect(clampPagingParam("999999", 500, 1, 500)).toBe(500);
  });

  it("truncates a fractional value to an integer", () => {
    expect(clampPagingParam("12.9", 500, 1, 500)).toBe(12);
  });

  it("allows offset 0 and clamps a negative offset to 0", () => {
    expect(clampPagingParam("0", 0, 0, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(clampPagingParam("-5", 0, 0, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("passes through a valid in-range value unchanged", () => {
    expect(clampPagingParam("250", 500, 1, 500)).toBe(250);
    expect(clampPagingParam("1000", 0, 0, Number.MAX_SAFE_INTEGER)).toBe(1000);
  });
});
