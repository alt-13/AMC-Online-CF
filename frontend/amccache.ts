// Persistent cache for downloaded .amc bytes (IndexedDB).
//
// Mobile browsers suspend/kill a backgrounded tab, which drops the in-memory
// download of a large catalog — so a phone can end up re-downloading a 166 MB
// file several times before an import survives. Caching the fully-downloaded
// bytes keyed by the cloud source lets a resumed/retried pull skip the download
// entirely. Entries are cleared once the import succeeds and pruned by age.

const DB_NAME = "amc-cache";
const STORE = "amc";
const TTL_MS = 24 * 60 * 60 * 1000; // drop anything older than a day

interface Entry {
  key: string;
  bytes: ArrayBuffer;
  cachedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("indexedDB op failed"));
  });
}

/** Cached bytes for `key`, or null if absent/expired. All errors → null (the
 *  cache is an optimisation; a miss just means we download). */
export async function getCachedAmc(key: string): Promise<Uint8Array | null> {
  try {
    const db = await open();
    try {
      const entry = await tx<Entry | undefined>(db, "readonly", (s) => s.get(key));
      if (!entry) return null;
      if (Date.now() - entry.cachedAt > TTL_MS) {
        void dropCachedAmc(key);
        return null;
      }
      return new Uint8Array(entry.bytes);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Store bytes under `key`. Best-effort — a quota failure on a full phone must
 *  not break the import, so errors are swallowed. */
export async function putCachedAmc(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await open();
    try {
      // Copy into a standalone ArrayBuffer (the source may be a subarray view).
      const copy = bytes.slice().buffer;
      await tx(db, "readwrite", (s) =>
        s.put({ key, bytes: copy, cachedAt: Date.now() } satisfies Entry));
    } finally {
      db.close();
    }
  } catch {
    /* out of quota / private mode — skip caching */
  }
}

/** Remove one entry (called after a successful import). */
export async function dropCachedAmc(key: string): Promise<void> {
  try {
    const db = await open();
    try {
      await tx(db, "readwrite", (s) => s.delete(key));
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

/** Drop entries older than the TTL. Cheap housekeeping to run on app start. */
export async function pruneCachedAmc(): Promise<void> {
  try {
    const db = await open();
    try {
      const all = await tx<Entry[]>(db, "readonly", (s) => s.getAll());
      const now = Date.now();
      await Promise.all(
        all.filter((e) => now - e.cachedAt > TTL_MS).map((e) => dropCachedAmc(e.key)),
      );
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}
