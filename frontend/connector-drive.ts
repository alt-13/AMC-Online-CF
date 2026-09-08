// Google Drive behind the CloudConnector seam (see connector.ts).
//
// Drive is plain REST over HTTPS with permissive CORS, so there is no SDK here
// and no proxying through the Worker: the browser already holds the whole .amc,
// and it talks to googleapis.com directly. `fetch` + the resumable upload
// protocol is the entire implementation.
//
// AUTH: the same OAuth **code flow with PKCE** popup as OneDrive and Dropbox
// (`oauthpkce.ts`), NOT Google Identity Services. GIS' token client hands out
// one-hour access tokens and no refresh token, so every reconnect needed a live
// Google session and a user gesture — which the background remote-check pass
// does not have. `access_type=offline` on the code flow does return a refresh
// token, so a reconnect is silent, and dropping GIS drops its script tag too.
//
// Google is the one provider that ALSO needs a client **secret**: its token
// endpoint refuses a Web-application client without one, whatever PKCE says. It
// is the operator's own secret for their own deploy, pasted once and stored
// exactly like the Mega password already is — encrypted at rest in user_cloud,
// decrypted only into this browser. Still no Worker secret, route or deploy step.
//
// SCOPE: the full `drive` scope. `drive.file` only ever sees files this app
// itself created or the user picked through Google's Picker, which cannot find
// the .amc the desktop Ant Movie Catalog put there — the whole point of the
// import path. Google calls `drive` restricted: fine for a single-operator
// self-deploy whose OAuth client stays in Testing with the operator as its test
// user; publishing one would need Google's verification.

import { isAmcName, splitAmcPath } from "../browser/cloudpath";
import { oauthConnect, type OAuthSession, type PkceOptions } from "./oauthpkce";
import { streamToBytes } from "./cloudstream";
import { formatSourceRef, splitLocator } from "./cloudref";
import type {
  ByteProgress,
  CloudAmcFile,
  CloudConnector,
  CloudCredentials,
  RemoteStat,
} from "./connector";

const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Resumable-upload chunk. Google requires a multiple of 256 KiB. */
const CHUNK = 8 * 1024 * 1024;
/** Shared-drive files are listed/fetched too, not just My Drive. */
const ALL_DRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";
const FILE_FIELDS = "id,name,size,mimeType,md5Checksum,parents";

// --- auth (PKCE in a popup, see oauthpkce.ts) --------------------------------

const pkceOptions = (clientId: string, clientSecret: string, login?: string): PkceOptions => ({
  label: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId,
  clientSecret,
  scope: SCOPE,
  authParams: {
    // offline = issue a refresh token; consent = issue a NEW one even though
    // this account has granted the scope before (Google omits it otherwise, and
    // we only run the interactive flow when the stored one is gone).
    access_type: "offline",
    prompt: "consent",
    ...(login ? { login_hint: login } : {}),
  },
});

// --- session + request helper ----------------------------------------------

type DriveSession = OAuthSession;

const asSession = (s: unknown) => s as DriveSession;

/**
 * One Drive request. Retries ONCE on 401 with a fresh token: an access token
 * lives about an hour and a poster-heavy catalog can take longer than that to
 * upload, so expiry mid-transfer is expected rather than exceptional. The
 * renewal is a refresh grant, so it is silent (see oauthpkce.ts).
 */
async function api(s: DriveSession, url: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` } });
  let res = await send();
  if (res.status === 401) {
    s.token = await s.request();
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
  return streamToBytes(res, declaredSize, onProgress);
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
        "(type: Web application), enable the Google Drive API, and add {origin}/ to the " +
        "client's Authorized redirect URIs.",
    },
    {
      key: "clientSecret",
      label: "Client secret",
      secret: true,
      hint:
        "From the same OAuth client. Google's token endpoint requires it even with " +
        "PKCE. Stored encrypted on your own server (like a Mega password) and used " +
        "only by this browser; rotate it in the Console if you ever need to.",
    },
  ],

  async login(creds: CloudCredentials, onCredentials) {
    const clientId = (creds.clientId ?? "").trim();
    const clientSecret = (creds.clientSecret ?? "").trim();
    if (!clientId) throw new Error("a Google OAuth client ID is required");
    if (!clientSecret) throw new Error("a Google OAuth client secret is required");
    const session = await oauthConnect(
      pkceOptions(clientId, clientSecret, creds.email),
      creds,
      onCredentials,
    );
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
