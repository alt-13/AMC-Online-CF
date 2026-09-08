// Microsoft OneDrive behind the CloudConnector seam (see connector.ts).
//
// Microsoft Graph is plain REST with permissive CORS, so — like Drive — there is
// no SDK here and the Worker never proxies a byte: the browser already holds the
// whole .amc and talks to graph.microsoft.com directly.
//
// AUTH: the OAuth **authorization code flow with PKCE** in a popup
// (`oauthpkce.ts`), instead of @azure/msal-browser — a couple hundred KB of
// bundle for a string that flow returns. No client secret exists (Microsoft
// mandates PKCE for SPA-registered redirect URIs and issues none), so the
// **Application (client) ID** the operator pastes is all that `remember me`
// stores in user_cloud.
//
// `offline_access` is what makes the grant return a refresh token, so a
// reconnect — including the one the background remote-check pass needs, where
// there is no user gesture to open a popup with — is silent. Microsoft's SPA
// refresh tokens are SINGLE-USE and expire 24 h after issue, so every refresh
// rotates them and the replacement must be persisted (oauthpkce.ts does that
// through `onCredentials`); leave the app alone for a day and the popup returns.
//
// SCOPE: `Files.ReadWrite` (the signed-in user's own OneDrive) + `User.Read` for
// the account's email in the UI. Not `.All` — nothing here touches other
// people's or shared drives, and the `.amc` the desktop Ant Movie Catalog wrote
// sits in the user's own OneDrive.

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

const SCOPE = "Files.ReadWrite User.Read offline_access";
/** `common` = work/school AND personal Microsoft accounts. */
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DRIVE = `${GRAPH}/me/drive`;
/** Upload chunk. Graph requires a multiple of 320 KiB; this is 9.375 MiB. */
const CHUNK = 320 * 1024 * 30;

// --- auth (PKCE in a popup, see oauthpkce.ts) --------------------------------

const pkceOptions = (clientId: string, login?: string): PkceOptions => ({
  label: "Microsoft",
  authorizeUrl: `${AUTHORITY}/authorize`,
  tokenUrl: `${AUTHORITY}/token`,
  clientId,
  scope: SCOPE,
  authParams: { response_mode: "fragment", ...(login ? { login_hint: login } : {}) },
});

// --- session + request helper ----------------------------------------------

type OneDriveSession = OAuthSession;

const asSession = (s: unknown) => s as OneDriveSession;

/** Carries the HTTP status: 404 ("gone") is not the same answer as a transient
 *  failure — see resolveLocator. */
class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GraphError";
  }
}

/** Graph error bodies are `{error:{code,message}}`; fall back to the status. */
async function graphError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (msg) return `OneDrive: ${msg}`;
  } catch {
    /* not JSON */
  }
  return `OneDrive: ${res.status} ${res.statusText}`;
}

/**
 * One Graph request. Retries ONCE on 401 with a fresh token: an access token
 * lives about an hour and a poster-heavy catalog can take longer than that to
 * push. (Chunk PUTs don't come through here — an upload session URL is
 * pre-authenticated, so the long part of a push needs no token at all.)
 */
