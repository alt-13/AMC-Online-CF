// Frontend bridge: Mega.nz <-> the catalog import/export flows.
//
// Ties browser/mega.ts (login + fingerprinted upload/download + folder paths) to
// the existing export.ts (builds the .amc Blob) and import.ts (parses an .amc into
// D1+R2), carrying the auth session automatically. The Vue components call this;
// they never touch megajs directly.
//
// The Mega session lives ONLY in this browser tab's memory. We never persist the
// password and never send it to the Worker — doing cloud sync client-side is the
// whole reason Mega belongs in the browser (see cf/CF-PORT.md "Mega import/export").
//
// This is written provider-agnostically on purpose: Mega is the first backend,
// but the same shape (connect → list → push/pull) is meant to host Drive/Dropbox/
// S3 later, ideally via OAuth so credentials never touch the app at all.

import { reactive } from "vue";
import { exportAmcFile, importAmcFile, session } from "./api";
import {
  loginToMega,
  uploadToMega,
  downloadFromMega,
  splitAmcPath,
  folderAt,
  ensureFolderAt,
  listAmcFiles,
  resolveAmcFile,
  type MegaCredentials,
} from "../browser/mega";
import type { Storage, File as MegaFile } from "megajs";

// megajs's own MutableFile class (the node type with .delete) isn't exported from
// its type defs, only File is. We only need the .delete method here.
type Deletable = { delete(permanent: boolean): Promise<unknown> };

let storage: Storage | null = null;

/** Reactive connection state so any component can react to connect/disconnect. */
export const megaState = reactive({
  connected: false,
  email: "",
});

// --- settings (persisted) --------------------------------------------------
//
// The `.amc` location on Mega. May be a folder ("/Backups") to list/push into,
// or a full path to one file ("/Backups/movies.amc"). Persisted in localStorage
// so it survives reloads — it's a preference, not a secret (unlike the password).

const PATH_KEY = "amc.mega.path";

function loadPath(): string {
  try {
    return localStorage.getItem(PATH_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Reactive Mega settings; bind the path input to `megaSettings.path`. */
export const megaSettings = reactive({ path: loadPath() });

/** Set and persist the `.amc` path/folder. */
export function setMegaPath(path: string): void {
  megaSettings.path = path;
  try {
    localStorage.setItem(PATH_KEY, path);
  } catch {
    /* private mode / storage disabled — keep it in memory only */
  }
}

/** Log in to Mega in the browser and keep the session for this tab only. */
export async function megaConnect(creds: MegaCredentials): Promise<void> {
  const s = await loginToMega(creds);
  storage = s;
  megaState.connected = true;
  megaState.email = creds.email;
}

/** Drop the in-memory Mega session. */
export function megaDisconnect(): void {
  storage = null;
  megaState.connected = false;
  megaState.email = "";
}

export interface MegaAmcFile {
  name: string;
  size: number;
  node: MegaFile;
}

/**
 * List `.amc` files at the configured path (defaults to `megaSettings.path`; ""
 * = account root). Pass `deep` to recurse subfolders.
 */
export function megaListAmc(path: string = megaSettings.path, deep = false): MegaAmcFile[] {
  if (!storage) throw new Error("Not connected to Mega");
  const { filename } = splitAmcPath(path);
  // If the path names a single file, resolve just that one.
  if (filename) {
    const node = resolveAmcFile(storage, path);
    return node ? [{ name: node.name ?? filename, size: node.size ?? 0, node }] : [];
  }
  return listAmcFiles(storage, path, deep).map((f) => ({
    name: f.name ?? "",
    size: f.size ?? 0,
    node: f,
  }));
}

/**
 * Build the .amc for `catalogId` in the browser and upload it to Mega WITH a
 * fingerprint (so the desktop client accepts it), at the configured path. If the
 * path names a file its name is used; otherwise `{name}.amc` inside the folder.
 * A file of the same name is replaced only after the new upload succeeds.
 */
export async function megaPush(
  catalogId: string,
  name: string,
  onProgress?: (done: number, total: number) => void,
  path: string = megaSettings.path,
): Promise<void> {
  if (!storage) throw new Error("Not connected to Mega");
  const { segments, filename } = splitAmcPath(path);
  const targetName = filename ?? (name.toLowerCase().endsWith(".amc") ? name : `${name}.amc`);

  const blob = await exportAmcFile(catalogId, { ...session(), onProgress });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // Upload target: the account root, or the folder chain (created if missing).
  const target = segments.length ? await ensureFolderAt(storage, segments) : storage;

  // Existing copy to replace, looked up in the same folder.
  const folder = segments.length ? folderAt(storage, segments) : (storage.root as unknown as MegaFile);
  const previous =
    (((folder?.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === targetName)) ??
    null;

  await uploadToMega(target, targetName, bytes);
  if (previous) {
    // Replace: remove the stale copy, but a failed delete must not fail the push.
    try {
      await (previous as unknown as Deletable).delete(true);
    } catch {
      /* leave the old copy in place */
    }
  }
}

/**
 * Download an `.amc` from Mega and import it into D1+R2, exactly like a local
 * file upload. Returns the new catalog id.
 */
export async function megaPull(
  node: MegaFile,
  onProgress?: (done: number, total: number, phase: "posters" | "rows") => void,
): Promise<string> {
  const file = await downloadFromMega(node);
  const blob = new Blob([file.bytes], { type: "application/octet-stream" });
  return importAmcFile(blob, { ...session(), onProgress });
}

/**
 * Resolve a full `.amc` path ("/Folder/file.amc") to a node and import it. Falls
 * back to a deep search by filename. Throws if nothing matches.
 */
export async function megaPullPath(
  path: string = megaSettings.path,
  onProgress?: (done: number, total: number, phase: "posters" | "rows") => void,
): Promise<string> {
  if (!storage) throw new Error("Not connected to Mega");
  const node = resolveAmcFile(storage, path);
  if (!node) throw new Error(`No .amc found at "${path}"`);
  return megaPull(node, onProgress);
}
