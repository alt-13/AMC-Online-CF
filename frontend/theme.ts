// Light/dark mode. One switch: the `.dark` class on <html>, which drives both
// the `--c-*` palette (theme.css) and PrimeVue's darkModeSelector (main.ts).
//
// Device-local on purpose: the mode is a property of the screen you're looking
// at, not of the account, so it lives in localStorage and never touches
// `user_settings` (a phone on dark and a desktop on light is the normal case).

export type ThemeMode = "system" | "light" | "dark";

const KEY = "amc.theme";
const DARK = "(prefers-color-scheme: dark)";

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private mode / blocked storage → follow the OS */
  }
  return "system";
}

/** Which of the two schemes a mode resolves to right now. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return matchMedia(DARK).matches ? "dark" : "light";
}

/** Apply a mode (idempotent — index.html has already applied it on boot). */
export function applyTheme(mode: ThemeMode = getThemeMode()) {
  document.documentElement.classList.toggle("dark", resolveTheme(mode) === "dark");
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* not persisted, but still applied for this session */
  }
  applyTheme(mode);
}

/** Follow the OS while the mode is "system". */
export function watchSystemTheme() {
  matchMedia(DARK).addEventListener("change", () => {
    if (getThemeMode() === "system") applyTheme("system");
  });
}
