// Google Drive behind the CloudConnector seam (see connector.ts).
//
// Drive is plain REST over HTTPS with permissive CORS, so there is no SDK here
// and no proxying through the Worker: the browser already holds the whole .amc,
// and it talks to googleapis.com directly. `fetch` + the resumable upload
// protocol is the entire implementation.
//
// AUTH: Google Identity Services' token client, in the browser, exactly like
// Mega's login — the operator pastes an OAuth **client id** (public by design)
// and Google's popup does the rest. No client secret exists, so nothing about
// Drive needs a Worker secret, a new route, or a deploy step; the client id is
// what `remember me` stores in user_cloud (encrypted at rest like any other
// credential blob), and the grant itself lives in the user's Google session.
//
// ponytail: no refresh token, so a token request needs the Google session cookie
// (and, on a first grant, a user gesture). A reconnect from the background
// remote-check pass can therefore fail; cloud.ts already treats that as "no
// verdict" and leaves the cached one, and the user reconnects from the panel.
// Upgrade path if that gets annoying: an authorization-code exchange in the
// Worker (GOOGLE_CLIENT_SECRET) storing a refresh token instead of the id.
//
// SCOPE: the full `drive` scope. `drive.file` only ever sees files this app
// itself created or the user picked through Google's Picker, which cannot find
// the .amc the desktop Ant Movie Catalog put there — the whole point of the
// import path. Google calls `drive` restricted: fine for a single-operator
// self-deploy whose OAuth client stays in Testing with the operator as its test
// user; publishing one would need Google's verification.

import { isAmcName, splitAmcPath } from "../browser/cloudpath";
import { formatSourceRef, splitLocator } from "./cloudref";
import type {
  ByteProgress,
  CloudAmcFile,
  CloudConnector,
  CloudCredentials,
  RemoteStat,
} from "./connector";

const SCOPE = "https://www.googleapis.com/auth/drive";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Resumable-upload chunk. Google requires a multiple of 256 KiB. */
const CHUNK = 8 * 1024 * 1024;
/** Shared-drive files are listed/fetched too, not just My Drive. */
const ALL_DRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";
const FILE_FIELDS = "id,name,size,mimeType,md5Checksum,parents";

// --- Google Identity Services ----------------------------------------------

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(cfg?: { prompt?: string; hint?: string }): void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
}
declare global {
  interface Window {
    google?: Gis;
  }
}

let gisLoading: Promise<Gis> | null = null;

/** Load the GIS script once per page. */
function loadGis(): Promise<Gis> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  gisLoading ??= new Promise<Gis>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS_SRC;
    el.async = true;
    el.onload = () => {
      const g = window.google;
      if (g?.accounts?.oauth2) resolve(g);
      else reject(new Error("Google sign-in loaded but is unavailable"));
    };
    el.onerror = () => {
      gisLoading = null; // let a later attempt retry
      reject(new Error("could not load Google sign-in (offline, or blocked)"));
    };
    document.head.appendChild(el);
  });
  return gisLoading;
}

/** Promise-shaped access-token request. `prompt: ""` asks Google not to show a
 *  consent screen when the grant already exists. */
type RequestToken = (prompt?: "" | "consent") => Promise<string>;

async function makeTokenSource(clientId: string, hint?: string): Promise<RequestToken> {
  const gis = await loadGis();
  let pending: { resolve(t: string): void; reject(e: Error): void } | null = null;
  const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
    const p = pending;
    pending = null;
    if (p) fn(p);
  };
  const client = gis.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (r) =>
      settle((p) =>
        r.access_token
          ? p.resolve(r.access_token)
          : p.reject(new Error(r.error_description || r.error || "Google sign-in was cancelled")),
      ),
    error_callback: (e) =>
      settle((p) => p.reject(new Error(e?.message || "Google sign-in failed"))),
  });
  return (prompt = "") =>
    new Promise<string>((resolve, reject) => {
      if (pending) return reject(new Error("a Google sign-in is already in progress"));
      pending = { resolve, reject };
      client.requestAccessToken({ prompt, hint });
    });
}

