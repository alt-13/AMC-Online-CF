// Mapping between the parsed AMC binary model and the D1 + R2 storage model.
//
// This is where the poster/R2 split happens — the single design decision that
// keeps the app under Worker memory limits. Import lifts every embedded JPEG
// into R2 and replaces it with a key; export streams the keys back into bytes.
//
// These helpers are storage-agnostic (they take plain callbacks) so the same
// code runs from a Worker or from the browser import flow.

import type { AMCCatalog, AMCCustomFieldDef, AMCMovie } from "./types";

// --- Row shapes (what actually lands in D1) --------------------------------

export interface CatalogRow {
  id: string;
  tenant_id: string;
  version: number;
  name: string;
  mail: string;
  site: string;
  description: string;
  cfp_column_settings: string;
  cfp_gui_properties: string;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
}

export interface CustomFieldDefRow {
  id: string;
  catalog_id: string;
  ordinal: number;
  tag: string;
  name: string;
  field_ext: string;
  field_type: string;
  default_value: string;
  media_info: string;
  multi_values: number;
  multi_values_sep: number;
  multi_values_rmp: number;
  multi_values_patch: number;
  excluded_in_scripts: number;
  gui_properties: string;
  list_values: string; // JSON
  list_auto_add: number;
  list_sort: number;
  list_auto_complete: number;
  list_use_catalog_values: number;
}

export interface MovieRow {
  id: string;
  catalog_id: string;
  number: number;
  date: number;
  date_watched: number;
  user_rating: number;
  rating: number;
  year: number;
  length: number;
  video_bitrate: number;
  audio_bitrate: number;
  disks: number;
  color_tag: number;
  checked: number;
  media: string;
  media_type: string;
  source: string;
  borrower: string;
  original_title: string;
  translated_title: string;
  director: string;
  producer: string;
  writer: string;
  composer: string;
  country: string;
  category: string;
  certification: string;
  actors: string;
  url: string;
  description: string;
  comments: string;
  file_path: string;
  video_format: string;
  audio_format: string;
  resolution: string;
  framerate: string;
  languages: string;
  subtitles: string;
  size: string;
  pic_path: string;
  poster_key: string | null;
  custom_values: string; // JSON {tag: value}
  sort_title: string;
}

const b = (v: boolean) => (v ? 1 : 0);

// --- IMPORT: parsed catalog → rows, posters uploaded to R2 -----------------

export interface ImportSinks {
  newId: () => string; // e.g. crypto.randomUUID()
  now: () => number; // epoch ms
  /** Persist poster bytes and return the R2 key that references them. */
  putPoster: (bytes: Uint8Array, suggestedKey: string) => Promise<string>;
}

export interface ImportResult {
  catalog: CatalogRow;
  customFieldDefs: CustomFieldDefRow[];
  movies: MovieRow[];
  extras: Array<{
    id: string;
    movie_id: string;
    ordinal: number;
    checked: number;
    tag: string;
    title: string;
    category: string;
    url: string;
    description: string;
    comments: string;
    created_by: string;
    pic_path: string;
    poster_key: string | null;
  }>;
}

/**
 * Flatten a parsed catalog into D1 rows, streaming each embedded poster to R2.
 * Runs in the browser during import so the binary blob never hits a Worker.
 */
