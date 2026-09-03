// Mega.nz sync — runs in the BROWSER, not the Worker.
//
// MEGAcmd (the native binary the self-hosted app used) can't run on Cloudflare,
// and doing Mega's AES in a Worker fights the CPU/time budget. But the export
// flow already holds the whole `.amc` Blob in memory in the browser, and megajs
// is pure-JS and browser-capable — so Mega belongs here.
//
// THE FINGERPRINT FIX: megajs uploads only the `n` (name) attribute and never
// the `c` fingerprint, so files it uploads are rejected by the MEGAsync desktop
// client ("file fingerprint missing"). megajs *does* merge caller-supplied
// attributes, so we compute the fingerprint ourselves (mega-fingerprint.ts) and
// pass it as `attributes.c`. See mega-fingerprint.test.ts for the verification.
//
// This is deliberately written behind a small CloudProvider shape so other
// backends (Drive/Dropbox/S3, ideally via OAuth so credentials never touch our
// app) can slot in later — see CF-PORT.md "Versatile cloud sync".

import { Storage, File as MegaFile } from "megajs";
import { computeFingerprint } from "./mega-fingerprint";

export interface CloudFile {
  name: string;
  bytes: Uint8Array;
  /** modification time in whole seconds, if the backend exposes one */
  mtimeSec?: number;
}

export interface CloudProvider {
  /** Upload/overwrite the catalog blob. */
  put(name: string, bytes: Uint8Array, mtimeSec?: number): Promise<void>;
  /** Fetch the catalog blob by name (or provider-specific handle). */
  get(name: string): Promise<CloudFile>;
}

/**
 * Transfer tuning for both directions.
 *
 * megajs defaults to 4 connections and a 128 KB initial chunk that grows by
 * 128 KB (main.browser-es.mjs — `maxConnections` in both the download and
 * upload paths). Those defaults are conservative for a multi-hundred-megabyte
 * .amc: the import download and the export upload are the two costs that
 * dominate a sync once posters are cached.
 *
 * `maxChunkSize` is deliberately NOT set — megajs's 1 MB default is what the
 * upload MAC chunking expects, and there is no clear gain in changing it.
 *
 * Named and exported so it is trivial to retune: if a phone's uplink saturates
 * below 8 connections there is no benefit, and the right value is empirical.
 */
export const TRANSFER_OPTS = { maxConnections: 8, initialChunkSize: 1024 * 1024 };

// --- Mega provider ---------------------------------------------------------

export interface MegaCredentials {
  email: string;
  password: string;
}

/** Log in and wait until the account tree is ready. Do this in the browser;
 *  never send the password to the Worker. */
export async function loginToMega(creds: MegaCredentials): Promise<Storage> {
  const storage = new Storage({ email: creds.email, password: creds.password });
  await storage.ready;
  return storage;
}

// Anything we can upload into: the account (uploads to root) or a folder node.
// Both expose `.upload(opts, source).complete` at runtime; megajs's folder type
// declares only a Writable return, so we describe the shape we actually use.
type Uploader = {
  upload(opts: unknown, source?: unknown): { complete: Promise<unknown> };
};

/**
 * Upload bytes to Mega WITH a correct fingerprint so the desktop client accepts
 * the file. `attributes.c` is the piece megajs would otherwise omit.
 *
 * `target` is the account (upload to root) or a folder node from folderAt/
 * ensureFolderAt (upload into that folder).
 */
export async function uploadToMega(
  target: Storage | MegaFile,
  name: string,
  bytes: Uint8Array,
  mtimeSec: number = Math.floor(Date.now() / 1000),
): Promise<MegaFile> {
  const c = computeFingerprint(bytes, mtimeSec);
  // megajs's uploadOpts type omits `attributes`, but at runtime it merges any
  // caller-supplied attributes before packing (it only forces `.n = name`), so
  // our `c` fingerprint survives. Cast past the too-narrow type.
  // Spread TRANSFER_OPTS FIRST so the explicit fields below always win — in
  // particular `attributes.c`, the fingerprint the desktop client requires.
  const opts = { ...TRANSFER_OPTS, name, size: bytes.byteLength, attributes: { c } };
  // megajs's buffer param is typed BufferString (Buffer | string); a Uint8Array
  // works at runtime. No `Buffer` global is referenced (this module targets the
  // browser).
  const file = await (target as unknown as Uploader).upload(opts, bytes).complete;
  return file as unknown as MegaFile;
}

// --- paths -----------------------------------------------------------------
//
// Mega has real folders, so a catalog can live at e.g. "/Backups/movies.amc",
// not just the account root. A path is "/"-separated; a trailing ".amc" segment
// is treated as the filename, everything before it as the folder chain.

export interface AmcPath {
  /** folder names from the root, in order (empty = the account root) */
  segments: string[];
  /** the ".amc" filename if the path named one, else null */
  filename: string | null;
}

/** Parse a "/Folder/Sub/file.amc"-style path (leading/trailing slashes ok). */
export function splitAmcPath(path: string): AmcPath {
  const parts = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length && parts[parts.length - 1].toLowerCase().endsWith(".amc")) {
    const filename = parts.pop() as string;
    return { segments: parts, filename };
  }
  return { segments: parts, filename: null };
}

