// Dropbox behind the CloudConnector seam (see connector.ts).
//
// The Dropbox HTTP API is plain REST with permissive CORS, so — like Drive and
// OneDrive — there is no SDK here and the Worker never proxies a byte: the
// browser already holds the whole .amc and talks to dropboxapi.com directly.
//
// AUTH: the OAuth **authorization code flow with PKCE** in a popup
// (`oauthpkce.ts`), instead of the dropbox JS SDK. Dropbox issues no secret to
// a PKCE app, so the **App key** the operator pastes plus the refresh token the
// grant returns are all that `remember me` stores in user_cloud.
//
// `token_access_type=offline` is what makes that refresh token exist, so a
// reconnect — including the one the background remote-check pass needs, where
// there is no user gesture to open a popup with — is silent. Dropbox's refresh
// tokens are long-lived and do NOT rotate; the popup comes back only if the user
// revokes the app.
//
// SCOPE: metadata + content read/write on the user's own Dropbox, plus
// `account_info.read` for the email shown in the UI.
//
// TWO THINGS DIFFER FROM THE OTHER REST CONNECTORS:
//
//  - Dropbox is PATH-addressed, not id-addressed, so a locator's folder handle
//    is the parent PATH ("" at the root) rather than a folder id. Renaming the
//    remote folder therefore breaks the link and the catalog reads as
//    remote-gone; the user re-picks it. Ids exist (`id:AAA…`) but carry a colon,
//    which the "<handle>:<name>" locator grammar splits on.
//  - Endpoint-specific failures are **HTTP 409**, not 404 — see dbxError.

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

const SCOPE = "account_info.read files.metadata.read files.content.read files.content.write";
const RPC = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** Upload chunk. Any size is legal for a sequential session; this is progress
 *  granularity, not an API constraint. */
const CHUNK = 8 * 1024 * 1024;

const pkceOptions = (appKey: string): PkceOptions => ({
  label: "Dropbox",
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
  tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  clientId: appKey,
  scope: SCOPE,
  // Without this Dropbox issues a short-lived token and no refresh token.
  authParams: { token_access_type: "offline" },
});

// --- session + request helpers ----------------------------------------------

type DropboxSession = OAuthSession;

const asSession = (s: unknown) => s as DropboxSession;

/** Carries the status AND Dropbox's `error_summary`: "the file is not there" is
 *  a 409 whose summary names the route's own error, not a 404. */
class DropboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly summary: string,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

async function dbxError(res: Response): Promise<DropboxError> {
  const body = await res.text().catch(() => "");
  let summary = "";
  try {
    summary = (JSON.parse(body) as { error_summary?: string }).error_summary ?? "";
  } catch {
    /* not JSON — Dropbox sends plain text for 5xx and 429 */
  }
  const detail = summary || body.trim().slice(0, 200) || `${res.status} ${res.statusText}`;
  return new DropboxError(`Dropbox: ${detail}`, res.status, summary);
}

/**
 * `Dropbox-API-Arg` travels in an HTTP header, which is ASCII-only — a path with
 * an umlaut in it must be \u-escaped or the request is rejected outright. (This
 * app's whole reason for existing is catalogs full of them.)
 */
const apiArg = (arg: unknown) =>
  JSON.stringify(arg).replace(
    /[\x7f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** One request, retried ONCE on 401 with a fresh token: an access token expires
 *  and a poster-heavy catalog can take a long time to push. The renewal is a
 *  refresh grant, so it is silent (see oauthpkce.ts). */
async function send(s: DropboxSession, url: string, init: RequestInit): Promise<Response> {
  const go = () =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${s.token}` } });
  let res = await go();
  if (res.status === 401) {
    s.token = await s.request();
    res = await go();
  }
  if (!res.ok) throw await dbxError(res);
  return res;
}

/** An RPC call: JSON in, JSON out. `null` is the no-argument body Dropbox wants. */
async function rpc<T>(s: DropboxSession, route: string, arg: unknown): Promise<T> {
  const res = await send(s, `${RPC}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(arg ?? null),
  });
  return (await res.json().catch(() => ({}))) as T;
}

