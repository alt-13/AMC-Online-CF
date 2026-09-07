import { describe, it, expect } from "vitest";
import { findDuplicate, findDuplicateOnEdit } from "./fields";
import type { MovieRow } from "./api";

const row = (r: Partial<MovieRow>) => r as MovieRow;

describe("findDuplicate", () => {
  const rows = [
    row({ id: "1", original_title: "Alien", url: "https://imdb.com/title/tt0078748/" }),
    row({ id: "2", original_title: "Aliens", url: "", custom_values: '{"IMDB":"tt0090605"}' }),
  ];

  it("matches a title ignoring case and space", () => {
    expect(findDuplicate(rows, { original_title: "  alien " }, "original_title")?.id).toBe("1");
  });

  it("matches on any other configured field", () => {
    expect(findDuplicate(rows, { url: "https://imdb.com/title/tt0078748/" }, "url")?.id).toBe("1");
    expect(findDuplicate(rows, { original_title: "Alien" }, "url")).toBeNull();
  });

  it("matches custom fields by tag", () => {
    expect(findDuplicate(rows, { custom_values: '{"IMDB":"tt0090605"}' }, "custom_IMDB")?.id).toBe("2");
  });

  it("never matches a blank value, and \"\" disables the check", () => {
    expect(findDuplicate(rows, { url: "" }, "url")).toBeNull();
    expect(findDuplicate(rows, { original_title: "Alien" }, "")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findDuplicate(rows, { original_title: "Predator" }, "original_title")).toBeNull();
  });
});

describe("findDuplicateOnEdit", () => {
  const rows = [
    row({ id: "1", original_title: "Alien" }),
    row({ id: "2", original_title: "Aliens" }),
  ];

  it("warns when an edit collides with another row", () => {
    const hit = findDuplicateOnEdit(
      rows, { original_title: "Aliens" }, { original_title: "Alien" }, "original_title", "2",
    );
    expect(hit?.id).toBe("1");
  });

  it("never matches the row being edited", () => {
    expect(findDuplicateOnEdit(
      rows, { original_title: "Alien" }, { original_title: "Alien" }, "original_title", "1",
    )).toBeNull();
  });

  it("stays quiet when the compared field did not change", () => {
    // Row 2 renamed to a colliding title earlier; a later unrelated edit must
    // not re-warn.
    const dupes = [row({ id: "1", original_title: "Alien" }), row({ id: "2", original_title: "Alien" })];
    expect(findDuplicateOnEdit(
      dupes, { original_title: "Alien", year: 1986 }, { original_title: "Alien", year: 1979 },
      "original_title", "2",
    )).toBeNull();
  });
});
