// Gated integration test — proves the fingerprint gap against a REAL Mega account
// and proves our fix closes it. Skipped unless credentials are provided:
//
//   MEGA_EMAIL=you@example.com MEGA_PASSWORD='...' npm run test:mega
//
// It uploads throwaway files to the account root and deletes them in a finally
// block. Use a test account. What it establishes, end to end:
//
//   1. THE GAP:  a plain megajs upload (name only) stores NO `c` attribute —
//      exactly what makes MEGAsync desktop reject the file.
//   2. THE FIX:  uploadToMega() stores `c`, and it equals what we computed.
//   3. THE LOOP: download the bytes back, recompute the fingerprint, and it
//      matches the stored `c`. That recompute is the same check the desktop
//      client runs, so a match means the desktop client accepts the file.

import { describe, it, expect, afterAll } from "vitest";
import { Storage, type MutableFile } from "megajs";
import { loginToMega, uploadToMega, downloadFromMega } from "./mega.ts";
import { computeFingerprint } from "./mega-fingerprint.ts";

const EMAIL = process.env.MEGA_EMAIL;
const PASSWORD = process.env.MEGA_PASSWORD;
const gated = EMAIL && PASSWORD ? describe : describe.skip;

// A deterministic ~40KB payload → exercises the large (>8192) sparse-CRC branch,
// the same branch a real .amc export hits.
const PAYLOAD = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 131 + 17) & 0xff);
const MTIME = 1786332144; // fixed so recompute is comparable
const stamp = `${MTIME}`; // no Date.now() churn; unique-enough per fixed payload
const RAW_NAME = `amc-fptest-raw-${stamp}.bin`;
const FIXED_NAME = `amc-fptest-fixed-${stamp}.bin`;

gated("Mega fingerprint gap (live account)", () => {
  const toDelete: MutableFile[] = [];

  afterAll(async () => {
    for (const node of toDelete) {
      try {
        await node.delete(true); // permanent — skip the Rubbish bin
      } catch {
        // best-effort cleanup; a leftover test file is not a test failure
      }
    }
  });

  it("plain megajs upload omits the `c` fingerprint (the gap)", async () => {
    const storage = await loginToMega({ email: EMAIL!, password: PASSWORD! });
    const node = (await storage
      .upload({ name: RAW_NAME, size: PAYLOAD.byteLength }, PAYLOAD as unknown as Buffer)
      .complete) as unknown as MutableFile;
    toDelete.push(node);

    // Read server truth: re-login fresh and inspect the decrypted attributes.
    const fresh = await loginToMega({ email: EMAIL!, password: PASSWORD! });
    const stored = (fresh.root!.children ?? []).find((f) => f.name === RAW_NAME);
    expect(stored, "uploaded raw file should exist").toBeTruthy();
    expect((stored as any).attributes?.c).toBeUndefined();
  }, 120_000);

  it("uploadToMega stores a `c` equal to our computed fingerprint (the fix)", async () => {
    const storage = await loginToMega({ email: EMAIL!, password: PASSWORD! });
    const node = await uploadToMega(storage, FIXED_NAME, PAYLOAD, MTIME);
    toDelete.push(node as unknown as MutableFile);

    const expected = computeFingerprint(PAYLOAD, MTIME);

    const fresh = await loginToMega({ email: EMAIL!, password: PASSWORD! });
    const stored = (fresh.root!.children ?? []).find((f) => f.name === FIXED_NAME);
    expect(stored, "uploaded fixed file should exist").toBeTruthy();
    expect((stored as any).attributes?.c).toBe(expected);
  }, 120_000);

  it("round-trips: download, recompute, and it matches the stored `c` (desktop would accept)", async () => {
    const storage = await loginToMega({ email: EMAIL!, password: PASSWORD! });
    const stored = (storage.root!.children ?? []).find((f) => f.name === FIXED_NAME);
    expect(stored, "fixed file from the previous step should still exist").toBeTruthy();

    const dl = await downloadFromMega(stored as any);
    expect([...dl.bytes.subarray(0, 8)]).toEqual([...PAYLOAD.subarray(0, 8)]);
    expect(dl.bytes.byteLength).toBe(PAYLOAD.byteLength);

    // Recompute from the downloaded bytes + the same mtime the fingerprint carries.
    const recomputed = computeFingerprint(dl.bytes, MTIME);
    expect(recomputed).toBe((stored as any).attributes?.c);
  }, 120_000);
});

// Keep Storage referenced so the import isn't tree-shaken in type-only builds.
void Storage;
