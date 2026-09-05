// Runs an amcjob off the main thread when the platform has Workers, inline when
// it doesn't (vitest's node environment, very old browsers).
//
// One worker per job, terminated on completion: these are one-shot, minutes
// apart, and terminating is the cheapest way to guarantee the ~90 MB the parse
// held is actually released. No id routing, no pool — one job, one worker, one
// promise.

import { runAmcJob } from "./amcjob";
import type { AmcJob, JobProgress, JobResult } from "./amcjob";

export type { JobProgress };

function offThread(
  job: AmcJob,
  transfer: Transferable[],
  onProgress?: (p: JobProgress) => void,
): Promise<JobResult> {
  const worker = new Worker(new URL("./amc.worker.ts", import.meta.url), { type: "module" });
  return new Promise<JobResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.progress) return onProgress?.(e.data.progress as JobProgress);
      worker.terminate();
      if (e.data?.error) reject(new Error(String(e.data.error)));
      else resolve(e.data as JobResult);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "amc worker failed"));
    };
    worker.postMessage(job, transfer);
  });
}

/** Run `job`, off the main thread where possible. `transfer` lists the buffers
 *  to hand over rather than copy — the caller must not touch them afterwards. */
export async function runJob(
  job: AmcJob,
  transfer: Transferable[] = [],
  onProgress?: (p: JobProgress) => void,
): Promise<JobResult> {
  if (typeof Worker === "undefined") return (await runAmcJob(job, onProgress)).payload;
  return offThread(job, transfer, onProgress);
}
