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

/**
 * Upload bytes to Mega WITH a correct fingerprint so the desktop client accepts
 * the file. `attributes.c` is the piece megajs would otherwise omit.
 */
export async function uploadToMega(
  storage: Storage,
  name: string,
  bytes: Uint8Array,
  mtimeSec: number = Math.floor(Date.now() / 1000),
): Promise<MegaFile> {
  const c = computeFingerprint(bytes, mtimeSec);
  // megajs's uploadOpts type omits `attributes`, but at runtime it merges any
  // caller-supplied attributes before packing (it only forces `.n = name`), so
  // our `c` fingerprint survives. Cast past the too-narrow type.
  const opts = { name, size: bytes.byteLength, attributes: { c } } as unknown as {
    name: string;
    size: number;
  };
  // megajs's buffer param is typed BufferString (Buffer | string); a Uint8Array
  // works at runtime. Cast via megajs's own param type so no `Buffer` global is
  // referenced (this module targets the browser).
  const source = bytes as unknown as NonNullable<Parameters<Storage["upload"]>[1]>;
  const file = await storage.upload(opts, source).complete;
  return file as unknown as MegaFile;
}

/** Find a file by name at the account root (first match). */
export function findInMega(storage: Storage, name: string): MegaFile | null {
  const children = (storage.root?.children ?? []) as MegaFile[];
  return children.find((f) => f.name === name) ?? null;
}

/** Download a Mega file (a node from the account, or a share link). */
export async function downloadFromMega(fileOrLink: MegaFile | string): Promise<CloudFile> {
  const file = typeof fileOrLink === "string" ? MegaFile.fromURL(fileOrLink) : fileOrLink;
  if (typeof fileOrLink === "string") await file.loadAttributes();
  // downloadBuffer is typed Buffer (Node), but in the browser megajs returns a
  // Uint8Array-compatible value; treat it as one so no `Buffer` global is needed.
  const buf = (await file.downloadBuffer({})) as unknown as Uint8Array;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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
