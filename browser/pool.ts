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
 * Run `jobs` with at most `concurrency` in flight. On failure: no further job
 * is STARTED (the one that failed or any sibling), every already-running job
 * is AWAITED to completion regardless, and then the first error is rethrown.
 * Callers that roll back on failure (importAmcFile's /api/import/abort sweeps
 * the R2 prefix) depend on that ordering — control must not return to them
 * while a poster PUT is still in flight, or the sweep can miss it and leave
 * an orphaned object. `onProgress` fires once per completed job with a
 * monotonic done count.
 */
export async function runPool(
  jobs: Job[],
  concurrency: number,
  onProgress?: PoolProgress,
): Promise<void> {
  if (concurrency <= 0) {
    // Math.min(concurrency, total) below would silently start zero workers —
    // runPool would resolve successfully having run none of the jobs. Fail
    // loudly instead of pretending an empty run is success.
    throw new Error(`runPool: concurrency must be >= 1 (got ${concurrency})`);
  }
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

  // Wait for EVERY worker to settle, then surface the first failure. Promise.all
  // would reject the moment one worker throws, returning control to the caller
  // while sibling jobs are still in flight — and for an import that means poster
  // PUTs landing in R2 after the rollback has already swept the prefix.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, total) }, worker),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
}
