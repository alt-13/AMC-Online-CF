// Shared field metadata + small format helpers for the CF movie editor.
//
// One source of truth for: which columns the form shows (grouped into
// sections), their labels, the Delphi date <-> <input type=date> conversion,
// colour-tag palette, and the custom_values JSON (de)serialisation. Keeping it
// here lets MovieDetail, SettingsDialog and MovieListView agree without a store.

import type { MovieRow, CustomFieldDefRow } from "./api";
import { MAX_INT32 } from "../amc/types";

/** The widest value `movies.number` can hold and still round-trip through the
 *  .amc int32 field. Re-exported here so the form can bound its input without
 *  reaching into worker code. */
export const MAX_MOVIE_NUMBER = MAX_INT32;

export interface FieldDef {
  key: string; // MovieRow column, or "custom_<tag>", or a synthetic ("extras")
  label: string;
  always?: boolean; // never hidable (original_title)
}
export interface FieldSection {
  key: string;
  label: string;
  fields: FieldDef[];
}

// Mirrors the self-hosted SettingsDialog sections so a catalog's visibility
// settings mean the same thing in both apps.
export const STATIC_SECTIONS: FieldSection[] = [
  {
    key: "main",
    label: "Main",
    fields: [
      { key: "original_title", label: "Original Title", always: true },
      { key: "translated_title", label: "Translated Title" },
      { key: "director", label: "Director" },
      { key: "producer", label: "Producer" },
      { key: "writer", label: "Writer" },
      { key: "composer", label: "Composer" },
      { key: "actors", label: "Actors" },
      { key: "category", label: "Category" },
      { key: "country", label: "Country" },
      { key: "url", label: "URL" },
      { key: "description", label: "Description" },
      { key: "comments", label: "Comments" },
      { key: "media", label: "Media" },
      { key: "date", label: "Date Added" },
      { key: "date_watched", label: "Date Watched" },
      { key: "year", label: "Year" },
      { key: "length", label: "Length" },
      { key: "rating", label: "Rating" },
      { key: "user_rating", label: "My Rating" },
      { key: "certification", label: "Certification" },
      { key: "checked", label: "Watched" },
      { key: "color_tag", label: "Color Tag" },
      { key: "borrower", label: "Borrower" },
    ],
  },
  {
    key: "media_technical",
    label: "Media / Technical",
    fields: [
      { key: "media_type", label: "Media Type" },
      { key: "source", label: "Source" },
      { key: "disks", label: "Disks" },
      { key: "size", label: "Size" },
      { key: "file_path", label: "File Path" },
      { key: "video_format", label: "Video Format" },
      { key: "video_bitrate", label: "Video kbps" },
      { key: "resolution", label: "Resolution" },
      { key: "framerate", label: "Framerate" },
      { key: "audio_format", label: "Audio Format" },
      { key: "audio_bitrate", label: "Audio kbps" },
      { key: "languages", label: "Languages" },
      { key: "subtitles", label: "Subtitles" },
    ],
  },
];

/** Flat field-key → human label lookup, derived from STATIC_SECTIONS so the
 *  OMDb field-picker (and anything else) can name a column without repeating the
 *  labels. Unknown keys fall back to the raw key at the call site. */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  STATIC_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f.label] as const)),
);

/** Which columns are plain single-line text, big text, integer, or date. Any
 *  key not listed falls back to a single-line text input. */
export const MULTILINE = new Set(["description", "comments", "actors"]);
export const INTEGER_FIELDS = new Set([
  "year", "length", "disks", "video_bitrate", "audio_bitrate",
]);
export const DATE_FIELDS = new Set(["date", "date_watched"]);
export const BOOL_FIELDS = new Set(["checked"]);

// Sentinel: AMC uses -1 for "unset" numeric fields; show those as blank.
export const SENTINEL = -1;

// --- Delphi day number <-> Date ---------------------------------------------
const DELPHI_EPOCH_MS = Date.UTC(1899, 11, 30);

