// Hold a screen wake lock for the duration of a long task (import).
//
// On phones the OS aggressively suspends a backgrounded tab, which kills an
// in-flight import. Keeping the screen awake while the user watches the progress
// bar makes that far less likely. The lock is auto-released by the browser when
// the tab is hidden, so we re-acquire on return to visible. All of it is
// best-effort — the API is absent on some browsers, and that's fine.

interface WakeSentinel {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeSentinel>;
}

function wakeLockApi(): WakeLockLike | undefined {
  return (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
}

/** Run `fn` while holding a screen wake lock (re-acquired if the tab is hidden
 *  then shown again). Always releases the lock when `fn` settles. */
export async function withWakeLock<T>(fn: () => Promise<T>): Promise<T> {
  const api = wakeLockApi();
  // Held in an object so closure reassignment doesn't confuse flow narrowing.
  const held: { sentinel: WakeSentinel | null } = { sentinel: null };

  const acquire = async () => {
    if (!api || held.sentinel) return;
    try {
      held.sentinel = await api.request("screen");
    } catch {
      held.sentinel = null;
    }
  };
  // The browser auto-releases the lock when the tab hides; drop our stale handle
  // then, and re-acquire when it becomes visible again.
  const onVisible = () => {
    if (document.visibilityState === "visible") void acquire();
    else held.sentinel = null;
  };

  await acquire();
  document.addEventListener("visibilitychange", onVisible);
  try {
    return await fn();
  } finally {
    document.removeEventListener("visibilitychange", onVisible);
    try {
      if (held.sentinel) await held.sentinel.release();
    } catch {
      /* already released */
    }
    held.sentinel = null;
  }
}