/** Walk existing folders to the one named by `segments`; null if any is missing. */
export function folderAt(storage: Storage, segments: string[]): MegaFile | null {
  let node: MegaFile = storage.root as unknown as MegaFile;
  for (const seg of segments) {
    const children = (node.children ?? []) as MegaFile[];
    const next = children.find((c) => c.directory && (c.name ?? "") === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Resolve a folder node by its stable Mega handle (nodeId). Used by origin
 *  push, where a catalog's source_ref stored the parent folder's handle. */
export function folderByHandle(storage: Storage, handle: string): MegaFile | null {
  if (handle && handle === (storage.root?.nodeId ?? "")) {
    return storage.root as unknown as MegaFile;
  }
  const found = storage.find(
    (f) => f.directory === true && (f.nodeId ?? "") === handle,
    true,
  ) as unknown as MegaFile | null;
  return found ?? null;
}

/** Like folderAt, but creates any missing folders along the way. */
export async function ensureFolderAt(storage: Storage, segments: string[]): Promise<MegaFile> {
  let node: MegaFile = storage.root as unknown as MegaFile;
  for (const seg of segments) {
    const children = (node.children ?? []) as MegaFile[];
    let next = children.find((c) => c.directory && (c.name ?? "") === seg) ?? null;
    if (!next) {
      next = (await (node as unknown as { mkdir(name: string): Promise<MegaFile> }).mkdir(
        seg,
      )) as MegaFile;
    }
    node = next;
  }
  return node;
}

/** List `.amc` files at a folder path ("" = root). `deep` recurses subfolders. */
export function listAmcFiles(storage: Storage, path = "", deep = false): MegaFile[] {
  const { segments } = splitAmcPath(path);
  const folder = folderAt(storage, segments);
  if (!folder) return [];
  const pool = deep
    ? ((folder.children ?? []) as MegaFile[]).concat(collectDeep(folder))
    : ((folder.children ?? []) as MegaFile[]);
  const seen = new Set<string>();
  return pool.filter((f) => {
    if (f.directory || !(f.name ?? "").toLowerCase().endsWith(".amc")) return false;
    const id = f.nodeId ?? f.name ?? "";
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function collectDeep(folder: MegaFile): MegaFile[] {
  const out: MegaFile[] = [];
  for (const c of (folder.children ?? []) as MegaFile[]) {
    if (c.directory) {
      out.push(...((c.children ?? []) as MegaFile[]), ...collectDeep(c));
    }
  }
  return out;
}

/**
 * Resolve a full path ("/Folder/file.amc") to a single file node. Falls back to
 * a deep search by filename anywhere in the account when the exact folder path
 * has no match. Returns null if nothing matches.
 */
export function resolveAmcFile(storage: Storage, path: string): MegaFile | null {
  const { segments, filename } = splitAmcPath(path);
  if (!filename) return null;
  const folder = folderAt(storage, segments);
  if (folder) {
    const hit = ((folder.children ?? []) as MegaFile[]).find(
      (f) => !f.directory && (f.name ?? "") === filename,
    );
    if (hit) return hit;
  }
  // Not at that exact path — search the whole account for the filename.
  const found = storage.find(
    (f) => !f.directory && (f.name ?? "") === filename,
    true,
  ) as unknown as MegaFile | null;
  return found ?? null;
}

/** Find a file by name at the account root (first match). */
export function findInMega(storage: Storage, name: string): MegaFile | null {
  const children = (storage.root?.children ?? []) as MegaFile[];
  return children.find((f) => f.name === name) ?? null;
}

// Minimal view of the Node-style Readable megajs returns in the browser — just
// the three events we consume. Avoids pulling Node stream types into the app.
interface DownloadStream {
  on(ev: "data", cb: (chunk: Uint8Array) => void): void;
  on(ev: "end", cb: () => void): void;
  on(ev: "error", cb: (e: unknown) => void): void;
}

/**
 * Download a Mega file (a node from the account, or a share link). Streams so a
 * big file reports byte progress instead of sitting silent — `onProgress` fires
 * with (bytesLoaded, bytesTotal) as chunks arrive. Errors reject (and surface in
 * the UI) rather than hanging.
 */
export async function downloadFromMega(
  fileOrLink: MegaFile | string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CloudFile> {
  const file = typeof fileOrLink === "string" ? MegaFile.fromURL(fileOrLink) : fileOrLink;
  if (typeof fileOrLink === "string") await file.loadAttributes();

  const total = file.size ?? 0;
  const stream = file.download(TRANSFER_OPTS) as unknown as DownloadStream;

  // Preallocate to the known size and clamp writes, so peak memory is 1× the file
  // (matters on a phone) and a size mismatch can never overflow the buffer.
  const buf = total > 0 ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => {
      if (buf) {
        const c = loaded + chunk.length > total ? chunk.subarray(0, total - loaded) : chunk;
        buf.set(c, loaded);
        loaded += c.length;
      } else {
        chunks.push(chunk);
        loaded += chunk.length;
      }
      onProgress?.(loaded, total || loaded);
    });
    stream.on("end", () => resolve());
    stream.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });

  let bytes: Uint8Array;
  if (buf) {
    bytes = loaded === total ? buf : buf.subarray(0, loaded);
  } else {
    bytes = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
  }
  return { name: file.name ?? "", bytes, mtimeSec: file.timestamp };
}

/** Wrap a logged-in Mega session as a generic CloudProvider. */
export function megaProvider(storage: Storage): CloudProvider {
  return {
    put: async (name, bytes, mtimeSec) => {
      await uploadToMega(storage, name, bytes, mtimeSec);
    },
    get: async (name) => {
      const file = findInMega(storage, name);
      if (!file) throw new Error(`Mega: "${name}" not found`);
      return downloadFromMega(file);
    },
  };
}
