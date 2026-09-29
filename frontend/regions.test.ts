import { describe, it, expect } from "vitest";
import { REGION_CODES, flagOf, defaultRegion, regionFor, regionOptions } from "./regions";

describe("regions", () => {
  it("covers all 249 ISO 3166-1 alpha-2 codes, once each", () => {
    expect(REGION_CODES).toHaveLength(249);
    expect(new Set(REGION_CODES).size).toBe(249);
    expect(REGION_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });
  it("builds a flag from two regional indicators", () => {
    expect(flagOf("AT")).toBe("🇦🇹");
    expect(flagOf("us")).toBe("🇺🇸");
  });
  it("defaults to the locale's region, else US", () => {
    expect(defaultRegion("de-AT")).toBe("AT");
    expect(defaultRegion("en_GB")).toBe("GB");
    expect(defaultRegion("en")).toBe("US");
    expect(regionFor({ streaming_region: "DE" }, "de-AT")).toBe("DE");
    expect(regionFor({ streaming_region: "" }, "de-AT")).toBe("AT");
  });
  it("labels read 'flag Country (CODE)', sorted by name", () => {
    const opts = regionOptions("en");
    expect(opts.find((o) => o.value === "AT")?.label).toBe("🇦🇹 Austria (AT)");
    const names = opts.map((o) => o.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });
});
