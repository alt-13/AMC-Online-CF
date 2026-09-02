// AMC binary model — TypeScript port of backend/app/parser/amc_file.py
//
// Field-for-field mirror of the Python dataclasses so a round-trip
// (parse → edit → serialize) is byte-identical to the desktop
// Ant Movie Catalog and to the existing Python backend.
//
// Format reference: BinaryFormatResearch.md
//
// NOTE ON PICTURES: `picData` holds raw JPEG bytes as read from the file.
// In the Cloudflare port these bytes never reach D1 — the import flow lifts
// them into R2 and swaps `picData` for an R2 key (see amc/mapping.ts).

export interface AMCPicture {
  /** Relative path to an external picture file, or "" if none/embedded. */
  picPath: string;
  /** Raw JPEG bytes; empty if no embedded image. */
  picData: Uint8Array;
}

export interface AMCExtra {
  checked: boolean;
  tag: string;
  title: string;
  category: string;
  url: string;
  description: string;
  comments: string;
  createdBy: string;
  picture: AMCPicture;
}

export interface AMCCustomFieldDef {
  tag: string; // key used in per-movie values
  name: string; // display label
  fieldExt: string; // [v41+]
  fieldType: string; // "ftString" | "ftInteger" | "ftBoolean" | "ftList" | …
  defaultValue: string;
  mediaInfo: string; // [v41+]
  multiValues: boolean;
  multiValuesSep: number; // [v41+] separator char stored as a 4-byte int
  multiValuesRmp: boolean; // [v41+]
  multiValuesPatch: boolean; // [v41+]
  excludedInScripts: boolean;
  guiProperties: string;
  listValues: string[];
  listAutoAdd: boolean; // [v41+]
  listSort: boolean; // [v41+]
  listAutoComplete: boolean; // [v41+]
  listUseCatalogValues: boolean; // [v41+]
}

export interface AMCMovie {
  number: number;
  date: number; // Delphi TDateTime as int (days since 30-Dec-1899)
  dateWatched: number; // [v4.2+]
  userRating: number; // [v4.2+] rating*10, -1 = unset
  rating: number; // rating*10, -1 = unset
  year: number; // -1 = unset
  length: number; // minutes, -1 = unset
  videoBitrate: number;
  audioBitrate: number;
  disks: number;
  colorTag: number; // [v4.1+] 0-12
  checked: boolean;
  media: string;
  mediaType: string; // [v3.3+]
  source: string; // [v3.3+]
  borrower: string;
  originalTitle: string;
  translatedTitle: string;
  director: string;
  producer: string;
  writer: string; // [v4.2+]
  composer: string; // [v4.2+]
  country: string;
  category: string;
  certification: string; // [v4.2+]
  actors: string;
  url: string;
  description: string;
  comments: string;
  filePath: string; // [v4.2+]
  videoFormat: string;
  audioFormat: string;
  resolution: string;
  framerate: string;
  languages: string;
  subtitles: string;
  size: string;
  picture: AMCPicture;
  /** Positional — index i corresponds to catalog.customFieldDefs[i]. */
  customFieldValues: string[];
  extras: AMCExtra[]; // [v4.2+]
}

export interface AMCCatalog {
  version: number; // 31 | 33 | 35 | 40 | 41 | 42
  name: string;
  mail: string;
  site: string;
  description: string;
  cfpColumnSettings: string; // [v4.0+]
  cfpGuiProperties: string; // [v4.0+]
  customFieldDefs: AMCCustomFieldDef[];
  movies: AMCMovie[];
}

/** The widest value an int32 field (`w.i32` in parser.ts) can round-trip. The
 *  writer does `setInt32(v | 0)`, which WRAPS silently rather than throwing, so
 *  anything wider would come back out of the .amc as a negative. Anything that
 *  lets a user type into an int32-backed column (today: `movies.number`) has to
 *  clamp against this before it reaches storage — see rule 1, round-trip
 *  fidelity. */
export const MAX_INT32 = 2_147_483_647;

export const HEADER_LEN = 65;

/** Known 65-byte ASCII version headers (mirror of HEADERS in amc_file.py). */
export const HEADERS: Record<number, string> = {
  31: " AMC_3.1 Ant Movie Catalog 3.1.x   www.buypin.com  www.ant.be.tf ",
  33: " AMC_3.3 Ant Movie Catalog 3.3.x   www.buypin.com  www.ant.be.tf ",
  35: " AMC_3.5 Ant Movie Catalog 3.5.x   www.buypin.com    www.antp.be ",
  40: " AMC_4.0 Ant Movie Catalog 4.0.x   antp/soulsnake    www.antp.be ",
  41: " AMC_4.1 Ant Movie Catalog 4.1.x   antp/soulsnake    www.antp.be ",
  42: " AMC_4.2 Ant Movie Catalog 4.2.x   antp/soulsnake    www.antp.be ",
};
