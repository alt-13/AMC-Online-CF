import { describe, it, expect } from "vitest";
import { summarizeDiff } from "./syncdiff";
import type { MovieRow } from "./api";
import type { AMCMovie } from "../amc/types";

function local(number: number, original: string, translated = "", year = -1): MovieRow {
  return { number, original_title: original, translated_title: translated, year } as MovieRow;
}

function remote(number: number, originalTitle: string, translatedTitle = "", year = -1): AMCMovie {
  return { number, originalTitle, translatedTitle, year } as AMCMovie;
}

describe("summarizeDiff", () => {
  it("finds movies only on one side", () => {
    const d = summarizeDiff(
      [local(1, "Stalker"), local(2, "Solaris")],
      [remote(1, "Stalker"), remote(3, "Mirror")],
    );
    expect(d.onlyLocal).toBe(1);
    expect(d.onlyRemote).toBe(1);
    expect(d.samples.onlyLocal).toEqual(["Solaris"]);
    expect(d.samples.onlyRemote).toEqual(["Mirror"]);
  });

  it("reports nothing for identical sides", () => {
    const d = summarizeDiff([local(1, "Stalker")], [remote(1, "Stalker")]);
    expect(d).toMatchObject({ onlyLocal: 0, onlyRemote: 0, differing: 0 });
  });

  it("counts a matched pair with different content as differing", () => {
    const d = summarizeDiff([local(1, "Stalker", "", 1979)], [remote(1, "Stalker", "", 1980)]);
    expect(d.differing).toBe(1);
    expect(d.onlyLocal).toBe(0);
    expect(d.onlyRemote).toBe(0);
    expect(d.samples.differing).toEqual(["Stalker"]);
  });

  it("prefers the translated title in the key, matching the listing sort", () => {
    // Same movie, keyed by its translated title on both sides.
    const d = summarizeDiff([local(1, "Stalker", "Pikkoputki")], [remote(1, "Different", "Pikkoputki")]);
    expect(d.onlyLocal).toBe(0);
    expect(d.onlyRemote).toBe(0);
    expect(d.differing).toBe(1); // matched, but the original titles differ
  });

  it("is case- and whitespace-insensitive", () => {
    const d = summarizeDiff([local(1, "  STALKER ")], [remote(1, "stalker")]);
    expect(d.onlyLocal).toBe(0);
    expect(d.onlyRemote).toBe(0);
  });

  it("handles a catalog where every number is 0", () => {
    const d = summarizeDiff(
      [local(0, "Stalker"), local(0, "Solaris")],
      [remote(0, "Stalker"), remote(0, "Mirror")],
    );
    expect(d.onlyLocal).toBe(1);
    expect(d.onlyRemote).toBe(1);
  });

  it("counts duplicate keys conservatively instead of pairing them up", () => {
    // Three local, one remote, all the same key. A one-to-one mapping is not
    // claimed: the surplus counts as local-only.
    const d = summarizeDiff(
      [local(1, "Stalker"), local(1, "Stalker"), local(1, "Stalker")],
      [remote(1, "Stalker")],
    );
    expect(d.onlyLocal).toBe(2);
    expect(d.onlyRemote).toBe(0);
  });

  it("caps samples at five per bucket", () => {
    const many = Array.from({ length: 9 }, (_, i) => local(i + 1, `Film ${i + 1}`));
    const d = summarizeDiff(many, []);
    expect(d.onlyLocal).toBe(9);
    expect(d.samples.onlyLocal).toHaveLength(5);
  });
});
