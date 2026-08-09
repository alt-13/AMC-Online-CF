// Frontend bridge: Mega.nz <-> the catalog import/export flows.
//
// Ties browser/mega.ts (login + fingerprinted upload/download) to the existing
// export.ts (builds the .amc Blob) and import.ts (parses an .amc into D1+R2),
// carrying the auth session automatically. The Vue components call this; they
// never touch megajs directly.
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
  findInMega,
  downloadFromMega,
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

/** List `.amc` files at the account root. */
export function megaListAmc(): MegaAmcFile[] {
  if (!storage) throw new Error("Not connected to Mega");
  const children = (storage.root?.children ?? []) as MegaFile[];
  return children
    .filter((f) => (f.name ?? "").toLowerCase().endsWith(".amc"))
    .map((f) => ({ name: f.name ?? "", size: f.size ?? 0, node: f }));
}

/**
 * Build the .amc for `catalogId` in the browser and upload it to Mega WITH a
 * fingerprint (so the desktop client accepts it). If a file of the same name
 * already exists it is replaced only after the new upload succeeds.
 */
export async function megaPush(
  catalogId: string,
  name: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!storage) throw new Error("Not connected to Mega");
  const filename = name.toLowerCase().endsWith(".amc") ? name : `${name}.amc`;

  const blob = await exportAmcFile(catalogId, { ...session(), onProgress });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const previous = findInMega(storage, filename);
  await uploadToMega(storage, filename, bytes);
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
