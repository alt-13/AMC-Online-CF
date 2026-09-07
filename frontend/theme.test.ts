// theme.ts's only real branch: what "system" resolves to, and that a junk /
// unavailable localStorage value falls back to "system" rather than throwing.
// Node env, so matchMedia/localStorage are stubbed rather than pulling in jsdom.
import { describe, it, expect, afterEach } from "vitest";
import { getThemeMode, resolveTheme } from "./theme";

const g = globalThis as Record<string, unknown>;

function stub(prefersDark: boolean, stored: string | null | "throw") {
  g.matchMedia = () => ({ matches: prefersDark }) as MediaQueryList;
  g.localStorage = {
    getItem: () => {
      if (stored === "throw") throw new Error("blocked");
      return stored;
    },
  } as unknown as Storage;
}

afterEach(() => {
  delete g.matchMedia;
  delete g.localStorage;
});

describe("resolveTheme", () => {
  it("follows the OS for 'system'", () => {
    stub(true, "system");
    expect(resolveTheme("system")).toBe("dark");
    stub(false, "system");
    expect(resolveTheme("system")).toBe("light");
  });

  it("ignores the OS for an explicit mode", () => {
    stub(true, "light");
    expect(resolveTheme("light")).toBe("light");
    stub(false, "dark");
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("getThemeMode", () => {
  it("reads a stored mode", () => {
    stub(false, "dark");
    expect(getThemeMode()).toBe("dark");
  });

  it("falls back to 'system' for nothing stored, junk, or blocked storage", () => {
    for (const stored of [null, "chartreuse", "throw"] as const) {
      stub(false, stored);
      expect(getThemeMode()).toBe("system");
    }
  });
});
