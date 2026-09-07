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
import { importAmcFile, session, cloud, cf, type CatalogRow } from "./api";
import { buildAmcFile } from "../browser/export";
import type { ImportPhase } from "../browser/import";
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
import type { TransferState } from "./syncstatus";
import { canSkipUpload, deriveStatus } from "./syncstatus";
import { contentCrcOf, computeFingerprint } from "../browser/mega-fingerprint";
import { sha256Hex } from "../amc/posterkey";
import { withWakeLock } from "./wakelock";

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

type Phase = "download" | ImportPhase;
type PullProgress = (done: number, total: number, phase: Phase) => void;
type PushProgress = (done: number, total: number, phase: string) => void;

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

/**
 * Transfers currently running, keyed by catalog id.
 *
 * Shared rather than component-local on purpose: the catalogs-list chip and the
 * workspace sync button both need "is a push in flight for catalog X", and
 * MovieListView is a lazily-loaded chunk, so component state does not survive
 * navigating between the two views. This is also exactly the `inFlight`
 * argument deriveStatus takes, and what the beforeunload guard reads.
 */
export const transfers = reactive<Record<string, TransferState>>({});

/** Mark a catalog as transferring and return a progress reporter + a finisher. */
export function beginTransfer(catalogId: string, phase: string) {
  transfers[catalogId] = { phase, done: 0, total: 0 };
  return {
    progress(done: number, total: number, nextPhase = phase) {
      const t = transfers[catalogId];
      if (t) { t.done = done; t.total = total; t.phase = nextPhase; }
    },
    end() {
      delete transfers[catalogId];
    },
  };
}

