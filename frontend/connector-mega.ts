// Mega.nz behind the CloudConnector seam (see connector.ts).
//
// Everything megajs-shaped stays in here: the Storage session, MegaFile nodes,
// folder handles, and the `c` fingerprint attribute. cloud.ts sees none of it.

import { Storage, File as MegaFile } from "megajs";
import { isAmcName, splitAmcPath } from "../browser/cloudpath";
import {
  loginToMega,
  uploadToMega,
  downloadFromMega,
  ensureFolderAt,
  folderByHandle,
  listAmcFiles,
  resolveAmcFile,
} from "../browser/mega";
import { computeFingerprint, contentCrcOf } from "../browser/mega-fingerprint";
import { formatSourceRef, splitLocator } from "./cloudref";
import type {
  ByteProgress,
  CloudAmcFile,
  CloudConnector,
  CloudCredentials,
  RemoteStat,
} from "./connector";

// megajs's MutableFile (the node type with .delete) isn't exported; we only need
// .delete here.
type Deletable = { delete(permanent: boolean): Promise<unknown> };

const asStorage = (s: unknown) => s as Storage;
const asNode = (f: CloudAmcFile) => f.node as MegaFile;

/** Wrap a megajs node as an opaque CloudAmcFile. */
function toFile(node: MegaFile): CloudAmcFile {
  return {
    name: node.name ?? "",
    size: node.size ?? 0,
    fingerprint: (node.attributes as { c?: string } | undefined)?.c ?? "",
    node,
  };
}

/** The file named `name` directly inside the folder with handle `handle`. */
function fileInFolder(storage: Storage, handle: string, name: string): MegaFile | null {
  const folder = folderByHandle(storage, handle);
  if (!folder) return null;
  return (
    ((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name) ?? null
  );
}

export const megaConnector: CloudConnector = {
  label: "Mega.nz",
  auth: "password",

  async login(creds: CloudCredentials) {
    const email = creds.email ?? "";
    const session = await loginToMega({ email, password: creds.password ?? "" });
    return { session, email };
  },

  async listAmc(session, path, deep) {
    const storage = asStorage(session);
    const { filename } = splitAmcPath(path);
    if (filename) {
      const node = resolveAmcFile(storage, path);
      return node ? [toFile(node)] : [];
    }
    return listAmcFiles(storage, path, deep).map(toFile);
  },

  sourceRefOf(file) {
    const node = asNode(file);
    const parent = node.parent?.nodeId;
    return parent && file.name ? formatSourceRef("mega", parent, file.name) : null;
  },

  async resolveLocator(session, locator) {
    const { handle, name } = splitLocator(locator);
    const node = fileInFolder(asStorage(session), handle, name);
    return node ? toFile(node) : null;
  },

  // Compare the CONTENT half only, so a mtime-only touch is not a change. Size
  // is compared too: Mega's CRC samples ~8 KB across four lanes for large files
  // rather than hashing everything, so pairing it with the length closes the
  // theoretical gap.
  sameContent(a, b) {
    return (
      !!a.fingerprint &&
      !!b.fingerprint &&
      contentCrcOf(a.fingerprint) === contentCrcOf(b.fingerprint) &&
      a.size === b.size
    );
  },

  // A megajs node carries its own decryption keys, so the session is unused
  // here — the seam passes it because a REST provider needs its bearer token.
  async download(_session, file, onProgress) {
    const { bytes } = await downloadFromMega(asNode(file), onProgress);
    return bytes;
  },

  async pushToLocator(session, locator, bytes, onProgress) {
    const storage = asStorage(session);
    const { handle, name } = splitLocator(locator);
    const folder = folderByHandle(storage, handle);
    if (!folder) throw new Error("the folder this library came from no longer exists on Mega");
    return replaceInFolder(storage, folder, name, bytes, onProgress);
  },

  async pushToPath(session, path, fallbackName, bytes, onProgress) {
    const storage = asStorage(session);
    const { segments, filename } = splitAmcPath(path);
    const name =
      filename ??
      (isAmcName(fallbackName) ? fallbackName : `${fallbackName}.amc`);
    const folder = segments.length
      ? await ensureFolderAt(storage, segments)
      : (storage.root as unknown as MegaFile);
    const stat = await replaceInFolder(storage, folder, name, bytes, onProgress);
    const handle = folder.nodeId ?? storage.root?.nodeId ?? "";
    return { sourceRef: formatSourceRef("mega", handle, name), stat };
  },
};

/** Upload `bytes` as `name` into `folder`, replacing any existing same-named file
 *  only AFTER the new upload succeeds (a failed delete never fails the push). */
async function replaceInFolder(
  storage: Storage,
  folder: MegaFile,
  name: string,
  bytes: Uint8Array,
  onProgress?: ByteProgress,
): Promise<RemoteStat> {
  const previous =
    (((folder.children ?? []) as MegaFile[]).find((f) => !f.directory && f.name === name)) ?? null;
  const target = folder === (storage.root as unknown as MegaFile) ? storage : folder;
  // The fingerprint must be computed over the same mtime the upload records, so
  // both come from this one `mtimeSec`.
  const mtimeSec = Math.floor(Date.now() / 1000);
  await uploadToMega(target as Storage | MegaFile, name, bytes, mtimeSec, onProgress);
  if (previous) {
    try {
      await (previous as unknown as Deletable).delete(true);
    } catch {
      /* leave the stale copy in place */
    }
  }
  return { fingerprint: computeFingerprint(bytes, mtimeSec), size: bytes.byteLength };
}
