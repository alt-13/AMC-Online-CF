// Frontend bridge: cloud providers <-> the catalog import/export flows.
//
// Ties browser/mega.ts (the Mega connector) to export.ts (builds the .amc Blob)
// and import.ts (parses an .amc into D1+R2), carrying the auth session. The Vue
// components call this; they never touch megajs directly.
//
// Connections are EPHEMERAL: opened only for a transfer. Import connects, lists,
// pulls, then auto-disconnects. Export opens exactly one connection — to the
// catalog's own origin (its source_ref) — pushes, and disconnects. Only ONE live
// session ever exists at a time (cloudSession), keyed by the provider in use.
//
// The Mega session lives ONLY in this browser tab's memory. We never persist the
// password to the Worker except, if the user opts in, ENCRYPTED at rest for
// auto-reconnect (worker/crypto.ts). See CF-PORT.md "Mega import/export".

import { reactive } from "vue";
import { exportAmcFile, importAmcFile, session, cloud, type CatalogRow } from "./api";
import {
  loginToMega,
  uploadToMega,
  downloadFromMega,
  splitAmcPath,
  folderAt,
  ensureFolderAt,
  folderByHandle,
  listAmcFiles,
  resolveAmcFile,
  type MegaCredentials,
} from "../browser/mega";
import type { Storage, File as MegaFile } from "megajs";
import { getCachedAmc, putCachedAmc, dropCachedAmc } from "./amccache";
import {
  parseSourceRef,
  splitMegaLocator,
  formatMegaSourceRef,
  pickActiveProvider,
} from "./cloudref";

// megajs's MutableFile (the node type with .delete) isn't exported; we only need
// .delete here.
type Deletable = { delete(permanent: boolean): Promise<unknown> };

let storage: Storage | null = null;

/** Thrown by syncCatalogToOrigin when the origin provider needs a login first. */
export class CloudLoginRequiredError extends Error {
  constructor(public provider: string) {
    super(`Connect ${provider} to sync this library`);
    this.name = "CloudLoginRequiredError";
  }
}

export interface MegaAmcFile {
  name: string;
  size: number;
  node: MegaFile;
}

type Phase = "download" | "reading" | "posters" | "rows";
type PullProgress = (done: number, total: number, phase: Phase) => void;
type PushProgress = (done: number, total: number) => void;

// --- reactive state --------------------------------------------------------

/** The single transient live session (connected + which provider + account). */
export const cloudSession = reactive({ connected: false, provider: "", email: "" });

/** Per-provider settings (path + whether a credential is stored) and which
 *  provider the UI is currently showing. `providers` is filled by
 *  loadCloudConfig; `active` is derived (newest credentialed provider). */
export const cloudSettings = reactive({
  active: "mega",
  loaded: false,
  providers: {} as Record<string, { path: string; hasCredential: boolean }>,
});

function providerState(p: string): { path: string; hasCredential: boolean } {
  return (cloudSettings.providers[p] ??= { path: "", hasCredential: false });
}

/** Load every provider row from the server and pick the active provider. Safe to
 *  call repeatedly; swallows errors so the UI still renders when unauthenticated. */
export async function loadCloudConfig(): Promise<void> {
  try {
    const rows = await cloud.get();
    const map: Record<string, { path: string; hasCredential: boolean }> = {};
    for (const r of rows) map[r.provider] = { path: r.path, hasCredential: r.hasCredential };
    cloudSettings.providers = map;
    cloudSettings.active = pickActiveProvider(rows);
    providerState(cloudSettings.active); // ensure an entry exists for the form
  } catch {
    /* not authenticated yet / offline — leave defaults */
  } finally {
    cloudSettings.loaded = true;
  }
}

/** Persist the active provider's `.amc` path (never touches the credential). */
export async function saveActivePath(path: string): Promise<void> {
  const provider = cloudSettings.active;
  providerState(provider).path = path;
  const c = await cloud.save({ provider, path });
  cloudSettings.providers[provider] = { path: c.path, hasCredential: c.hasCredential };
}

// --- connectors ------------------------------------------------------------
//
// Minimal seam: Mega is the only implementation today. Adding Drive/Dropbox/S3
// later = add an entry here + flip its <option disabled> in CloudSync.vue.

