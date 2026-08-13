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
import { exportAmcFile, importAmcFile, session, cloud } from "./api";
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

// --- settings (persisted per-user, server-side) ----------------------------
//
// provider + the `.amc` path ("/Backups/movies.amc", a folder, or "" for root)
// are stored per user in D1 (not secrets). The Mega credential, if the user opts
// to be remembered, is stored ENCRYPTED at rest by the Worker (worker/crypto.ts)
// and only ever handed back to this browser to log in with — never to the
// desktop-less "server operator", because in the self-hosting model the operator
// IS the user. See CF-PORT.md "Mega import/export".

/** Reactive Mega settings; bind the path input to `megaSettings.path`. */
export const megaSettings = reactive({
  provider: "mega",
  path: "",
  hasCredential: false, // a stored (encrypted) credential exists server-side
  loaded: false, // config has been fetched from the server this session
});

/** Load provider/path/hasCredential from the server (requires a logged-in app
 *  session). Safe to call repeatedly; swallows errors so the UI still renders. */
export async function loadCloudConfig(): Promise<void> {
  try {
    const c = await cloud.get();
    megaSettings.provider = c.provider || "mega";
    megaSettings.path = c.path;
    megaSettings.hasCredential = c.hasCredential;
  } catch {
    /* not authenticated yet / offline — leave defaults */
  } finally {
    megaSettings.loaded = true;
  }
}

/** Persist provider + `.amc` path (never touches the credential). */
export async function saveMegaPath(path: string): Promise<void> {
  megaSettings.path = path;
  const c = await cloud.save({ provider: megaSettings.provider, path });
  megaSettings.hasCredential = c.hasCredential;
}

/**
 * Log in to Mega in the browser and keep the session for this tab. If `remember`
 * is set, the credential is sent once to the Worker to be encrypted-at-rest so
 * future sessions can auto-reconnect (see megaAutoConnect).
 */
export async function megaConnect(creds: MegaCredentials, remember = false): Promise<void> {
  const s = await loginToMega(creds);
  storage = s;
  megaState.connected = true;
  megaState.email = creds.email;
  if (remember) {
    const c = await cloud.save({
      provider: "mega",
      path: megaSettings.path,
      credential: JSON.stringify({ email: creds.email, password: creds.password }),
    });
    megaSettings.hasCredential = c.hasCredential;
  }
}

/**
 * Try to reconnect using the stored (encrypted) credential, so the user doesn't
 * have to log in again. Returns false when nothing is stored or login fails.
 */
export async function megaAutoConnect(): Promise<boolean> {
  try {
    const { credential } = await cloud.connect();
    const creds = JSON.parse(credential) as MegaCredentials;
    const s = await loginToMega(creds);
    storage = s;
    megaState.connected = true;
    megaState.email = creds.email;
    return true;
  } catch {
    return false;
  }
}

/** Forget the stored credential (clears it server-side). */
export async function megaForgetCredential(): Promise<void> {
  await cloud.save({ credential: null });
  megaSettings.hasCredential = false;
}

/** Drop the in-memory Mega session (keeps any stored credential). */
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
  const blob = new Blob([file.bytes as BlobPart], { type: "application/octet-stream" });
  // Identify the file by its parent folder handle + name — stable even when a
  // push replaces the file bytes (and thus its own handle). Lets a re-pull
  // supersede the previous catalog instead of stacking duplicates.
  return importAmcFile(blob, { ...session(), onProgress, sourceRef: megaSourceRef(node) });
}

/** Stable "same file" key for a Mega node: `mega:<parentFolderHandle>:<name>`. */
function megaSourceRef(node: MegaFile): string {
  const parent = (node as unknown as { parent?: { nodeId?: string } }).parent?.nodeId ?? "";
  return `mega:${parent}:${node.name ?? ""}`;
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
