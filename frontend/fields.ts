// Shared field metadata + small format helpers for the CF movie editor.
//
// One source of truth for: which columns the form shows (grouped into
// sections), their labels, the Delphi date <-> <input type=date> conversion,
// colour-tag palette, and the custom_values JSON (de)serialisation. Keeping it
// here lets MovieDetail, SettingsDialog and MovieListView agree without a store.

import type { MovieRow, CustomFieldDefRow } from "./api";

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
}
export const DEFAULT_SETTINGS: AppSettings = {
  field_visibility: { desktop: {}, mobile: {} },
  search_field: "",
};

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