export async function catalogToRows(
  cat: AMCCatalog,
  tenantId: string,
  sinks: ImportSinks,
  // Caller may fix the catalog id up front so it can clean up (poster prefix +
  // rows) if the import fails partway. Defaults to a fresh id.
  catalogId: string = sinks.newId(),
  // Stable origin key for cloud pulls, so a re-pull can supersede its catalog.
  // NULL for direct file uploads.
  sourceRef: string | null = null,
): Promise<ImportResult> {
  const ts = sinks.now();

  const catalog: CatalogRow = {
    id: catalogId,
    tenant_id: tenantId,
    version: cat.version,
    name: cat.name,
    mail: cat.mail,
    site: cat.site,
    description: cat.description,
    cfp_column_settings: cat.cfpColumnSettings,
    cfp_gui_properties: cat.cfpGuiProperties,
    source_ref: sourceRef,
    created_at: ts,
    updated_at: ts,
  };

  const customFieldDefs: CustomFieldDefRow[] = cat.customFieldDefs.map((d, i) => ({
    id: sinks.newId(),
    catalog_id: catalogId,
    ordinal: i,
    tag: d.tag,
    name: d.name,
    field_ext: d.fieldExt,
    field_type: d.fieldType,
    default_value: d.defaultValue,
    media_info: d.mediaInfo,
    multi_values: b(d.multiValues),
    multi_values_sep: d.multiValuesSep,
    multi_values_rmp: b(d.multiValuesRmp),
    multi_values_patch: b(d.multiValuesPatch),
    excluded_in_scripts: b(d.excludedInScripts),
    gui_properties: d.guiProperties,
    list_values: JSON.stringify(d.listValues),
    list_auto_add: b(d.listAutoAdd),
    list_sort: b(d.listSort),
    list_auto_complete: b(d.listAutoComplete),
    list_use_catalog_values: b(d.listUseCatalogValues),
  }));

  const movies: MovieRow[] = [];
  const extras: ImportResult["extras"] = [];

  for (const m of cat.movies) {
    const movieId = sinks.newId();
    let posterKey: string | null = null;
    if (m.picture.picData.length > 0) {
      posterKey = await sinks.putPoster(
        m.picture.picData,
        `${tenantId}/${catalogId}/${movieId}.jpg`,
      );
    }
    const customValues: Record<string, string> = {};
    cat.customFieldDefs.forEach((d, i) => {
      customValues[d.tag] = i < m.customFieldValues.length ? m.customFieldValues[i] : "";
    });

    movies.push({
      id: movieId,
      catalog_id: catalogId,
      number: m.number,
      date: m.date,
      date_watched: m.dateWatched,
      user_rating: m.userRating,
      rating: m.rating,
      year: m.year,
      length: m.length,
      video_bitrate: m.videoBitrate,
      audio_bitrate: m.audioBitrate,
      disks: m.disks,
      color_tag: m.colorTag,
      checked: b(m.checked),
      media: m.media,
      media_type: m.mediaType,
      source: m.source,
      borrower: m.borrower,
      original_title: m.originalTitle,
      translated_title: m.translatedTitle,
      director: m.director,
      producer: m.producer,
      writer: m.writer,
      composer: m.composer,
      country: m.country,
      category: m.category,
      certification: m.certification,
      actors: m.actors,
      url: m.url,
      description: m.description,
      comments: m.comments,
      file_path: m.filePath,
      video_format: m.videoFormat,
      audio_format: m.audioFormat,
      resolution: m.resolution,
      framerate: m.framerate,
      languages: m.languages,
      subtitles: m.subtitles,
      size: m.size,
      pic_path: m.picture.picPath,
      poster_key: posterKey,
      custom_values: JSON.stringify(customValues),
      sort_title: (m.translatedTitle || m.originalTitle).toLowerCase(),
    });

    for (let ei = 0; ei < m.extras.length; ei++) {
      const e = m.extras[ei];
      let ePosterKey: string | null = null;
      if (e.picture.picData.length > 0) {
        ePosterKey = await sinks.putPoster(
          e.picture.picData,
          `${tenantId}/${catalogId}/${movieId}/extra-${ei}.jpg`,
        );
      }
      extras.push({
        id: sinks.newId(),
        movie_id: movieId,
        ordinal: ei,
        checked: b(e.checked),
        tag: e.tag,
        title: e.title,
        category: e.category,
        url: e.url,
        description: e.description,
        comments: e.comments,
        created_by: e.createdBy,
        pic_path: e.picture.picPath,
        poster_key: ePosterKey,
      });
    }
  }

  return { catalog, customFieldDefs, movies, extras };
}

// --- EXPORT: rows → parsed catalog, posters fetched from R2 ----------------

