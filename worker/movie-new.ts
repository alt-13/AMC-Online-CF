// Building a fresh movie row from an edit patch.
//
// The desktop app's create flow had to juggle two numbers (`_stored_number` vs
// the in-memory unique key) because Delphi used the on-disk number as the record
// identity. The CF schema already separates identity (`id`, a uuid PK) from the
// on-disk `number`, so create is simply: assign the next free `number` and fill
// schema defaults. No series-remapping shim needed.

import type { MovieRow } from "../amc/mapping";

// Delphi's TDateTime epoch is 1899-12-30. `date`/`date_watched` are stored as
// whole-day counts from it (same as backend/app/api/movies.py _today_delphi).
const DELPHI_EPOCH_MS = Date.UTC(1899, 11, 30);

export function todayDelphi(nowMs: number): number {
  return Math.floor((nowMs - DELPHI_EPOCH_MS) / 86_400_000);
}

/** Columns a caller may set on create — everything except identity, the poster
 *  keys, and `number` (create always takes the next free one via
 *  nextMovieNumber; an edit may then change it, e.g. to join a series). */
const CREATABLE: Array<keyof MovieRow> = [
  "date", "date_watched", "user_rating", "rating", "year", "length",
  "video_bitrate", "audio_bitrate", "disks", "color_tag", "checked",
  "media", "media_type", "source", "borrower", "original_title",
  "translated_title", "director", "producer", "writer", "composer", "country",
  "category", "certification", "actors", "url", "description", "comments",
  "file_path", "video_format", "audio_format", "resolution", "framerate",
  "languages", "subtitles", "size", "pic_path", "custom_values",
];

/**
 * Assemble a complete MovieRow for INSERT. `id`/`catalog_id`/`number` come from
 * the server; scalar columns start at the schema defaults and are overlaid with
 * whatever the patch provides. `date` defaults to today when the patch omits it.
 */
export function newMovieRow(
  id: string,
  catalogId: string,
  num: number,
  patch: Partial<MovieRow>,
  nowMs: number,
): MovieRow {
  const row: MovieRow = {
    id,
    catalog_id: catalogId,
    number: num,
    date: 0,
    date_watched: 0,
    user_rating: -1,
    rating: -1,
    year: -1,
    length: -1,
    video_bitrate: -1,
    audio_bitrate: -1,
    disks: -1,
    color_tag: 0,
    checked: 0,
    media: "",
    media_type: "",
    source: "",
    borrower: "",
    original_title: "",
    translated_title: "",
    director: "",
    producer: "",
    writer: "",
    composer: "",
    country: "",
    category: "",
    certification: "",
    actors: "",
    url: "",
    description: "",
    comments: "",
    file_path: "",
    video_format: "",
    audio_format: "",
    resolution: "",
    framerate: "",
    languages: "",
    subtitles: "",
    size: "",
    pic_path: "",
    poster_key: null,
    custom_values: "{}",
    sort_title: "",
    updated_at: nowMs,
  };

  for (const col of CREATABLE) {
    if (col in patch && patch[col] !== undefined) {
      (row as unknown as Record<string, unknown>)[col] = patch[col];
    }
  }
  if (!("date" in patch) || patch.date === undefined) row.date = todayDelphi(nowMs);
  row.sort_title = (row.translated_title || row.original_title).toLowerCase();
  return row;
}