async function api(s: OneDriveSession, url: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` } });
  let res = await send();
  if (res.status === 401) {
    s.token = await s.request();
    res = await send();
  }
  if (!res.ok) throw new GraphError(await graphError(res), res.status);
  return res;
}

/** Null on 404 ("it isn't there"), rethrowing anything else. */
async function optional(p: Promise<Response>): Promise<Response | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return null;
    throw e;
  }
}

// --- file listing / resolution ---------------------------------------------

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  file?: { hashes?: Record<string, string> };
  parentReference?: { id?: string };
  "@microsoft.graph.downloadUrl"?: string;
}

const isFolder = (i: DriveItem) => !!i.folder;

/** OneDrive reports quickXorHash (business) or sha256/sha1 (personal); which
 *  one is per-account and stable, so any of them serves as the fingerprint. ""
 *  means "unknown", which sameContent refuses to call a match (SYNC.md). */
function statOf(i: DriveItem): RemoteStat {
  const h = i.file?.hashes ?? {};
  return {
    fingerprint: h.quickXorHash ?? h.sha256Hash ?? h.sha1Hash ?? "",
    size: Number(i.size ?? 0),
  };
}

function toFile(i: DriveItem, parentId: string): CloudAmcFile {
  return {
    ...statOf(i),
    name: i.name,
    node: { id: i.id, parentId: i.parentReference?.id ?? parentId },
  };
}

const nodeOf = (f: CloudAmcFile) => f.node as { id: string; parentId: string };

/** Graph path addressing: `/items/{id}:/{name}`. `suffix` closes the path when
 *  something follows the name (`:/{name}:/createUploadSession`). */
const childUrl = (parentId: string, name: string, suffix = "") =>
  `${DRIVE}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}` +
  (suffix ? `:${suffix}` : "");

/** The child of `parentId` named `name`, or null (wrong kind counts as absent). */
async function childNamed(
  s: OneDriveSession,
  parentId: string,
  name: string,
  folder: boolean,
): Promise<DriveItem | null> {
  const res = await optional(api(s, childUrl(parentId, name)));
  if (!res) return null;
  const item = (await res.json()) as DriveItem;
  return isFolder(item) === folder ? item : null;
}

/** Resolve a whole folder chain in one request; null if a segment is missing. */
async function folderAt(s: OneDriveSession, segments: string[]): Promise<DriveItem | null> {
  const url = segments.length
    ? `${DRIVE}/root:/${segments.map(encodeURIComponent).join("/")}`
    : `${DRIVE}/root`;
  const res = await optional(api(s, url));
  return res ? ((await res.json()) as DriveItem) : null;
}

/** Like folderAt, but creates any missing folder along the way. */
async function ensureFolderAt(s: OneDriveSession, segments: string[]): Promise<string> {
  let id = ((await (await api(s, `${DRIVE}/root`)).json()) as DriveItem).id;
  for (const seg of segments) {
    const hit = await childNamed(s, id, seg, true);
    if (hit) {
      id = hit.id;
      continue;
    }
    const created = (await (
      await api(s, `${DRIVE}/items/${encodeURIComponent(id)}/children`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: seg,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      })
    ).json()) as DriveItem;
    id = created.id;
  }
  return id;
}

/** Every child of `parentId`, following Graph's pagination. */
async function listChildren(s: OneDriveSession, parentId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let url = `${DRIVE}/items/${encodeURIComponent(parentId)}/children?$top=200`;
  while (url) {
    const page = (await (await api(s, url)).json()) as {
      value?: DriveItem[];
      "@odata.nextLink"?: string;
    };
    out.push(...(page.value ?? []));
    url = page["@odata.nextLink"] ?? "";
  }
  return out;
}

/** `.amc` files under `parentId`, recursing when `deep`. */
async function collectAmc(
  s: OneDriveSession,
  parentId: string,
  deep: boolean,
): Promise<CloudAmcFile[]> {
  const children = await listChildren(s, parentId);
  const out = children
    .filter((i) => !isFolder(i) && isAmcName(i.name))
    .map((i) => toFile(i, parentId));
  if (deep) {
    for (const folder of children.filter(isFolder)) {
      out.push(...(await collectAmc(s, folder.id, true)));
    }
  }
  return out;
}

// --- transfers -------------------------------------------------------------

/**
 * Resumable upload session, chunked so a multi-hundred-megabyte .amc reports
 * progress — `fetch` cannot report progress on a single request body.
 *
 * Addressed by parent + name with `conflictBehavior: replace`, so an existing
 * file is overwritten IN PLACE: its item id, share links and version history
 * survive.
 *
 * ponytail: no per-chunk retry. A dropped chunk fails the push and the user
 * presses Sync again — safe, because a push is idempotent. Resuming a broken
 * upload (GET the session URL for its committed ranges) is the upgrade.
 */
async function upload(
  s: OneDriveSession,
  parentId: string,
  name: string,
  bytes: Uint8Array,
  onProgress?: ByteProgress,
): Promise<RemoteStat> {
  const started = (await (
    await api(s, childUrl(parentId, name, "/createUploadSession"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    })
  ).json()) as { uploadUrl?: string };
  if (!started.uploadUrl) throw new Error("OneDrive did not return an upload session");

  onProgress?.(0, bytes.byteLength);
  let offset = 0;
  for (;;) {
    const end = Math.min(offset + CHUNK, bytes.byteLength);
    // The session URL carries its own credentials, so this PUT does not go
    // through api()'s 401 retry — a 401 here means the session died.
    const res = await fetch(started.uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${offset}-${end - 1}/${bytes.byteLength}` },
      body: bytes.subarray(offset, end) as BodyInit,
    });
    if (res.status === 200 || res.status === 201) {
      onProgress?.(bytes.byteLength, bytes.byteLength);
      const item = (await res.json()) as DriveItem;
      const stat = statOf(item);
      if (stat.fingerprint) return { ...stat, size: stat.size || bytes.byteLength };
      // Graph can answer before it has hashed the new content; one re-read
      // usually has it, and "" (unknown) is a safe fallback either way.
      const fresh = await optional(
        api(s, `${DRIVE}/items/${encodeURIComponent(item.id)}`),
      ).catch(() => null);
      const after = fresh ? statOf((await fresh.json()) as DriveItem) : stat;
      return { ...after, size: after.size || bytes.byteLength };
    }
    if (res.status !== 202) throw new GraphError(await graphError(res), res.status);
    // 202 = "keep going": Graph reports what it actually committed as
    // nextExpectedRanges ("9830400-"), which may be less than we sent.
    const next = (await res.json().catch(() => ({}))) as { nextExpectedRanges?: string[] };
    const committed = Number(next.nextExpectedRanges?.[0]?.split("-")[0]);
    offset = Number.isFinite(committed) ? committed : end;
    onProgress?.(offset, bytes.byteLength);
    if (offset >= bytes.byteLength) {
      throw new Error("OneDrive accepted every byte but never finished the upload");
    }
  }
}

