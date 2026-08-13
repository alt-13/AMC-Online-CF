import { describe, it, expect } from "vitest";
import { catalogToRows, type ImportSinks } from "./mapping";
import type { AMCCatalog, AMCMovie } from "./types";

// catalogToRows is the import half of the D1/R2 split: it flattens a parsed
// catalog into rows and streams posters out through a sink. These tests pin the
// two knobs the browser import relies on for atomic, dedup-able cloud pulls —
// the caller-supplied catalog id (so a failed import can be rolled back by its
// poster prefix) and the source_ref (so a re-pull can supersede its old copy).

function makeMovie(overrides: Partial<AMCMovie> = {}): AMCMovie {
  return {
    number: 1, date: 0, dateWatched: 0, userRating: -1, rating: -1, year: -1,
    length: -1, videoBitrate: 0, audioBitrate: 0, disks: 1, colorTag: 0,
    checked: false, media: "", mediaType: "", source: "", borrower: "",
    originalTitle: "Solaris", translatedTitle: "", director: "", producer: "",
    writer: "", composer: "", country: "", category: "", certification: "",
    actors: "", url: "", description: "", comments: "", filePath: "",
    videoFormat: "", audioFormat: "", resolution: "", framerate: "",
    languages: "", subtitles: "", size: "",
    picture: { picPath: "", picData: new Uint8Array(0) },
    customFieldValues: [], extras: [],
    ...overrides,
  };
}

function makeCatalog(movies: AMCMovie[]): AMCCatalog {
  return {
    version: 42, name: "Films", mail: "", site: "", description: "",
    cfpColumnSettings: "", cfpGuiProperties: "", customFieldDefs: [], movies,
  };
}

function sinks(): ImportSinks & { posterKeys: string[] } {
  let n = 0;
  const posterKeys: string[] = [];
  return {
    posterKeys,
    newId: () => `id-${++n}`,
    now: () => 1000,
    putPoster: async (_bytes, key) => {
      posterKeys.push(key);
      return key;
    },
  };
}

describe("catalogToRows import mapping", () => {
  it("defaults source_ref to null and mints its own catalog id", async () => {
    const res = await catalogToRows(makeCatalog([makeMovie()]), "tenant-A", sinks());
    expect(res.catalog.source_ref).toBeNull();
    expect(res.catalog.id).toBe("id-1"); // first sink id
    expect(res.movies).toHaveLength(1);
  });

  it("honours a caller-supplied catalog id and source_ref", async () => {
    const res = await catalogToRows(
      makeCatalog([makeMovie()]),
      "tenant-A",
      sinks(),
      "cat-fixed",
      "mega:folderX:films.amc",
    );
    expect(res.catalog.id).toBe("cat-fixed");
    expect(res.catalog.source_ref).toBe("mega:folderX:films.amc");
    // Children hang off the fixed catalog id, not a freshly minted one.
    expect(res.movies[0].catalog_id).toBe("cat-fixed");
  });

  it("keys posters under the tenant + supplied catalog id, so a prefix sweep can roll them back", async () => {
    const s = sinks();
    const withPoster = makeMovie({ picture: { picPath: "p.jpg", picData: new Uint8Array([1, 2, 3]) } });
    await catalogToRows(makeCatalog([withPoster]), "tenant-A", s, "cat-fixed");
    expect(s.posterKeys).toHaveLength(1);
    expect(s.posterKeys[0].startsWith("tenant-A/cat-fixed/")).toBe(true);
  });
});
