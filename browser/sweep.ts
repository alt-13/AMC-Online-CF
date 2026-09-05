// Client half of the bounded R2 sweeps.
//
// Deleting a catalog's posters used to be one unbounded server-side loop over
// the whole R2 prefix. A catalog with thousands of objects made that a single
// Worker request of unbounded length (rule 7), so the sweeping routes now clear
// a few list pages and hand back a cursor. This is the loop that drives them.

import type { AuthedFetch } from "./import";

/** Hard cap on continuation requests, so a server that keeps returning a cursor
 *  can never spin here forever. Each call clears up to ~4000 objects, so this
 *  is orders of magnitude past any real catalog. */
const MAX_SWEEP_REQUESTS = 200;

/**
 * POST/DELETE `path` repeatedly, feeding back the `next` cursor each response
 * carries, until the server reports the prefix is clear.
 *
 * `path` must already carry its own query string separator needs — the cursor
 * is appended with the right one. Returns the first response body (callers that
 * need a payload, e.g. supersede, read it from there).
 */
export async function sweepAll<T extends { next?: string | null }>(
  send: AuthedFetch,
  path: string,
  method: "POST" | "DELETE" = "POST",
  cursor: string | null = null,
): Promise<T | null> {
  let first: T | null = null;
  for (let i = 0; i < MAX_SWEEP_REQUESTS; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const qs = cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : "";
    const res = await send(`${path}${qs}`, { method });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    // 204 is what these routes returned before they were paged; treat it as
    // "done, nothing more to sweep" so an older Worker still works.
    const body = res.status === 204 ? ({} as T) : ((await res.json().catch(() => ({}))) as T);
    if (first === null) first = body;
    cursor = body.next ?? null;
    if (!cursor) return first;
  }
  return first;
}