/** True while any catalog is transferring — the beforeunload guard's condition. */
export function anyTransferActive(): boolean {
  return Object.keys(transfers).length > 0;
}

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
  /** Push to the origin the source_ref locator points at (folder handle + name).
   *  `mtimeSec` is passed through so the caller's precomputed fingerprint and
   *  the uploaded file agree. */
  pushToLocator(
    storage: Storage,
    locator: string,
    bytes: Uint8Array,
    mtimeSec?: number,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<void>;
  /** Push to a user-chosen path; return the resulting full source_ref. */
  pushToPath(
    storage: Storage,
    path: string,
    fallbackName: string,
    bytes: Uint8Array,
    mtimeSec?: number,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<string>;
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

  async pushToLocator(storage, locator, bytes, mtimeSec, onProgress) {
    const { handle, name } = splitMegaLocator(locator);
    const folder = folderByHandle(storage, handle);
    if (!folder) throw new Error("the folder this library came from no longer exists on Mega");
    await replaceInFolder(storage, folder, name, bytes, mtimeSec, onProgress);
  },

  async pushToPath(storage, path, fallbackName, bytes, mtimeSec, onProgress) {
    const { segments, filename } = splitAmcPath(path);
    const name = filename ?? (fallbackName.toLowerCase().endsWith(".amc") ? fallbackName : `${fallbackName}.amc`);
    const folder = segments.length
      ? await ensureFolderAt(storage, segments)
      : (storage.root as unknown as MegaFile);
    await replaceInFolder(storage, folder, name, bytes, mtimeSec, onProgress);
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
  mtimeSec?: number,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<void> {
  const previous =
    (((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)) ?? null;
  const target = folder === (storage.root as unknown as MegaFile) ? storage : folder;
  await uploadToMega(target as Storage | MegaFile, name, bytes, mtimeSec, onProgress);
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
export async function pull(node0: MegaAmcFile, onProgress?: PullProgress): Promise<string> {
  if (!storage) throw new Error("Not connected");
  const connector = connectorFor(cloudSession.provider);
  const sourceRef = connector.sourceRefOf(node0.node);

  let bytes = sourceRef ? await getCachedAmc(sourceRef) : null;
  if (bytes) {
    onProgress?.(bytes.length, bytes.length, "download");
  } else {
    bytes = await connector.download(node0.node, (loaded, total) => onProgress?.(loaded, total, "download"));
    if (sourceRef) await putCachedAmc(sourceRef, bytes);
  }

  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const id = await importAmcFile(blob, {
    ...session(),
    onProgress,
    sourceRef,
    fallbackName: (node0.name ?? "").replace(/\.amc$/i, ""),
  });

  // Record the bookkeeping now, or a freshly imported catalog sits at "unknown"
  // despite provably matching the file it came from. The bytes are in hand, so
  // the content hash is free — which makes an immediately-following Sync a
  // no-op via the skip-if-unchanged path.
  if (sourceRef) {
    try {
      const meta = await cf.catalogInfo(id);
      const node = node0.node as unknown as { attributes?: { c?: string }; size?: number };
      await cf.setSyncState(id, {
        synced_rev: meta.content_rev,
        content_hash: await sha256Hex(bytes),
        remote_fingerprint: node.attributes?.c ?? "",
        remote_size: node.size ?? bytes.byteLength,
      });
    } catch {
      /* the catalog just reads "unknown" until the next check */
    }
  }

  if (sourceRef) await dropCachedAmc(sourceRef);
  disconnect(); // ephemeral: nothing needs to stay connected after an import
  return id;
}

/** Download a catalog's origin `.amc` and return its bytes, caching them so a
 *  following re-import costs nothing extra. Used by the conflict dialog's
 *  compare step. */
export async function downloadOriginBytes(
  catalog: CatalogRow,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  if (!catalog.source_ref) throw new Error("catalog has no cloud origin");
  const { provider, locator } = parseSourceRef(catalog.source_ref);
  const cached = await getCachedAmc(catalog.source_ref);
  if (cached) {
    onProgress?.(cached.length, cached.length);
    return cached;
  }
  await ensureConnected(provider);
  try {
    const { handle, name } = splitMegaLocator(locator);
    const folder = folderByHandle(storage!, handle);
    const node = folder
      ? ((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)
      : null;
    if (!node) throw new Error("the cloud file this library came from no longer exists");
    const bytes = await connectorFor(provider).download(node, onProgress);
    await putCachedAmc(catalog.source_ref, bytes);
    return bytes;
  } finally {
    disconnect();
  }
}

/**
 * Re-import a catalog from its cloud origin, replacing its contents in place.
 * Used when the .amc was edited externally.
 *
 * Rows are replaced wholesale — no per-movie merge. The format has no movie id,
 * and `number` is non-unique and user-editable (rule 12), so any merge key is a
 * heuristic that fails on exactly the edits people make (renames, renumbers).
 * Posters are what dedup saves, and content addressing makes that exact.
 *
 * `cachedBytes` lets the conflict dialog's "Compare with remote" download feed
 * straight into the re-import at no extra cost.
 */
export async function reimportFromOrigin(
  catalog: CatalogRow,
  onProgress?: PullProgress,
  cachedBytes?: Uint8Array,
): Promise<void> {
  if (!catalog.source_ref) throw new Error("catalog has no cloud origin");
  const { provider, locator } = parseSourceRef(catalog.source_ref);
  const connector = connectorFor(provider);
  await ensureConnected(provider);

  const tx = beginTransfer(catalog.id, "download");
  try {
    const { handle, name } = splitMegaLocator(locator);
    const folder = folderByHandle(storage!, handle);
    const node = folder
      ? ((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)
      : null;
    if (!node) throw new Error("the cloud file this library came from no longer exists");

    const bytes =
      cachedBytes ??
      (await connector.download(node, (loaded, total) => {
        tx.progress(loaded, total, "download");
        onProgress?.(loaded, total, "download");
      }));

    await importAmcFile(new Blob([bytes as BlobPart]), {
      ...session(),
      reimportInto: catalog.id,
      sourceRef: catalog.source_ref,
      fallbackName: (node.name ?? "").replace(/\.amc$/i, ""),
      onProgress: (done, total, phase) => {
        tx.progress(done, total, phase);
        onProgress?.(done, total, phase);
      },
    });

    // The DB now matches the file we just read, so record that rather than
    // leaving the catalog "changed externally".
    const meta = await cf.catalogInfo(catalog.id);
    await cf.setSyncState(catalog.id, {
      synced_rev: meta.content_rev,
      content_hash: await sha256Hex(bytes),
      remote_fingerprint: (node.attributes as { c?: string } | undefined)?.c ?? "",
      remote_size: node.size ?? bytes.byteLength,
    });

    // Drop any cached compare-download: a later compare should re-read the
    // real file, not a stale snapshot from before this resolve.
    if (catalog.source_ref) await dropCachedAmc(catalog.source_ref);

    // A re-import is the moment orphans appear in bulk: posters the previous
    // contents referenced and the new ones do not. Best-effort, so it never
    // fails the re-import.
    void cf.gcPosters(catalog.id);
  } finally {
    tx.end();
    disconnect();
  }
}

// --- export (push direction) -----------------------------------------------

/** Ensure a live session to `provider`: reuse the current one if it matches,
 *  else auto-connect; throw CloudLoginRequiredError if no credential is stored. */
async function ensureConnected(provider: string): Promise<void> {
  if (cloudSession.connected && cloudSession.provider === provider && storage) return;
  disconnect();
  if (!(await autoConnect(provider))) throw new CloudLoginRequiredError(provider);
}

/** Thrown when a push is refused because the remote moved. The caller opens the
 *  conflict dialog rather than overwriting anything. */
export class RemoteMovedError extends Error {
  constructor(public kind: "conflict" | "changed-externally") {
    super(
      kind === "conflict"
        ? "This library and the cloud file have both changed - resolve before syncing"
        : "The cloud file changed outside the app - re-import or resolve first",
    );
    this.name = "RemoteMovedError";
  }
}

/**
 * Push a catalog back to its cloud origin. The two properties that matter:
 *
 *  - `synced_rev` records the revision the BUNDLE was read at, never the
 *    current one. An edit made during a multi-minute upload must stay pending.
 *  - If the rebuilt bytes hash to the stored content_hash, nothing is uploaded.
 *    Covers a repeated Sync click and an edit-then-undo.
 */
export async function syncCatalogToOrigin(
  catalog: CatalogRow,
  onProgress?: PushProgress,
  opts: { force?: boolean } = {},
): Promise<{ uploaded: boolean }> {
  if (!catalog.source_ref) throw new Error("catalog has no cloud origin");

  // Refuse rather than overwrite — UNLESS the user chose "Push mine" in the
  // conflict dialog, which is the explicit click that makes it their decision.
  if (!opts.force) {
    const status = deriveStatus(catalog);
    if (status.kind === "conflict" || status.kind === "changed-externally") {
      throw new RemoteMovedError(status.kind);
    }
  }

  const { provider, locator } = parseSourceRef(catalog.source_ref);
  const connector = connectorFor(provider);
  await ensureConnected(provider);

  const tx = beginTransfer(catalog.id, "building");
  // wakelock.ts exports exactly one thing: withWakeLock(fn), a wrapper. So the
  // whole push body runs inside it rather than acquiring/releasing a handle.
  return withWakeLock(async () => {
    try {
      const { bytes, contentRev } = await buildAmcFile(catalog.id, {
        ...session(),
        onProgress: (done, total, phase) => {
          tx.progress(done, total, phase);
          onProgress?.(done, total, phase);
        },
      });

      const hash = await sha256Hex(bytes);
      let uploaded = false;
      let fingerprint = catalog.remote_fingerprint ?? "";

      if (canSkipUpload(catalog, hash)) {
        // Byte-identical to a remote we just confirmed is there. Skip the
        // upload; still advance synced_rev so the badge goes clean.
        tx.progress(1, 1, "unchanged");
        onProgress?.(1, 1, "unchanged");
      } else {
        tx.progress(0, bytes.byteLength, "uploading");
        onProgress?.(0, bytes.byteLength, "uploading");
        const mtimeSec = Math.floor(Date.now() / 1000);
        fingerprint = computeFingerprint(bytes, mtimeSec);
        await connector.pushToLocator(storage!, locator, bytes, mtimeSec, (up, total) => {
          tx.progress(up, total, "uploading");
          onProgress?.(up, total, "uploading");
        });
        uploaded = true;
      }

      await cf.setSyncState(catalog.id, {
        synced_rev: contentRev,
        content_hash: hash,
        remote_fingerprint: fingerprint,
        remote_size: bytes.byteLength,
      });

      // A forced push is the conflict dialog's "Push mine" — drop any cached
      // compare-download so a later compare re-reads the real file.
      if (opts.force && catalog.source_ref) await dropCachedAmc(catalog.source_ref);

      return { uploaded };
    } finally {
      tx.end();
      disconnect();
    }
  });
}

/** First push of a no-origin catalog: push to a chosen provider+path, write the
 *  resulting source_ref back to the catalog, and return it. Assumes a live
 *  session to `provider` already exists (the caller connected it). It is a
 *  first push, so the catalog should read `synced` afterwards. */
export async function pushAdoptingOrigin(
  catalog: CatalogRow,
  provider: string,
  path: string,
  onProgress?: PushProgress,
): Promise<string> {
  await ensureConnected(provider);
  const tx = beginTransfer(catalog.id, "building");
  try {
    const { bytes, contentRev } = await buildAmcFile(catalog.id, {
      ...session(),
      onProgress: (done, total, phase) => { tx.progress(done, total, phase); onProgress?.(done, total, phase); },
    });
    const mtimeSec = Math.floor(Date.now() / 1000);
    const fingerprint = computeFingerprint(bytes, mtimeSec);
    const fallbackName = catalog.name || "catalog";
    tx.progress(0, bytes.byteLength, "uploading");
    onProgress?.(0, bytes.byteLength, "uploading");
    const sourceRef = await connectorFor(provider).pushToPath(
      storage!, path, fallbackName, bytes, mtimeSec, (up, total) => {
        tx.progress(up, total, "uploading");
        onProgress?.(up, total, "uploading");
      },
    );
    await cf.setSyncState(catalog.id, {
      synced_rev: contentRev,
      content_hash: await sha256Hex(bytes),
      remote_fingerprint: fingerprint,
      remote_size: bytes.byteLength,
    });
    return sourceRef;
  } finally {
    tx.end();
    disconnect();
  }
}

// --- remote check pass -------------------------------------------------------

/** What one tree read concluded about one catalog. */
type RemoteVerdict = {
  id: string;
  state: "match" | "differs" | "missing";
  remote_fingerprint?: string | null;
  remote_size?: number | null;
};

/**
 * Compare every cloud-backed catalog against its remote file and record the
 * verdicts. NO DOWNLOAD: megajs decrypts the whole attribute object for each
 * tree node, so the `c` fingerprint and the size come straight off the account
 * tree. One login covers every catalog.
 *
 * Providers with no stored credential are skipped entirely — we never prompt
 * from here. Their catalogs keep whatever verdict they had, and the UI shows its
 * age.
 *
 * Best-effort: any failure leaves the affected catalogs' cached verdicts alone.
 */
export async function checkRemoteStates(catalogs: CatalogRow[]): Promise<void> {
  const byProvider = new Map<string, CatalogRow[]>();
  for (const c of catalogs) {
    if (!c.source_ref) continue;
    const { provider } = parseSourceRef(c.source_ref);
    const list = byProvider.get(provider) ?? [];
    list.push(c);
    byProvider.set(provider, list);
  }

  const verdicts: RemoteVerdict[] = [];

  for (const [provider, list] of byProvider) {
    if (!cloudSettings.providers[provider]?.hasCredential) continue;
    try {
      await ensureConnected(provider);
    } catch {
      continue; // no session, no verdict — the cached one stands
    }
    for (const c of list) {
      // Without a stored fingerprint there is nothing to compare against, so
      // record nothing rather than guess. The next push or pull supplies one.
      if (!c.remote_fingerprint) continue;
      try {
        const { locator } = parseSourceRef(c.source_ref!);
        const { handle, name } = splitMegaLocator(locator);
        const folder = folderByHandle(storage!, handle);
        const node = folder
          ? ((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)
          : null;
        if (!node) {
          verdicts.push({ id: c.id, state: "missing" });
          continue;
        }
        const remoteFp = (node.attributes as { c?: string } | undefined)?.c ?? "";
        const size = node.size ?? 0;
        // Compare the CONTENT half only, so a mtime-only touch is not a change.
        // Size is compared too: Mega's CRC samples ~8 KB across four lanes for
        // large files rather than hashing everything, so pairing it with the
        // length closes the theoretical gap.
        const same =
          !!remoteFp &&
          contentCrcOf(remoteFp) === contentCrcOf(c.remote_fingerprint) &&
          size === c.remote_size;
        verdicts.push({
          id: c.id,
          state: same ? "match" : "differs",
          remote_fingerprint: remoteFp || null,
          remote_size: size,
        });
      } catch {
        /* leave this catalog's cached verdict in place */
      }
    }
    disconnect(); // ephemeral: nothing stays connected after a check
  }

  if (verdicts.length) {
    try {
      await cf.setRemoteStates(verdicts);
    } catch {
      /* the badges just stay stale */
    }
  }
}