// --- session + request helper ----------------------------------------------

interface DriveSession {
  token: string;
  request: RequestToken;
}

const asSession = (s: unknown) => s as DriveSession;

/**
 * One Drive request. Retries ONCE on 401 with a fresh token: an access token
 * lives about an hour and a poster-heavy catalog can take longer than that to
 * upload, so expiry mid-transfer is expected rather than exceptional.
 */
async function api(s: DriveSession, url: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` } });
  let res = await send();
  if (res.status === 401) {
    s.token = await s.request("");
    res = await send();
  }
  if (!res.ok) throw new DriveError(await driveError(res), res.status);
  return res;
}

/** Carries the HTTP status, because 404 ("gone") is not the same answer as a
 *  transient failure — see resolveLocator. */
class DriveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DriveError";
  }
}

/** Google's error bodies are JSON with a human message; fall back to the status. */
async function driveError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (msg) return `Google Drive: ${msg}`;
  } catch {
    /* not JSON */
  }
  return `Google Drive: ${res.status} ${res.statusText}`;
}

/** Escape a value for a Drive `q` search string (single quotes and backslashes). */
function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// --- file listing / resolution ---------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  mimeType?: string;
  md5Checksum?: string;
  parents?: string[];
}

/** Wrap a Drive resource as an opaque CloudAmcFile. */
function toFile(f: DriveFile, parentId: string): CloudAmcFile {
  return {
    name: f.name,
    size: Number(f.size ?? 0),
    // Drive omits md5Checksum for its own native doc types; a .amc is binary, so
    // it is always present. "" then means "unknown", which sameContent refuses
    // to call a match — the safe direction (SYNC.md).
    fingerprint: f.md5Checksum ?? "",
    node: { id: f.id, parentId: f.parents?.[0] ?? parentId },
  };
}

const nodeOf = (f: CloudAmcFile) => f.node as { id: string; parentId: string };

/** Every child of `parentId`, following Drive's pagination. */
async function listChildren(s: DriveSession, parentId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const url =
      `${API}/files?${ALL_DRIVES}&pageSize=1000` +
      `&q=${encodeURIComponent(`'${q(parentId)}' in parents and trashed=false`)}` +
      `&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const page = (await (await api(s, url)).json()) as {
      files?: DriveFile[];
      nextPageToken?: string;
    };
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

const isFolder = (f: DriveFile) => f.mimeType === FOLDER_MIME;

/** The single child of `parentId` named `name`, or null. */
async function childNamed(
  s: DriveSession,
  parentId: string,
  name: string,
  folder: boolean,
): Promise<DriveFile | null> {
  const clause =
    `'${q(parentId)}' in parents and name='${q(name)}' and trashed=false and ` +
    `mimeType${folder ? "=" : "!="}'${FOLDER_MIME}'`;
  const url =
    `${API}/files?${ALL_DRIVES}&pageSize=1` +
    `&q=${encodeURIComponent(clause)}` +
    `&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`;
  const page = (await (await api(s, url)).json()) as { files?: DriveFile[] };
  return page.files?.[0] ?? null;
}

/** Walk existing folders; null if any segment is missing. "root" = My Drive. */
async function folderIdAt(s: DriveSession, segments: string[]): Promise<string | null> {
  let id = "root";
  for (const seg of segments) {
    const hit = await childNamed(s, id, seg, true);
    if (!hit) return null;
    id = hit.id;
  }
  return id;
}

/** Like folderIdAt, but creates any missing folder along the way. */
async function ensureFolderIdAt(s: DriveSession, segments: string[]): Promise<string> {
  let id = "root";
  for (const seg of segments) {
    const hit = await childNamed(s, id, seg, true);
    if (hit) {
      id = hit.id;
      continue;
    }
    const created = (await (
      await api(s, `${API}/files?${ALL_DRIVES}&fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: seg, mimeType: FOLDER_MIME, parents: [id] }),
      })
    ).json()) as { id: string };
    id = created.id;
  }
  return id;
}

/** `.amc` files under `parentId`, recursing when `deep`. */
async function collectAmc(
  s: DriveSession,
  parentId: string,
  deep: boolean,
): Promise<CloudAmcFile[]> {
  const children = await listChildren(s, parentId);
  const out = children.filter((f) => !isFolder(f) && isAmcName(f.name)).map((f) => toFile(f, parentId));
  if (deep) {
    for (const folder of children.filter(isFolder)) {
      out.push(...(await collectAmc(s, folder.id, true)));
    }
  }
  return out;
}

// --- transfers -------------------------------------------------------------

async function download(
  s: DriveSession,
  fileId: string,
  declaredSize: number,
  onProgress?: ByteProgress,
): Promise<Uint8Array> {
  const res = await api(s, `${API}/files/${encodeURIComponent(fileId)}?alt=media&${ALL_DRIVES}`);
  const total = Number(res.headers.get("content-length") ?? 0) || declaredSize;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  // Preallocate to the known size and clamp writes, so peak memory is 1× the
  // file (matters on a phone) — same shape as the Mega download path.
  const buf = total > 0 ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (buf) {
      const c = loaded + value.length > total ? value.subarray(0, total - loaded) : value;
      buf.set(c, loaded);
      loaded += c.length;
    } else {
      chunks.push(value);
      loaded += value.length;
    }
    onProgress?.(loaded, total || loaded);
  }
  if (buf) return loaded === total ? buf : buf.subarray(0, loaded);
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}

/**
 * Resumable upload, chunked so a multi-hundred-megabyte .amc reports progress —
 * `fetch` cannot report progress on a single request body, and a silent upload
 * is exactly what the UI must not do.
 *
 * `fileId` given = overwrite that file in place (its id, share links and
 * comments survive); otherwise create `name` inside `parentId`.
 *
 * ponytail: no per-chunk retry. A dropped chunk fails the push and the user
 * presses Sync again — which is safe, because a push is idempotent. Resuming a
 * broken upload (query the session URI for its committed range) is the upgrade.
 */
async function upload(
  s: DriveSession,
  bytes: Uint8Array,
  target: { fileId?: string; parentId?: string; name: string },
  onProgress?: ByteProgress,
): Promise<RemoteStat> {
  const fields = encodeURIComponent("id,name,size,md5Checksum");
  const url = target.fileId
    ? `${UPLOAD_API}/files/${encodeURIComponent(target.fileId)}?uploadType=resumable&${ALL_DRIVES}&fields=${fields}`
    : `${UPLOAD_API}/files?uploadType=resumable&${ALL_DRIVES}&fields=${fields}`;
  // On an update Drive rejects `parents` in the metadata; on a create it needs it.
  const metadata = target.fileId
    ? { name: target.name }
    : { name: target.name, parents: [target.parentId ?? "root"] };

  const start = await api(s, url, {
    method: target.fileId ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(bytes.byteLength),
    },
    body: JSON.stringify(metadata),
  });
  const sessionUri = start.headers.get("location");
  if (!sessionUri) throw new Error("Google Drive did not return an upload session");

  onProgress?.(0, bytes.byteLength);
  // A zero-length body still needs one PUT, so this loop runs at least once.
  let offset = 0;
  for (;;) {
    const end = Math.min(offset + CHUNK, bytes.byteLength);
    const chunk = bytes.subarray(offset, end);
    // The session URI carries its own credentials, and a 401 here means the
    // session died rather than the token — so this PUT does not go through
    // api()'s retry.
    const res = await fetch(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${offset}-${Math.max(end - 1, 0)}/${bytes.byteLength}`,
      },
      body: chunk as BodyInit,
    });
    if (res.status === 200 || res.status === 201) {
      const done = (await res.json()) as DriveFile;
      onProgress?.(bytes.byteLength, bytes.byteLength);
      return { fingerprint: done.md5Checksum ?? "", size: Number(done.size ?? bytes.byteLength) };
    }
    // 308 = "resume incomplete": Drive reports what it actually committed, which
    // may be less than we sent, so continue from its Range rather than our end.
    if (res.status !== 308) throw new DriveError(await driveError(res), res.status);
    const range = res.headers.get("range"); // "bytes=0-8388607"
    const committed = range ? Number(range.split("-")[1]) + 1 : end;
    offset = Number.isFinite(committed) ? committed : end;
    onProgress?.(offset, bytes.byteLength);
    if (offset >= bytes.byteLength) {
      throw new Error("Google Drive accepted every byte but never finished the upload");
    }
  }
}

// --- the connector ---------------------------------------------------------

export const driveConnector: CloudConnector = {
  label: "Google Drive",
  auth: "oauth",
  oauthFields: [
    {
      key: "clientId",
      label: "OAuth client ID",
      hint:
        "Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID " +
        "(type: Web application), enable the Google Drive API, and add {origin} to the " +
        "client's Authorized JavaScript origins. Paste the client ID here — it is public, " +
        "there is no client secret to keep.",
    },
  ],

  async login(creds: CloudCredentials) {
    const clientId = (creds.clientId ?? "").trim();
    if (!clientId) throw new Error("a Google OAuth client ID is required");
    const request = await makeTokenSource(clientId, creds.email);
    const session: DriveSession = { token: await request(""), request };
    const about = (await (
      await api(session, `${API}/about?fields=${encodeURIComponent("user(emailAddress)")}`)
    ).json()) as { user?: { emailAddress?: string } };
    return { session, email: about.user?.emailAddress ?? "" };
  },

  async listAmc(session, path, deep) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const folderId = await folderIdAt(s, segments);
    if (!folderId) return [];
    if (filename) {
      const hit = await childNamed(s, folderId, filename, false);
      return hit ? [toFile(hit, folderId)] : [];
    }
    return collectAmc(s, folderId, deep);
  },

  sourceRefOf(file) {
    const { parentId } = nodeOf(file);
    return parentId && file.name ? formatSourceRef("drive", parentId, file.name) : null;
  },

  async resolveLocator(session, locator) {
    const s = asSession(session);
    const { handle, name } = splitLocator(locator);
    if (!handle || !name) return null;
    // A 404 means the folder itself is gone, which IS "the remote file is
    // missing". Anything else (offline, 5xx, a revoked token) must propagate:
    // cloud.ts then keeps the catalog's previous verdict rather than reporting a
    // file that is actually still there as deleted.
    let hit: DriveFile | null;
    try {
      hit = await childNamed(s, handle, name, false);
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null;
      throw e;
    }
    return hit ? toFile(hit, handle) : null;
  },

  // md5Checksum is a hash of the content and nothing else, so unlike Mega's
  // fingerprint there is no mtime half to strip. Size is compared as a cheap
  // second opinion.
  sameContent(a, b) {
    return !!a.fingerprint && !!b.fingerprint && a.fingerprint === b.fingerprint && a.size === b.size;
  },

  download(session, file, onProgress) {
    const { id } = nodeOf(file);
    return download(asSession(session), id, file.size, onProgress);
  },

  async pushToLocator(session, locator, bytes, onProgress) {
    const s = asSession(session);
    const { handle, name } = splitLocator(locator);
    const existing = await childNamed(s, handle, name, false);
    return upload(
      s,
      bytes,
      existing ? { fileId: existing.id, name } : { parentId: handle, name },
      onProgress,
    );
  },

  async pushToPath(session, path, fallbackName, bytes, onProgress) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const name = filename ?? (isAmcName(fallbackName) ? fallbackName : `${fallbackName}.amc`);
    const parentId = await ensureFolderIdAt(s, segments);
    const existing = await childNamed(s, parentId, name, false);
    const stat = await upload(
      s,
      bytes,
      existing ? { fileId: existing.id, name } : { parentId, name },
      onProgress,
    );
    return { sourceRef: formatSourceRef("drive", parentId, name), stat };
  },
};