export interface ExportSources {
  catalog: CatalogRow;
  customFieldDefs: CustomFieldDefRow[]; // ORDER BY ordinal
  movies: MovieRow[]; // ORDER BY number
  extrasByMovie: Map<string, ImportResult["extras"]>; // movie_id -> extras (ORDER BY ordinal)
  /** Fetch poster bytes previously stored under `putPoster`. */
  getPoster: (key: string) => Promise<Uint8Array>;
}

/**
 * Rebuild the in-memory AMCCatalog from D1 rows + R2 posters, ready for
 * serializeCatalog(). Custom values are re-expanded to positional order using
 * the defs' ordinal — the format requires exact positional emission.
 */
export async function rowsToCatalog(src: ExportSources): Promise<AMCCatalog> {
  const defs: AMCCustomFieldDef[] = [...src.customFieldDefs]
    .sort((a, z) => a.ordinal - z.ordinal)
    .map((d) => ({
      tag: d.tag,
      name: d.name,
      fieldExt: d.field_ext,
      fieldType: d.field_type,
      defaultValue: d.default_value,
      mediaInfo: d.media_info,
      multiValues: !!d.multi_values,
      multiValuesSep: d.multi_values_sep,
      multiValuesRmp: !!d.multi_values_rmp,
      multiValuesPatch: !!d.multi_values_patch,
      excludedInScripts: !!d.excluded_in_scripts,
      guiProperties: d.gui_properties,
      listValues: JSON.parse(d.list_values || "[]"),
      listAutoAdd: !!d.list_auto_add,
      listSort: !!d.list_sort,
      listAutoComplete: !!d.list_auto_complete,
      listUseCatalogValues: !!d.list_use_catalog_values,
    }));

  const movies: AMCMovie[] = [];
  for (const row of [...src.movies].sort((a, z) => a.number - z.number)) {
    const custom: Record<string, string> = JSON.parse(row.custom_values || "{}");
    const picData = row.poster_key ? await src.getPoster(row.poster_key) : new Uint8Array(0);

    const extraRows = (src.extrasByMovie.get(row.id) ?? []).sort((a, z) => a.ordinal - z.ordinal);
    const extras = [];
    for (const e of extraRows) {
      extras.push({
        checked: !!e.checked,
        tag: e.tag,
        title: e.title,
        category: e.category,
        url: e.url,
        description: e.description,
        comments: e.comments,
        createdBy: e.created_by,
        picture: {
          picPath: e.pic_path,
          picData: e.poster_key ? await src.getPoster(e.poster_key) : new Uint8Array(0),
        },
      });
    }

    movies.push({
      number: row.number,
      date: row.date,
      dateWatched: row.date_watched,
      userRating: row.user_rating,
      rating: row.rating,
      year: row.year,
      length: row.length,
      videoBitrate: row.video_bitrate,
      audioBitrate: row.audio_bitrate,
      disks: row.disks,
      colorTag: row.color_tag,
      checked: !!row.checked,
      media: row.media,
      mediaType: row.media_type,
      source: row.source,
      borrower: row.borrower,
      originalTitle: row.original_title,
      translatedTitle: row.translated_title,
      director: row.director,
      producer: row.producer,
      writer: row.writer,
      composer: row.composer,
      country: row.country,
      category: row.category,
      certification: row.certification,
      actors: row.actors,
      url: row.url,
      description: row.description,
      comments: row.comments,
      filePath: row.file_path,
      videoFormat: row.video_format,
      audioFormat: row.audio_format,
      resolution: row.resolution,
      framerate: row.framerate,
      languages: row.languages,
      subtitles: row.subtitles,
      size: row.size,
      picture: { picPath: row.pic_path, picData },
      customFieldValues: defs.map((d) => custom[d.tag] ?? ""),
      extras,
    });
  }

  return {
    version: src.catalog.version,
    name: src.catalog.name,
    mail: src.catalog.mail,
    site: src.catalog.site,
    description: src.catalog.description,
    cfpColumnSettings: src.catalog.cfp_column_settings,
    cfpGuiProperties: src.catalog.cfp_gui_properties,
    customFieldDefs: defs,
    movies,
  };
}