/** A content call: the argument rides in a header, the body is bytes. */
const content = (s: DropboxSession, route: string, arg: unknown, body?: Uint8Array) =>
  send(s, `${CONTENT}${route}`, {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": apiArg(arg),
      ...(body ? { "Content-Type": "application/octet-stream" } : {}),
    },
    ...(body ? { body: body as BodyInit } : {}),
  });

/** Null when Dropbox says the path isn't there, rethrowing anything else — a
 *  5xx or a revoked grant must NOT read as "the remote file is gone". */
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof DropboxError && e.status === 409 && e.summary.includes("not_found")) {
      return null;
    }
    throw e;
  }
}

// --- paths and metadata -----------------------------------------------------

interface Entry {
  ".tag"?: string;
  id?: string;
  name: string;
  size?: number;
  content_hash?: string;
  path_lower?: string;
}

const isFolder = (e: Entry) => e[".tag"] === "folder";

/** "" is the root; anything else starts with "/" and has no trailing slash. */
const folderPath = (segments: string[]) => (segments.length ? `/${segments.join("/")}` : "");

const joinPath = (folder: string, name: string) => `${folder}/${name}`;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** content_hash is Dropbox's own content digest — no mtime half to strip. "" =
 *  unknown, which sameContent refuses to call a match (SYNC.md). */
const statOf = (e: Entry): RemoteStat => ({
  fingerprint: e.content_hash ?? "",
  size: Number(e.size ?? 0),
});

const toFile = (e: Entry): CloudAmcFile => ({
  ...statOf(e),
  name: e.name,
  node: { path: e.path_lower ?? "" },
});

const nodeOf = (f: CloudAmcFile) => f.node as { path: string };

/** The file at `path`, or null if it isn't there / is a folder. */
async function fileAt(s: DropboxSession, path: string): Promise<Entry | null> {
  const e = await optional(rpc<Entry>(s, "/files/get_metadata", { path }));
  return e && !isFolder(e) ? e : null;
}

/** Every entry under `path` ("" = root), following Dropbox's cursor. */
async function listEntries(s: DropboxSession, path: string, recursive: boolean): Promise<Entry[]> {
  let page = await rpc<{ entries?: Entry[]; cursor?: string; has_more?: boolean }>(
    s,
    "/files/list_folder",
    { path, recursive, limit: 2000 },
  );
  const out = [...(page.entries ?? [])];
  while (page.has_more && page.cursor) {
    page = await rpc(s, "/files/list_folder/continue", { cursor: page.cursor });
    out.push(...(page.entries ?? []));
  }
  return out;
}

// --- transfers --------------------------------------------------------------

/**
 * Upload through a session, always — /files/upload caps at 150 MB, and chunking
 * is what lets a multi-hundred-megabyte .amc report progress (`fetch` cannot
 * report progress on a single request body).
 *
 * `mode: overwrite` replaces the file IN PLACE, so its id, share links and
 * revision history survive. Missing parent folders are created by Dropbox as
 * part of the commit, so there is no mkdir walk here.
 *
 * ponytail: no per-chunk retry. A dropped chunk fails the push and the user
 * presses Sync again — safe, because a push is idempotent. Resuming a broken
 * session is the upgrade.
 */
