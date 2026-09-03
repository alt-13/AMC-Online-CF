// Sync status derivation — PURE. No DOM, no fetch, no megajs.
//
// Its only dependency is CatalogRow, so it is trivially unit-testable, and both
// UI surfaces (the catalogs list chip and the workspace sync button) read the
// same function rather than each re-deriving state. Mirrors the cloudref.ts
// pattern.
//
// The guiding asymmetry: a false "changed externally" is SAFE (it prompts a
// re-import, which is idempotent), a false "synced" is not (it loses data). So
// every ambiguity resolves away from "synced".

import type { CatalogRow } from "./api";

/** A transfer currently running for a catalog. */
export interface TransferState {
  phase: string;
  done: number;
  total: number;
}

export type SyncStatus =
  /** No cloud origin — never pushed anywhere, so there is nothing to compare. */
  | { kind: "local-only" }
  /** A push or pull is running right now. */
  | { kind: "syncing"; phase: string; done: number; total: number }
  /** The remote has never been checked (no credential, or not checked yet). */
  | { kind: "unknown"; localDirty: boolean; pending: number }
  /** The remote file is gone (deleted, or its folder handle no longer resolves). */
  | { kind: "remote-gone" }
  /** DB and .amc agree. */
  | { kind: "synced"; at: number }
  /** Local edits are pending; the remote is still the file we pushed. */
  | { kind: "not-synced"; pending: number }
  /** No local edits, but the .amc changed underneath us. */
  | { kind: "changed-externally" }
  /** Both sides moved. Needs an explicit user choice. */
  | { kind: "conflict"; pending: number };

/** Kinds for which the workspace shows its one-click sync button. Every one of
 *  these has content_rev !== synced_rev, so the button's presence always means
 *  real pending work. `changed-externally` is deliberately absent: revs are
 *  equal there, so there is nothing to push and a sync button would be a lie. */
export const SHOWS_SYNC_BUTTON: ReadonlySet<SyncStatus["kind"]> = new Set([
  "not-synced",
  "syncing",
  "conflict",
] as const);

export function deriveStatus(cat: CatalogRow, inFlight?: TransferState): SyncStatus {
  // Order matters. Each check below assumes the ones above it did not fire.
  if (!cat.source_ref) return { kind: "local-only" };
  if (inFlight) {
    return { kind: "syncing", phase: inFlight.phase, done: inFlight.done, total: inFlight.total };
  }

  const pending = Math.max(0, cat.content_rev - cat.synced_rev);

  // Never checked: report the local half only. Claiming "synced" here would be
  // the one unsafe guess.
  if (cat.remote_checked_at == null) {
    return { kind: "unknown", localDirty: pending > 0, pending };
  }
  if (cat.remote_state === "missing") return { kind: "remote-gone" };
  if (cat.remote_state === "differs") {
    return pending > 0 ? { kind: "conflict", pending } : { kind: "changed-externally" };
  }
  if (cat.remote_state === "match") {
    return pending > 0
      ? { kind: "not-synced", pending }
      : { kind: "synced", at: cat.last_sync_at ?? 0 };
  }
  // Unrecognized remote_state. remote_state is a plain TEXT column, so nothing
  // stops a future writer storing something new here — and the one thing this
  // module must never do is guess "synced". Fall back to unknown, which prompts
  // a re-check rather than asserting the cloud file is current.
  return { kind: "unknown", localDirty: pending > 0, pending };
}
