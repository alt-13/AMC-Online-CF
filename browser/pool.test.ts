import { describe, it, expect } from "vitest";
import { runPool } from "./pool";

/** A job that resolves after `ms`, recording peak concurrency in `state`. */
function tracked(state: { live: number; peak: number }, ms = 0) {
  return async () => {
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    await new Promise((r) => setTimeout(r, ms));
    state.live -= 1;
  };
}

describe("runPool", () => {
  it("runs at most `concurrency` jobs at once", async () => {
    const state = { live: 0, peak: 0 };
    const jobs = Array.from({ length: 20 }, () => tracked(state, 5));
    await runPool(jobs, 4);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1); // it really did overlap
  });

  it("resolves immediately for an empty job list and never reports progress", async () => {
    let progressed = false;
    await runPool([], 4, () => { progressed = true; });
    expect(progressed).toBe(false);
  });

  it("reports a monotonically increasing done count ending at the total", async () => {
    const seen: number[] = [];
    const jobs = Array.from({ length: 6 }, () => async () => {});
    await runPool(jobs, 3, (done, total) => {
      expect(total).toBe(6);
      seen.push(done);
    });
    expect(seen).toHaveLength(6);
    expect(seen).toEqual([...seen].sort((a, z) => a - z));
    expect(seen[seen.length - 1]).toBe(6);
  });

  it("stops starting new jobs after a failure", async () => {
    let started = 0;
    const jobs = Array.from({ length: 50 }, (_, i) => async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 1));
      if (i === 2) throw new Error("boom");
    });
    await expect(runPool(jobs, 2)).rejects.toThrow("boom");
    const atReject = started;
    // Give any surviving worker ample time to keep pulling. A pool that truly
    // stops starts nothing more; the previous implementation marched toward 50.
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(atReject);
  });

  it("waits for every in-flight job to settle before rejecting", async () => {
    // One job fails quickly; its siblings are already in flight and take much
    // longer. A pool that rejects as soon as the first failure is observed
    // (plain Promise.all) returns control to the caller while those siblings
    // are still running — which for uploadPosters means poster PUTs can land
    // in R2 after importAmcFile's /api/import/abort has already swept the
    // catalog prefix. This test asserts nothing is still running by the time
    // the rejection reaches the caller.
    const state = { live: 0 };
    let liveAtCatch = -1;
    const jobs = Array.from({ length: 5 }, (_, i) => async () => {
      state.live += 1;
      try {
        if (i === 0) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("boom");
        }
        await new Promise((r) => setTimeout(r, 40));
      } finally {
        state.live -= 1;
      }
    });

    let threw = false;
    try {
      await runPool(jobs, 5);
    } catch {
      threw = true;
      liveAtCatch = state.live;
    }
    expect(threw).toBe(true);
    expect(liveAtCatch).toBe(0);
  });

  it("throws for concurrency <= 0 instead of silently running nothing", async () => {
    let ran = false;
    const jobs = [async () => { ran = true; }];
    await expect(runPool(jobs, 0)).rejects.toThrow(/concurrency/i);
    expect(ran).toBe(false);
    await expect(runPool(jobs, -1)).rejects.toThrow(/concurrency/i);
    expect(ran).toBe(false);
  });
});
