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
 * failure; once a job throws, no worker — the one that failed or any sibling
 * — starts another job. `onProgress` fires once per completed job with a
 * monotonic done count.
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
  let failed = false;

  async function worker(): Promise<void> {
    // Reading and incrementing `next` is atomic here: JS is single-threaded, so
    // no two workers can observe the same index.
    //
    // `failed` is the shared abort signal. Without it a sibling worker keeps
    // pulling jobs after another has already rejected — which for an import
    // means poster PUTs keep landing after the rollback has swept R2, leaving
    // exactly the orphans the rollback exists to prevent.
    while (next < jobs.length && !failed) {
      const job = jobs[next++];
      try {
        await job();
      } catch (e) {
        failed = true;
        throw e;
      }
      onProgress?.(++done, total);
    }
  }

  // Promise.all rejects on the first failure.
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
}