// --- the connector ---------------------------------------------------------

export const onedriveConnector: CloudConnector = {
  label: "OneDrive",
  auth: "oauth",
  oauthFields: [
    {
      key: "clientId",
      label: "Application (client) ID",
      hint:
        "Microsoft Entra admin center → App registrations → New registration, " +
        "supported account types: any organization + personal Microsoft accounts, " +
        "then add {origin}/ as a redirect URI of platform type Single-page application. " +
        "Paste the Application (client) ID here — it is public, there is no secret.",
    },
  ],

  async login(creds: CloudCredentials, onCredentials) {
    const clientId = (creds.clientId ?? "").trim();
    if (!clientId) throw new Error("a Microsoft Application (client) ID is required");
    const session = await oauthConnect(pkceOptions(clientId, creds.email), creds, onCredentials);
    const me = (await (await api(session, `${GRAPH}/me`)).json()) as {
      mail?: string;
      userPrincipalName?: string;
    };
    return { session, email: me.mail ?? me.userPrincipalName ?? "" };
  },

  async listAmc(session, path, deep) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const folder = await folderAt(s, segments);
    if (!folder) return [];
    if (filename) {
      const hit = await childNamed(s, folder.id, filename, false);
      return hit ? [toFile(hit, folder.id)] : [];
    }
    return collectAmc(s, folder.id, deep);
  },

  sourceRefOf(file) {
    const { parentId } = nodeOf(file);
    return parentId && file.name ? formatSourceRef("onedrive", parentId, file.name) : null;
  },

  async resolveLocator(session, locator) {
    const s = asSession(session);
    const { handle, name } = splitLocator(locator);
    if (!handle || !name) return null;
    // A 404 IS "the remote file is missing" (childNamed maps it to null).
    // Anything else — offline, 5xx, a revoked grant — propagates: cloud.ts then
    // keeps the catalog's previous verdict rather than reporting a file that is
    // still there as deleted.
    const hit = await childNamed(s, handle, name, false);
    return hit ? toFile(hit, handle) : null;
  },

  // The hash covers content and nothing else, so there is no mtime half to
  // strip (unlike Mega). Size is a cheap second opinion.
  sameContent(a, b) {
    return (
      !!a.fingerprint && !!b.fingerprint && a.fingerprint === b.fingerprint && a.size === b.size
    );
  },

  async download(session, file, onProgress) {
    const s = asSession(session);
    const { id } = nodeOf(file);
    // The pre-authenticated download URL is fetched WITHOUT the Authorization
    // header — it lives on a storage host that rejects one.
    const item = (await (
      await api(s, `${DRIVE}/items/${encodeURIComponent(id)}`)
    ).json()) as DriveItem;
    const url = item["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("OneDrive gave no download URL for this file");
    return streamToBytes(await fetch(url), file.size, onProgress);
  },

  pushToLocator(session, locator, bytes, onProgress) {
    const { handle, name } = splitLocator(locator);
    return upload(asSession(session), handle, name, bytes, onProgress);
  },

  async pushToPath(session, path, fallbackName, bytes, onProgress) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const name = filename ?? (isAmcName(fallbackName) ? fallbackName : `${fallbackName}.amc`);
    const parentId = await ensureFolderAt(s, segments);
    const stat = await upload(s, parentId, name, bytes, onProgress);
    return { sourceRef: formatSourceRef("onedrive", parentId, name), stat };
  },
};