async function upload(
  s: DropboxSession,
  path: string,
  bytes: Uint8Array,
  onProgress?: ByteProgress,
): Promise<{ entry: Entry; stat: RemoteStat }> {
  const total = bytes.byteLength;
  onProgress?.(0, total);

  const first = bytes.subarray(0, Math.min(CHUNK, total));
  const started = (await (
    await content(s, "/files/upload_session/start", { close: false }, first)
  ).json()) as { session_id?: string };
  if (!started.session_id) throw new Error("Dropbox did not return an upload session");

  let offset = first.byteLength;
  onProgress?.(offset, total);
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    await content(
      s,
      "/files/upload_session/append_v2",
      { cursor: { session_id: started.session_id, offset }, close: false },
      bytes.subarray(offset, end),
    );
    offset = end;
    onProgress?.(offset, total);
  }

  const entry = (await (
    await content(s, "/files/upload_session/finish", {
      cursor: { session_id: started.session_id, offset },
      commit: { path, mode: "overwrite", autorename: false, mute: true },
    })
  ).json()) as Entry;
  const stat = statOf(entry);
  return { entry, stat: { ...stat, size: stat.size || total } };
}

// --- the connector ----------------------------------------------------------

export const dropboxConnector: CloudConnector = {
  label: "Dropbox",
  auth: "oauth",
  oauthFields: [
    {
      key: "clientId",
      label: "App key",
      hint:
        "dropbox.com/developers/apps → Create app → Scoped access, Full Dropbox. " +
        "Add {origin}/ under Redirect URIs, and tick account_info.read, " +
        "files.metadata.read, files.content.read and files.content.write on the " +
        "Permissions tab. Paste the App key here — it is public, there is no secret.",
    },
  ],

  async login(creds: CloudCredentials, onCredentials) {
    const appKey = (creds.clientId ?? "").trim();
    if (!appKey) throw new Error("a Dropbox App key is required");
    const session = await oauthConnect(pkceOptions(appKey), creds, onCredentials);
    const me = await rpc<{ email?: string }>(session, "/users/get_current_account", null);
    return { session, email: me.email ?? "" };
  },

  async listAmc(session, path, deep) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const folder = folderPath(segments);
    if (filename) {
      const hit = await fileAt(s, joinPath(folder, filename));
      return hit ? [toFile(hit)] : [];
    }
    const entries = await optional(listEntries(s, folder, deep));
    return (entries ?? []).filter((e) => !isFolder(e) && isAmcName(e.name)).map(toFile);
  },

  sourceRefOf(file) {
    const { path } = nodeOf(file);
    // The handle is the parent path, which is "" for a file at the root — so
    // only the name is required to resolve it again (see resolveLocator).
    return path && file.name ? formatSourceRef("dropbox", parentOf(path), file.name) : null;
  },

  async resolveLocator(session, locator) {
    const { handle, name } = splitLocator(locator);
    if (!name) return null;
    const hit = await fileAt(asSession(session), joinPath(handle, name));
    return hit ? toFile(hit) : null;
  },

  // The hash covers content and nothing else, so there is no mtime half to
  // strip (unlike Mega). Size is a cheap second opinion.
  sameContent(a, b) {
    return (
      !!a.fingerprint && !!b.fingerprint && a.fingerprint === b.fingerprint && a.size === b.size
    );
  },

  async download(session, file, onProgress) {
    const res = await content(asSession(session), "/files/download", {
      path: nodeOf(file).path,
    });
    return streamToBytes(res, file.size, onProgress);
  },

  async pushToLocator(session, locator, bytes, onProgress) {
    const { handle, name } = splitLocator(locator);
    const { stat } = await upload(asSession(session), joinPath(handle, name), bytes, onProgress);
    return stat;
  },

  async pushToPath(session, path, fallbackName, bytes, onProgress) {
    const s = asSession(session);
    const { segments, filename } = splitAmcPath(path);
    const name = filename ?? (isAmcName(fallbackName) ? fallbackName : `${fallbackName}.amc`);
    const target = joinPath(folderPath(segments), name);
    const { entry, stat } = await upload(s, target, bytes, onProgress);
    // Dropbox lowercases paths; take the parent it actually committed to.
    const parent = parentOf(entry.path_lower ?? target);
    return { sourceRef: formatSourceRef("dropbox", parent, name), stat };
  },
};
