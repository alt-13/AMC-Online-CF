// Bounded-concurrency task pool.
//
// Import and export both issue one HTTP request per poster, which is thousands
// of round-trips on a real catalog. Running them serially means the transfer is
// pure latency (see the design doc's measurements); running them all at once
// overwhelms a phone connection. A small pool of workers draining a shared
// queue is the middle ground, and both directions use this one implementation.

/** A unit of work. Takes no arguments so the caller closes over what it needs. */
export type Job = () => Promise<void>;

export type PoolProgress = (done: number, total: number) => void;

/**
 * Run `jobs` with at most `concurrency` in flight. Rejects with the first
 * failure; workers that are mid-flight settle, but no further job is started.
 * `onProgress` fires once per completed job with a monotonic done count.
 */
export async function runPool(
  jobs: Job[],
  concurrency: number,
  onProgress?: PoolProgress,
): Promise<void> {
  const total = jobs.length;
  if (!total) return;

  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    // Reading and incrementing `next` is atomic here: JS is single-threaded, so
    // no two workers can observe the same index.
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
      onProgress?.(++done, total);
    }
  }

  // Promise.all rejects on the first failure. The remaining workers stop pulling
  // once their current job settles, because the rejection propagates out of the
  // await above and breaks their loop.
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
}
