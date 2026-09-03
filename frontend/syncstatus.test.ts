import { describe, it, expect } from "vitest";
import { deriveStatus, SHOWS_SYNC_BUTTON, type SyncStatus } from "./syncstatus";
import type { CatalogRow } from "./api";

function cat(over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id: "c1", tenant_id: "t1", version: 42, name: "Films", mail: "", site: "",
    description: "", cfp_column_settings: "", cfp_gui_properties: "",
    text_encoding: "utf-8", source_ref: "mega:folder:films.amc",
    created_at: 0, updated_at: 0,
    content_rev: 0, synced_rev: 0, content_hash: null,
    remote_fingerprint: null, remote_size: null,
    remote_state: "match", remote_checked_at: 1000, last_sync_at: 900,
    ...over,
  } as CatalogRow;
}

describe("deriveStatus", () => {
  it("is local-only without a source_ref, whatever the revs say", () => {
    expect(deriveStatus(cat({ source_ref: null, content_rev: 5, synced_rev: 1 })).kind)
      .toBe("local-only");
  });

  it("is syncing while a transfer is in flight", () => {
    const s = deriveStatus(cat({ content_rev: 3, synced_rev: 1 }), {
      phase: "posters", done: 2, total: 9,
    });
    expect(s).toEqual({ kind: "syncing", phase: "posters", done: 2, total: 9 });
  });

  it("local-only beats syncing (nothing to sync to)", () => {
    expect(deriveStatus(cat({ source_ref: null }), { phase: "x", done: 0, total: 1 }).kind)
      .toBe("local-only");
  });

  it("is unknown when the remote was never checked, and reports the local half", () => {
    expect(deriveStatus(cat({ remote_checked_at: null, content_rev: 4, synced_rev: 1 })))
      .toEqual({ kind: "unknown", localDirty: true, pending: 3 });
    expect(deriveStatus(cat({ remote_checked_at: null, content_rev: 1, synced_rev: 1 })))
      .toEqual({ kind: "unknown", localDirty: false, pending: 0 });
  });

  it("is remote-gone when the node is missing", () => {
    expect(deriveStatus(cat({ remote_state: "missing" })).kind).toBe("remote-gone");
  });

  it("is synced when revs match and the remote matches", () => {
    expect(deriveStatus(cat({ content_rev: 7, synced_rev: 7, last_sync_at: 42 })))
      .toEqual({ kind: "synced", at: 42 });
  });

  it("is not-synced when revs differ but the remote still matches", () => {
    expect(deriveStatus(cat({ content_rev: 9, synced_rev: 4 })))
      .toEqual({ kind: "not-synced", pending: 5 });
  });

  it("is changed-externally when revs match but the remote differs", () => {
    expect(deriveStatus(cat({ content_rev: 4, synced_rev: 4, remote_state: "differs" })).kind)
      .toBe("changed-externally");
  });

  it("is conflict when both sides moved", () => {
    expect(deriveStatus(cat({ content_rev: 6, synced_rev: 4, remote_state: "differs" })))
      .toEqual({ kind: "conflict", pending: 2 });
  });
});

describe("SHOWS_SYNC_BUTTON", () => {
  // The workspace button must appear exactly when there are local changes to
  // push. This pins that invariant instead of trusting the component.
  const cases: Array<{ row: Partial<CatalogRow>; inFlight?: { phase: string; done: number; total: number } }> = [
    { row: { content_rev: 2, synced_rev: 1 } },
    { row: { content_rev: 2, synced_rev: 1 }, inFlight: { phase: "rows", done: 1, total: 2 } },
    { row: { content_rev: 2, synced_rev: 1, remote_state: "differs" } },
    { row: { content_rev: 1, synced_rev: 1 } },
    { row: { content_rev: 1, synced_rev: 1, remote_state: "differs" } },
    { row: { content_rev: 1, synced_rev: 1, remote_state: "missing" } },
    { row: { remote_checked_at: null, content_rev: 3, synced_rev: 1 } },
    { row: { source_ref: null, content_rev: 3, synced_rev: 1 } },
  ];

  it("appears only for kinds whose revs diverge", () => {
    for (const c of cases) {
      const row = cat(c.row);
      const status = deriveStatus(row, c.inFlight);
      const shows = SHOWS_SYNC_BUTTON.has(status.kind);
      const diverged = row.content_rev !== row.synced_rev;
      // A shown button always means real pending work. A hidden one may still
      // have diverged revs (unknown, local-only), which is deliberate.
      if (shows) expect(diverged).toBe(true);
    }
  });

  it("covers exactly not-synced, syncing and conflict", () => {
    expect([...SHOWS_SYNC_BUTTON].sort()).toEqual(["conflict", "not-synced", "syncing"]);
  });
});
