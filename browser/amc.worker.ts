// Web Worker shim. All the logic lives in amcjob.ts so the same code runs
// inline when `Worker` is unavailable — see amcworker.ts.

import { runAmcJob, type AmcJob } from "./amcjob";

// `self` is typed as Window here (and as the Cloudflare Worker global in
// tsconfig.json, which also type-checks browser/**). Inside a dedicated Web
// Worker it is neither, so narrow it to the two members this file uses.
const ctx = self as unknown as {
  onmessage: ((e: { data: AmcJob }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

ctx.onmessage = async (e) => {
  try {
    const { payload, transfer } = await runAmcJob(e.data, (progress) =>
      ctx.postMessage({ progress }),
    );
    ctx.postMessage(payload, transfer);
  } catch (err) {
    ctx.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