interface CloudConnector {
  login(creds: MegaCredentials): Promise<Storage>;
  listAmc(storage: Storage, path: string, deep: boolean): MegaAmcFile[];
  /** Stable "same file" origin key for a downloaded node, or null if incomplete. */
  sourceRefOf(node: MegaFile): string | null;
  download(node: MegaFile, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array>;
  /** Push to the origin the source_ref locator points at (folder handle + name). */
  pushToLocator(storage: Storage, locator: string, bytes: Uint8Array): Promise<void>;
  /** Push to a user-chosen path; return the resulting full source_ref. */
  pushToPath(storage: Storage, path: string, fallbackName: string, bytes: Uint8Array): Promise<string>;
}

const megaConnector: CloudConnector = {
  login: loginToMega,

  listAmc(storage, path, deep) {
    const { filename } = splitAmcPath(path);
    if (filename) {
      const node = resolveAmcFile(storage, path);
      return node ? [{ name: node.name ?? filename, size: node.size ?? 0, node }] : [];
    }
    return listAmcFiles(storage, path, deep).map((f) => ({
      name: f.name ?? "",
      size: f.size ?? 0,
      node: f,
    }));
  },

  sourceRefOf(node) {
    const parent = node.parent?.nodeId;
    const name = node.name;
    return parent && name ? formatMegaSourceRef(parent, name) : null;
  },

  async download(node, onProgress) {
    const file = await downloadFromMega(node, onProgress);
    return file.bytes;
  },

  async pushToLocator(storage, locator, bytes) {
    const { handle, name } = splitMegaLocator(locator);
    const folder = folderByHandle(storage, handle);
    if (!folder) throw new Error("the folder this library came from no longer exists on Mega");
    await replaceInFolder(storage, folder, name, bytes);
  },

  async pushToPath(storage, path, fallbackName, bytes) {
    const { segments, filename } = splitAmcPath(path);
    const name = filename ?? (fallbackName.toLowerCase().endsWith(".amc") ? fallbackName : `${fallbackName}.amc`);
    const folder = segments.length
      ? await ensureFolderAt(storage, segments)
      : (storage.root as unknown as MegaFile);
    await replaceInFolder(storage, folder, name, bytes);
    const handle = folder.nodeId ?? storage.root?.nodeId ?? "";
    return formatMegaSourceRef(handle, name);
  },
};

/** Upload `bytes` as `name` into `folder`, replacing any existing same-named file
 *  only AFTER the new upload succeeds (a failed delete never fails the push). */
async function replaceInFolder(
  storage: Storage,
  folder: MegaFile,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const previous =
    (((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)) ?? null;
  const target = folder === (storage.root as unknown as MegaFile) ? storage : folder;
  await uploadToMega(target as Storage | MegaFile, name, bytes);
  if (previous) {
    try {
      await (previous as unknown as Deletable).delete(true);
    } catch {
      /* leave the stale copy in place */
    }
  }
}

const CONNECTORS: Record<string, CloudConnector> = { mega: megaConnector };

function connectorFor(provider: string): CloudConnector {
  const c = CONNECTORS[provider];
  if (!c) throw new Error(`unknown cloud provider "${provider}"`);
  return c;
}

// --- connect / disconnect --------------------------------------------------

/** Log in to `provider` and hold the session for this tab. If `remember`, send
 *  the credential once to be encrypted-at-rest for future auto-reconnect. */
export async function connect(
  provider: string,
  creds: MegaCredentials,
  remember = false,
): Promise<void> {
  storage = await connectorFor(provider).login(creds);
  cloudSession.connected = true;
  cloudSession.provider = provider;
  cloudSession.email = creds.email;
  if (remember) {
    const c = await cloud.save({
      provider,
      path: providerState(provider).path,
      credential: JSON.stringify(creds),
    });
    cloudSettings.providers[provider] = { path: c.path, hasCredential: c.hasCredential };
  }
}

/** Reconnect `provider` from its stored (encrypted) credential. False if none. */
export async function autoConnect(provider: string): Promise<boolean> {
  try {
    const { credential } = await cloud.connect(provider);
    const creds = JSON.parse(credential) as MegaCredentials;
    storage = await connectorFor(provider).login(creds);
    cloudSession.connected = true;
    cloudSession.provider = provider;
    cloudSession.email = creds.email;
    return true;
  } catch {
    return false;
  }
}

/** Forget one provider's stored credential (clears it server-side). */
export async function forgetCredential(provider: string): Promise<void> {
  await cloud.save({ provider, credential: null });
  providerState(provider).hasCredential = false;
}

/** Drop the in-memory session (keeps any stored credential). */
export function disconnect(): void {
  storage = null;
  cloudSession.connected = false;
  cloudSession.provider = "";
  cloudSession.email = "";
}

/** Switch the UI to `provider`: drop the current session, then auto-connect if a
 *  credential is stored (else the connect form shows). */
export async function switchProvider(provider: string): Promise<void> {
  if (provider === cloudSession.provider && cloudSession.connected) {
    cloudSettings.active = provider;
    return;
  }
  disconnect();
  cloudSettings.active = provider;
  providerState(provider);
  if (cloudSettings.providers[provider]?.hasCredential) {
    await autoConnect(provider);
  }
}

// --- import (browse direction) ---------------------------------------------

/** List `.amc` files at the active provider's path. */
export function listAmc(path = providerState(cloudSettings.active).path, deep = false): MegaAmcFile[] {
  if (!storage) throw new Error("Not connected");
  return connectorFor(cloudSession.provider).listAmc(storage, path, deep);
}

/** Download an `.amc` and import it into D1+R2, then auto-disconnect. Returns the
 *  new catalog id. Mirrors the local-upload path (cache-then-import). */
export async function pull(node: MegaAmcFile, onProgress?: PullProgress): Promise<string> {
  if (!storage) throw new Error("Not connected");
  const connector = connectorFor(cloudSession.provider);
  const sourceRef = connector.sourceRefOf(node.node);

  let bytes = sourceRef ? await getCachedAmc(sourceRef) : null;
  if (bytes) {
    onProgress?.(bytes.length, bytes.length, "download");
  } else {
    bytes = await connector.download(node.node, (loaded, total) => onProgress?.(loaded, total, "download"));
    if (sourceRef) await putCachedAmc(sourceRef, bytes);
  }

  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const id = await importAmcFile(blob, {
    ...session(),
    onProgress,
    sourceRef,
    fallbackName: (node.name ?? "").replace(/\.amc$/i, ""),
  });
  if (sourceRef) await dropCachedAmc(sourceRef);
  disconnect(); // ephemeral: nothing needs to stay connected after an import
  return id;
}

// --- export (push direction) -----------------------------------------------

/** Ensure a live session to `provider`: reuse the current one if it matches,
 *  else auto-connect; throw CloudLoginRequiredError if no credential is stored. */
async function ensureConnected(provider: string): Promise<void> {
  if (cloudSession.connected && cloudSession.provider === provider && storage) return;
  disconnect();
  if (!(await autoConnect(provider))) throw new CloudLoginRequiredError(provider);
}

async function buildAmc(catalog: CatalogRow, onProgress?: PushProgress): Promise<Uint8Array> {
  const blob = await exportAmcFile(catalog.id, { ...session(), onProgress });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Push a catalog back to its cloud origin (its source_ref), just-in-time. */
export async function syncCatalogToOrigin(catalog: CatalogRow, onProgress?: PushProgress): Promise<void> {
  if (!catalog.source_ref) throw new Error("catalog has no cloud origin");
  const { provider, locator } = parseSourceRef(catalog.source_ref);
  const connector = connectorFor(provider);
  await ensureConnected(provider);
  const bytes = await buildAmc(catalog, onProgress);
  await connector.pushToLocator(storage!, locator, bytes);
  disconnect();
}

/** First push of a no-origin catalog: push to a chosen provider+path, write the
 *  resulting source_ref back to the catalog, and return it. Assumes a live
 *  session to `provider` already exists (the caller connected it). */
export async function pushAdoptingOrigin(
  catalog: CatalogRow,
  provider: string,
  path: string,
  onProgress?: PushProgress,
): Promise<string> {
  await ensureConnected(provider);
  const bytes = await buildAmc(catalog, onProgress);
  const fallbackName = catalog.name || "catalog";
  const sourceRef = await connectorFor(provider).pushToPath(storage!, path, fallbackName, bytes);
  disconnect();
  return sourceRef;
}
