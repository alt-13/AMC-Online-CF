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

// --- Delphi date <-> yyyy-mm-dd --------------------------------------------
const DELPHI_EPOCH_MS = Date.UTC(1899, 11, 30);

export function delphiToInput(days: number): string {
  if (!days) return "";
  return new Date(DELPHI_EPOCH_MS + days * 86_400_000).toISOString().slice(0, 10);
}

export function inputToDelphi(iso: string): number {
  if (!iso) return 0;
  const ms = Date.parse(iso + "T00:00:00Z");
  return Number.isNaN(ms) ? 0 : Math.round((ms - DELPHI_EPOCH_MS) / 86_400_000);
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
