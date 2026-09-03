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

  it("rejects on the first failure and stops starting new jobs", async () => {
    let started = 0;
    const jobs = Array.from({ length: 50 }, (_, i) => async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 1));
      if (i === 2) throw new Error("boom");
    });
    await expect(runPool(jobs, 2)).rejects.toThrow("boom");
    // With concurrency 2 and a failure at index 2, nowhere near all 50 may start.
    expect(started).toBeLessThan(50);
  });
});
