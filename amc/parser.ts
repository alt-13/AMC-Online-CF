// AMC binary reader/writer — TypeScript port of backend/app/parser/amc_file.py.
//
// Pure, dependency-free byte manipulation. Runs in the browser (where memory
// is plentiful) so the multi-hundred-MB .amc blob never touches a Worker.
//
//   parseCatalog(bytes)      -> AMCCatalog        (import path, in the browser)
//   serializeCatalog(catalog) -> Uint8Array       (export path, in the browser)
//
// Byte layout is identical to the Python backend and the desktop app; a
// parse → serialize round-trip with no edits reproduces the input exactly
// (see the round-trip note re: non-UTF-8 strings at the bottom).

import type {
  AMCCatalog,
  AMCCustomFieldDef,
  AMCExtra,
  AMCMovie,
  AMCPicture,
} from "./types";
import { HEADER_LEN, HEADERS } from "./types";

const td = new TextDecoder("utf-8"); // non-fatal: never throws on bad bytes
const te = new TextEncoder();

// ---------------------------------------------------------------------------
// Low-level reader (mirrors Delphi ReadString / ReadInteger / ReadBoolean)
// ---------------------------------------------------------------------------

class ByteReader {
  private data: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length(): number {
    return this.data.length;
  }
  tell(): number {
    return this.pos;
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.data.length) {
      throw new RangeError(`EOF reading ${what} (${this.data.length - this.pos}/${n})`);
    }
  }

  u32(): number {
    this.need(4, "uint32");
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4, "int32");
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bool(): boolean {
    this.need(1, "bool");
    return this.data[this.pos++] !== 0;
  }

  /** Pascal long string: 4-byte LE length + UTF-8 bytes. */
  str(): string {
    const n = this.u32();
    if (n === 0) return "";
    this.need(n, "string data");
    const slice = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return td.decode(slice);
  }

  /** Pascal length-prefixed raw block (embedded JPEG) — no decode. */
  raw(): Uint8Array {
    const n = this.u32();
    if (n === 0) return new Uint8Array(0);
    this.need(n, "raw block");
    // Copy so the returned bytes outlive the source buffer.
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  bytesFixed(n: number): Uint8Array {
    this.need(n, `${n} bytes`);
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Low-level writer — collects chunks, concatenates once at the end
// ---------------------------------------------------------------------------

class ByteWriter {
  private parts: Uint8Array[] = [];
  private len = 0;

  private push(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }

  i32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v | 0, true);
    this.push(b);
  }

  bool(v: boolean): void {
    this.push(new Uint8Array([v ? 1 : 0]));
  }

  str(s: string): void {
    const b = te.encode(s);
    this.u32(b.length);
    this.push(b);
  }

  raw(b: Uint8Array): void {
    this.u32(b.length);
    this.push(b);
  }

  bytes(b: Uint8Array): void {
    this.push(b);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// AMCPicture
// ---------------------------------------------------------------------------

function readPicture(r: ByteReader): AMCPicture {
  return { picPath: r.str(), picData: r.raw() };
}

function writePicture(w: ByteWriter, p: AMCPicture): void {
  w.str(p.picPath);
  w.raw(p.picData);
}

// ---------------------------------------------------------------------------
// AMCExtra (v4.2+)
// ---------------------------------------------------------------------------

function readExtra(r: ByteReader): AMCExtra {
  return {
    checked: r.bool(),
    tag: r.str(),
    title: r.str(),
    category: r.str(),
    url: r.str(),
    description: r.str(),
    comments: r.str(),
    createdBy: r.str(),
    picture: readPicture(r),
  };
}

function writeExtra(w: ByteWriter, e: AMCExtra): void {
  w.bool(e.checked);
  w.str(e.tag);
  w.str(e.title);
  w.str(e.category);
  w.str(e.url);
  w.str(e.description);
  w.str(e.comments);
  w.str(e.createdBy);
  writePicture(w, e.picture);
}

// ---------------------------------------------------------------------------
// AMCCustomFieldDef
// ---------------------------------------------------------------------------

function readCustomFieldDef(r: ByteReader, tag: string, v: number): AMCCustomFieldDef {
  const d: AMCCustomFieldDef = {
    tag,
    name: r.str(),
    fieldExt: "",
    fieldType: "ftString",
    defaultValue: "",
    mediaInfo: "",
    multiValues: false,
    multiValuesSep: ",".charCodeAt(0),
    multiValuesRmp: false,
    multiValuesPatch: false,
    excludedInScripts: false,
    guiProperties: "",
    listValues: [],
    listAutoAdd: false,
    listSort: false,
    listAutoComplete: false,
    listUseCatalogValues: false,
  };
  if (v >= 41) d.fieldExt = r.str();
  d.fieldType = r.str();
  d.defaultValue = r.str();
  if (v >= 41) d.mediaInfo = r.str();
  d.multiValues = r.bool();
  if (v >= 41) {
    d.multiValuesSep = r.u32(); // Char written with intsize (4 bytes)
    d.multiValuesRmp = r.bool();
    d.multiValuesPatch = r.bool();
  }
  d.excludedInScripts = r.bool();
  d.guiProperties = r.str();
  if (d.fieldType === "ftList") {
    const count = r.i32();
    for (let i = 0; i < count; i++) d.listValues.push(r.str());
    if (v >= 41) {
      d.listAutoAdd = r.bool();
      d.listSort = r.bool();
      d.listAutoComplete = r.bool();
      d.listUseCatalogValues = r.bool();
    }
  }
  return d;
}

function writeCustomFieldDef(w: ByteWriter, d: AMCCustomFieldDef, v: number): void {
  w.str(d.name);
  if (v >= 41) w.str(d.fieldExt);
  w.str(d.fieldType);
  w.str(d.defaultValue);
  if (v >= 41) w.str(d.mediaInfo);
  w.bool(d.multiValues);
  if (v >= 41) {
    w.u32(d.multiValuesSep);
    w.bool(d.multiValuesRmp);
    w.bool(d.multiValuesPatch);
  }
  w.bool(d.excludedInScripts);
  w.str(d.guiProperties);
  if (d.fieldType === "ftList") {
    w.i32(d.listValues.length);
    for (const lv of d.listValues) w.str(lv);
    if (v >= 41) {
      w.bool(d.listAutoAdd);
      w.bool(d.listSort);
      w.bool(d.listAutoComplete);
      w.bool(d.listUseCatalogValues);
    }
  }
}

// ---------------------------------------------------------------------------
// AMCMovie
// ---------------------------------------------------------------------------

function readMovie(r: ByteReader, v: number, defs: AMCCustomFieldDef[]): AMCMovie {
  const m = {} as AMCMovie;
  m.number = r.i32();
  m.date = r.i32();
  if (v >= 42) {
    m.dateWatched = r.i32();
    m.userRating = r.i32();
  } else {
    m.dateWatched = 0;
    m.userRating = -1;
  }
  m.rating = r.i32();
  if (v < 35 && m.rating !== -1) m.rating = m.rating * 10;
  m.year = r.i32();
  m.length = r.i32();
  m.videoBitrate = r.i32();
  m.audioBitrate = r.i32();
  m.disks = r.i32();
  m.colorTag = v >= 41 ? ((r.i32() % 13) + 13) % 13 : 0;
  m.checked = r.bool();
  m.media = r.str();
  if (v >= 33) {
    m.mediaType = r.str();
    m.source = r.str();
  } else {
    m.mediaType = "";
    m.source = "";
  }
  m.borrower = r.str();
  m.originalTitle = r.str();
  m.translatedTitle = r.str();
  m.director = r.str();
  m.producer = r.str();
  if (v >= 42) {
    m.writer = r.str();
    m.composer = r.str();
  } else {
    m.writer = "";
    m.composer = "";
  }
  m.country = r.str();
  m.category = r.str();
  m.certification = v >= 42 ? r.str() : "";
  m.actors = r.str();
  m.url = r.str();
  m.description = r.str();
  m.comments = r.str();
  m.filePath = v >= 42 ? r.str() : "";
  m.videoFormat = r.str();
  m.audioFormat = r.str();
  m.resolution = r.str();
  m.framerate = r.str();
  m.languages = r.str();
  m.subtitles = r.str();
  m.size = r.str();
  m.picture = readPicture(r);
  // v4.0+: N values in order of defs, no count prefix.
  m.customFieldValues = v >= 40 ? defs.map(() => r.str()) : [];
  m.extras = [];
  if (v >= 42) {
    const extraCount = r.i32();
    for (let i = 0; i < extraCount; i++) m.extras.push(readExtra(r));
  }
  return m;
}

function writeMovie(w: ByteWriter, m: AMCMovie, v: number, defs: AMCCustomFieldDef[]): void {
  w.i32(m.number);
  w.i32(m.date);
  if (v >= 42) {
    w.i32(m.dateWatched);
    w.i32(m.userRating);
  }
  w.i32(m.rating);
  w.i32(m.year);
  w.i32(m.length);
  w.i32(m.videoBitrate);
  w.i32(m.audioBitrate);
  w.i32(m.disks);
  if (v >= 41) w.i32(((m.colorTag % 13) + 13) % 13);
  w.bool(m.checked);
  w.str(m.media);
  if (v >= 33) {
    w.str(m.mediaType);
    w.str(m.source);
  }
  w.str(m.borrower);
  w.str(m.originalTitle);
  w.str(m.translatedTitle);
  w.str(m.director);
  w.str(m.producer);
  if (v >= 42) {
    w.str(m.writer);
    w.str(m.composer);
  }
  w.str(m.country);
  w.str(m.category);
  if (v >= 42) w.str(m.certification);
  w.str(m.actors);
  w.str(m.url);
  w.str(m.description);
  w.str(m.comments);
  if (v >= 42) w.str(m.filePath);
  w.str(m.videoFormat);
  w.str(m.audioFormat);
  w.str(m.resolution);
  w.str(m.framerate);
  w.str(m.languages);
  w.str(m.subtitles);
  w.str(m.size);
  writePicture(w, m.picture);
  if (v >= 40) {
    for (let i = 0; i < defs.length; i++) {
      w.str(i < m.customFieldValues.length ? m.customFieldValues[i] : "");
    }
  }
  if (v >= 42) {
    w.i32(m.extras.length);
    for (const e of m.extras) writeExtra(w, e);
  }
}

// ---------------------------------------------------------------------------
// AMCCatalog — top level
// ---------------------------------------------------------------------------

export function parseCatalog(bytes: Uint8Array): AMCCatalog {
  const r = new ByteReader(bytes);

  // --- version detection: 65-byte header, byte-for-byte compare ---
  const headerBytes = r.bytesFixed(HEADER_LEN);
  const headerStr = new TextDecoder("latin1").decode(headerBytes);
  let version: number | null = null;
  for (const [ver, hdr] of Object.entries(HEADERS)) {
    if (headerStr === hdr) {
      version = Number(ver);
      break;
    }
  }
  if (version === null) {
    throw new Error(`Unrecognised AMC file header: ${JSON.stringify(headerStr.slice(0, 30))}`);
  }
  const v = version;

  const catalog: AMCCatalog = {
    version: v,
    name: r.str(),
    mail: r.str(),
    site: "",
    description: "",
    cfpColumnSettings: "",
    cfpGuiProperties: "",
    customFieldDefs: [],
    movies: [],
  };
  if (v < 35) r.str(); // ICQ field removed in v3.5
  catalog.site = r.str();
  catalog.description = r.str();

  // --- CustomFieldsProperties (v4.0+) ---
  if (v >= 40) {
    catalog.cfpColumnSettings = r.str();
    catalog.cfpGuiProperties = r.str();
    const count = r.i32();
    for (let i = 0; i < count; i++) {
      const tag = r.str();
      catalog.customFieldDefs.push(readCustomFieldDef(r, tag, v));
    }
  }

  // --- Movie records: read until EOF ---
  while (r.tell() < r.length) {
    try {
      catalog.movies.push(readMovie(r, v, catalog.customFieldDefs));
    } catch (e) {
      if (e instanceof RangeError) break; // ragged tail — matches Python's EOFError break
      throw e;
    }
  }

  return catalog;
}

export function serializeCatalog(catalog: AMCCatalog): Uint8Array {
  const v = catalog.version;
  const hdr = HEADERS[v];
  if (!hdr) throw new Error(`Unsupported AMC version: ${v}`);

  const w = new ByteWriter();
  w.bytes(new TextEncoder().encode(hdr)); // header is pure ASCII → 65 bytes

  w.str(catalog.name);
  w.str(catalog.mail);
  // NOTE: mirrors Python to_bytes() — write path targets v3.5+ (no ICQ field).
  w.str(catalog.site);
  w.str(catalog.description);

  if (v >= 40) {
    w.str(catalog.cfpColumnSettings);
    w.str(catalog.cfpGuiProperties);
    w.i32(catalog.customFieldDefs.length);
    for (const d of catalog.customFieldDefs) {
      w.str(d.tag);
      writeCustomFieldDef(w, d, v);
    }
  }

  for (const m of catalog.movies) writeMovie(w, m, v, catalog.customFieldDefs);

  return w.toUint8Array();
}

// ---------------------------------------------------------------------------
// Round-trip caveat
// ---------------------------------------------------------------------------
// Python's parser uses errors="surrogateescape" to round-trip strings that are
// not valid UTF-8. JS has no direct equivalent; TextDecoder("utf-8") replaces
// invalid sequences with U+FFFD, so a re-serialize of a non-UTF-8 string would
// not be byte-identical. In practice .amc strings are UTF-8 (or plain ASCII).
// If a corpus turns up Latin-1 catalogs, swap the string codec to a byte-exact
// scheme (store originals as bytes, decode lazily for display).
