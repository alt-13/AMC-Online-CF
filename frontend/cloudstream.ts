// Read a fetch Response body into one Uint8Array, reporting byte progress.
//
// Shared by the REST connectors (Drive, OneDrive, Dropbox): each downloads a
// whole .amc over plain `fetch`, and each must report progress — a silent
// multi-hundred-megabyte transfer is exactly what the UI must not do.
//
// Preallocates to the known size and clamps writes, so peak memory is 1x the
// file (matters on a phone) rather than 2x from concatenating chunks.

import type { ByteProgress } from "./connector";

export async function streamToBytes(
  res: Response,
  declaredSize: number,
  onProgress?: ByteProgress,
): Promise<Uint8Array> {
  const total = Number(res.headers.get("content-length") ?? 0) || declaredSize;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const buf = total > 0 ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (buf) {
      const c = loaded + value.length > total ? value.subarray(0, total - loaded) : value;
      buf.set(c, loaded);
      loaded += c.length;
    } else {
      chunks.push(value);
      loaded += value.length;
    }
    onProgress?.(loaded, total || loaded);
  }
  if (buf) return loaded === total ? buf : buf.subarray(0, loaded);
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}