// For PrimeVue's <DatePicker>, which binds a Date. A Delphi day number is a
// calendar date with no timezone, so these deliberately cross the UTC/local
// boundary by y/m/d parts rather than by milliseconds — reading the UTC parts
// and rebuilding at LOCAL midnight (and back) keeps the displayed day identical
// in every timezone. A plain `new Date(epoch + days*86400000)` would render as
// the previous day west of UTC.
export function delphiToDate(days: number): Date | null {
  if (!days) return null;
  const utc = new Date(DELPHI_EPOCH_MS + days * 86_400_000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

export function dateToDelphi(d: Date | null | undefined): number {
  if (!d || Number.isNaN(d.getTime())) return 0;
  const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((ms - DELPHI_EPOCH_MS) / 86_400_000);
}

// --- colour tags ------------------------------------------------------------
export const COLOR_TAG_COLORS: Record<number, string> = {
  0: "transparent", 1: "#e05252", 2: "#f97316", 3: "#eab308", 4: "#22c55e",
  5: "#14b8a6", 6: "#4361ee", 7: "#a855f7", 8: "#ec4899", 9: "#92400e",
  10: "#6b7280", 11: "#f1f5f9", 12: "#1e293b",
};
export const COLOR_TAG_NAMES: Record<number, string> = {
  0: "None", 1: "Red", 2: "Orange", 3: "Yellow", 4: "Green", 5: "Teal",
  6: "Blue", 7: "Purple", 8: "Pink", 9: "Brown", 10: "Gray", 11: "White",
  12: "Black",
};

// --- custom_values JSON -----------------------------------------------------
export function parseCustom(row: Pick<MovieRow, "custom_values">): Record<string, string> {
  try {
    return { ...(JSON.parse(row.custom_values || "{}") as Record<string, string>) };
  } catch {
    return {};
  }
}

// --- visibility (absent key = visible; original_title always on) ------------
export interface AppSettings {
  field_visibility: { desktop: Record<string, boolean>; mobile: Record<string, boolean> };
  search_field: string;
  series_rule: SeriesRule;
}
export const DEFAULT_SETTINGS: AppSettings = {
  field_visibility: { desktop: {}, mobile: {} },
  search_field: "",
  series_rule: { kind: "off" },
};

// --- series counting --------------------------------------------------------
//
// What makes an entry a "series" is a per-CATALOG CONVENTION, not anything the
// .amc format states. `movies.number` is just the on-disk catalog number; how a
// user leans on it is up to them — one catalog parks every series under a single
// number so they sort together, another gives each series its own number shared
// by its episodes, another ignores number entirely and marks series with a
// custom field. Guessing wrong produces a confidently wrong count, so the
// default is `off`: no counts in the bar until the user states the rule.
//
// Adding a kind means adding a case to `countSeries` and an option to
// SettingsDialog. See SERIES-RULES.md for the planned custom-field rules.
export type SeriesRule =
  /** Show no counts (default). */
  | { kind: "off" }
  /** Every entry carrying exactly this number is one series. */
  | { kind: "number_is"; number: number }
  /** A number used by 2+ entries is one series; those entries are its episodes. */
  | { kind: "number_shared" }
  /** Certification matches one of these strings (e.g. "TV Series",
   *  "TV Mini-Series"). The list is the user's to edit — certification is free
   *  text in the format, so there is no fixed vocabulary to offer. */
  | { kind: "certification_in"; values: string[] };

/** Certification is free text typed by whoever built the catalog, so match it
 *  forgivingly: trim and casefold, but still compare whole values — a substring
 *  match would make "TV Series" swallow "Not a TV Series". */
const normCert = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** The seed shown when the user first picks the certification rule. */
export const DEFAULT_CERTIFICATION_VALUES = ["TV Series", "TV Mini-Series"];

export interface SeriesCounts {
  films: number;
  series: number;
}

/** Split a catalog into films and series under `rule`, or null when the user has
 *  not chosen a rule (the bar then shows no counts at all). */
export function countSeries(
  movies: Pick<MovieRow, "number" | "certification">[],
  rule: SeriesRule | undefined,
): SeriesCounts | null {
  switch (rule?.kind) {
    case "certification_in": {
      const wanted = new Set(rule.values.map(normCert).filter(Boolean));
      // An empty list matches nothing rather than everything — a half-configured
      // rule should read "0 series", not "every film is a series".
      if (!wanted.size) return { films: movies.length, series: 0 };
      const series = movies.filter((m) => wanted.has(normCert(m.certification))).length;
      return { films: movies.length - series, series };
    }
    case "number_is": {
      const series = movies.filter((m) => m.number === rule.number).length;
      return { films: movies.length - series, series };
    }
    case "number_shared": {
      // Group by number: a group of 1 is a standalone film, a group of 2+ is one
      // series (NOT one per episode — that would report episode count).
      const byNumber = new Map<number, number>();
      for (const m of movies) byNumber.set(m.number, (byNumber.get(m.number) ?? 0) + 1);
      let films = 0;
      let series = 0;
      for (const n of byNumber.values()) n > 1 ? series++ : films++;
      return { films, series };
    }
    default:
      return null;
  }
}

export function isVisible(
  s: AppSettings,
  key: string,
  mode: "desktop" | "mobile",
): boolean {
  if (key === "original_title") return true;
  return s.field_visibility[mode]?.[key] ?? true;
}

// --- search scopes (the inline filter icon in the movie list) --------------
//
// A curated, search-oriented grouping mirrored field-for-field from the
// self-hosted MovieList filter. "" = all fields. Custom fields use the
// `custom_<tag>` key so a value picked here is interchangeable with the
// SettingsDialog "Search field" control (both persist to settings.search_field).
export interface SearchScopeGroup {
  label: string; // "" for the ungrouped "All fields" row
  items: { label: string; value: string }[];
}

export function searchScopes(defs: CustomFieldDefRow[]): SearchScopeGroup[] {
  const groups: SearchScopeGroup[] = [
    { label: "", items: [{ label: "All fields", value: "" }] },
    { label: "Film", items: [
      { label: "Title", value: "original_title" },
      { label: "Translated title", value: "translated_title" },
      { label: "Category", value: "category" },
      { label: "Year", value: "year" },
      { label: "Country", value: "country" },
      { label: "Certification", value: "certification" },
      { label: "Description", value: "description" },
    ] },
    { label: "People", items: [
      { label: "Director", value: "director" },
      { label: "Actors", value: "actors" },
      { label: "Producer", value: "producer" },
      { label: "Writer", value: "writer" },
      { label: "Composer", value: "composer" },
    ] },
    { label: "File", items: [
      { label: "Media", value: "media" },
      { label: "Media type", value: "media_type" },
      { label: "Source", value: "source" },
      { label: "Borrower", value: "borrower" },
      { label: "File path", value: "file_path" },
      { label: "URL", value: "url" },
    ] },
    { label: "Technical", items: [
      { label: "Languages", value: "languages" },
      { label: "Subtitles", value: "subtitles" },
      { label: "Video format", value: "video_format" },
      { label: "Audio format", value: "audio_format" },
      { label: "Resolution", value: "resolution" },
      { label: "Framerate", value: "framerate" },
    ] },
    { label: "Notes", items: [
      { label: "Comments", value: "comments" },
    ] },
  ];
  if (defs.length) {
    groups.push({
      label: "Custom",
      items: defs.map((d) => ({ label: d.name || d.tag, value: `custom_${d.tag}` })),
    });
  }
  return groups;
}

/** Columns an "All fields" search scans (union of the scope groups above; the
 *  custom values are searched separately from the custom_values JSON). Mirrors
 *  the self-hosted matchesSearch coverage. */
export const ALL_SEARCH_FIELDS: readonly string[] = [
  "original_title", "translated_title", "director", "actors", "country",
  "category", "year", "producer", "writer", "composer", "certification",
  "languages", "subtitles", "description", "comments", "media", "media_type",
  "source", "borrower", "video_format", "audio_format", "resolution",
  "framerate", "file_path", "url",
];

/** Human label for a scope value (for the filter tooltip). "" when not found. */
export function scopeLabel(defs: CustomFieldDefRow[], value: string): string {
  for (const g of searchScopes(defs)) {
    for (const it of g.items) if (it.value === value) return it.label;
  }
  return "";
}

/** All sections including a Custom section for this catalog's defs. */
export function sectionsFor(defs: CustomFieldDefRow[]): FieldSection[] {
  if (!defs.length) return STATIC_SECTIONS;
  return [
    ...STATIC_SECTIONS,
    {
      key: "custom",
      label: "Custom Fields",
      fields: defs.map((d) => ({ key: `custom_${d.tag}`, label: d.name || d.tag })),
    },
  ];
}
