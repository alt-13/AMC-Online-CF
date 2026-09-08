// The provider seam: what a cloud backend must implement, and the registry
// cloud.ts looks providers up in.
//
// cloud.ts owns the WORKFLOW (connect, cache, import, build, push, record sync
// state) and knows nothing about any provider. Everything provider-specific —
// how a session is opened, how a path is resolved, what "same file" and "same
// content" mean, how bytes move — lives behind this interface. Adding a backend
// is one new `connector-*.ts` plus one line in CONNECTORS.
//
// Three rules keep it plug-in-able:
//
//  - Sessions and nodes are OPAQUE. A connector hands back `CloudAmcFile`s
//    carrying whatever it needs in `node`; cloud.ts only ever reads
//    `name`/`size`/`fingerprint` and passes the file straight back. No caller
//    outside the connector may reach into `node` or `session`.
//  - Fingerprints are opaque too, and only `sameContent` compares them. Mega's
//    fingerprint packs a content CRC next to an mtime (so a byte comparison
//    would report a mtime-only touch as a change), Drive's is a plain MD5 — the
//    connector knows which, cloud.ts must not.
//  - A push RETURNS the resulting fingerprint. It is the connector that knows
//    what the provider stored, so it is the connector that reports it.
//
// The connector modules import these types with `import type`, so the cycle
// back to this file is erased at build time.

import { driveConnector } from "./connector-drive";
import { dropboxConnector } from "./connector-dropbox";
import { megaConnector } from "./connector-mega";
import { onedriveConnector } from "./connector-onedrive";

/** Provider-specific login blob. Stored (encrypted) as JSON in user_cloud. */
export type CloudCredentials = Record<string, string>;

/** The remote file's comparable identity. Both halves are opaque to cloud.ts. */
export interface RemoteStat {
  /** provider-specific content fingerprint ("" = the provider gave none) */
  fingerprint: string;
  size: number;
}

/** One `.amc` on a provider. `node` is the connector's own handle for it. */
export interface CloudAmcFile extends RemoteStat {
  name: string;
  node: unknown;
}

export type ByteProgress = (done: number, total: number) => void;

export interface CloudConnector {
  /** Label for the provider switcher. */
  readonly label: string;
  /**
   * What the connect form must collect:
   *  - "password": email + password fields (Mega).
   *  - "oauth":    a provider popup; `oauthFields` names any extra input the
   *                operator must supply first (Drive's client id + secret).
   *                `secret` renders a masked field.
   */
  readonly auth: "password" | "oauth";
  readonly oauthFields?: ReadonlyArray<{
    key: string;
    label: string;
    hint?: string;
    secret?: boolean;
  }>;

  /**
   * Open a session. Returns it plus the account identity to show in the UI.
   *
   * `onCredentials` is present only when the user asked to be kept signed in: a
   * connector that learns something worth reusing (an OAuth refresh token — and
   * Microsoft rotates its on every use) mutates `creds` and reports it, and
   * cloud.ts re-encrypts the blob. Called at most once per token renewal, which
   * can happen mid-transfer, not only at login.
   */
  login(
    creds: CloudCredentials,
    onCredentials?: (creds: CloudCredentials) => void,
  ): Promise<{ session: unknown; email: string }>;

  /** `.amc` files at `path` ("" = account root); `deep` recurses subfolders. */
  listAmc(session: unknown, path: string, deep: boolean): Promise<CloudAmcFile[]>;

  /** Stable `<provider>:<locator>` origin key for a file, or null if incomplete. */
  sourceRefOf(file: CloudAmcFile): string | null;

  /** Resolve a source_ref locator back to the file; null if it is gone. */
  resolveLocator(session: unknown, locator: string): Promise<CloudAmcFile | null>;

  /** Same CONTENT? (An mtime-only touch must not count as a change.) */
  sameContent(a: RemoteStat, b: RemoteStat): boolean;

  download(session: unknown, file: CloudAmcFile, onProgress?: ByteProgress): Promise<Uint8Array>;

  /** Overwrite the file a locator points at. */
  pushToLocator(
    session: unknown,
    locator: string,
    bytes: Uint8Array,
    onProgress?: ByteProgress,
  ): Promise<RemoteStat>;

  /** Push to a user-chosen path, creating folders as needed. */
  pushToPath(
    session: unknown,
    path: string,
    fallbackName: string,
    bytes: Uint8Array,
    onProgress?: ByteProgress,
  ): Promise<{ sourceRef: string; stat: RemoteStat }>;
}

const CONNECTORS: Record<string, CloudConnector> = {
  mega: megaConnector,
  drive: driveConnector,
  onedrive: onedriveConnector,
  dropbox: dropboxConnector,
};

export function connectorFor(provider: string): CloudConnector {
  const c = CONNECTORS[provider];
  if (!c) throw new Error(`unknown cloud provider "${provider}"`);
  return c;
}

/** The provider's display name, falling back to its key for an unknown one —
 *  this is used in user-facing text, so it must never throw. */
export function providerLabel(provider: string): string {
  return CONNECTORS[provider]?.label ?? provider;
}

/** Pickable providers, in switcher order. */
export function providerList(): Array<{ value: string; label: string }> {
  return Object.entries(CONNECTORS).map(([value, c]) => ({ value, label: c.label }));
}
