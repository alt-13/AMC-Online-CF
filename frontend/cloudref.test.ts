import { describe, it, expect } from "vitest";
import { parseSourceRef, splitMegaLocator, formatMegaSourceRef, pickActiveProvider } from "./cloudref";

describe("source_ref helpers", () => {
  it("parses provider + locator (locator keeps its own colons)", () => {
    expect(parseSourceRef("mega:ABC123:movies.amc")).toEqual({
      provider: "mega",
      locator: "ABC123:movies.amc",
    });
  });

  it("splits a mega locator into handle + name, preserving spaces", () => {
    expect(splitMegaLocator("ABC123:Filme (Bewertungen).amc")).toEqual({
      handle: "ABC123",
      name: "Filme (Bewertungen).amc",
    });
  });

  it("formats a mega source_ref", () => {
    expect(formatMegaSourceRef("ABC123", "movies.amc")).toBe("mega:ABC123:movies.amc");
  });
});

describe("pickActiveProvider", () => {
  it("defaults to mega when nothing is credentialed", () => {
    expect(pickActiveProvider([{ provider: "mega", hasCredential: false, updatedAt: 5 }])).toBe("mega");
    expect(pickActiveProvider([])).toBe("mega");
  });

  it("picks the newest credentialed provider", () => {
    expect(
      pickActiveProvider([
        { provider: "mega", hasCredential: true, updatedAt: 10 },
        { provider: "drive", hasCredential: true, updatedAt: 20 },
        { provider: "dropbox", hasCredential: false, updatedAt: 99 },
      ]),
    ).toBe("drive");
  });
});
