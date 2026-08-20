// Regression guard for MovieDetail.vue's "Save button stays active after save"
// bug. The Save button is `:disabled="saving || !dirty"`, so if `dirty` flips
// back to true after a save, the button re-enables.
//
// Root cause: the dirty watcher runs with Vue's default `flush: 'pre'`, i.e.
// ASYNCHRONOUSLY on the next flush. save() mutates the reactive `form`/`extras`
// (to sync the server response) and then sets `dirty=false` synchronously — but
// on the next microtask the watcher fires because the watched sources changed,
// and re-sets `dirty=true`. load() avoids this by wrapping its mutations under a
// `hydrating` flag it only clears after `nextTick()`; save() must do the same.
//
// This test models that exact pattern with the same primitives (no DOM / SFC
// mount harness exists on this branch), so it reproduces the timing precisely.
import { describe, it, expect } from "vitest";
import { reactive, ref, watch, nextTick } from "vue";

// Minimal stand-in for MovieDetail's dirty machinery.
function makeForm() {
  const form = reactive<Record<string, unknown>>({ id: "m1", original_title: "A", rating: 50 });
  const extras = ref<Array<{ title: string }>>([]);
  const hydrating = ref(false);
  const dirty = ref(false);

  watch([() => ({ ...form }), extras], () => {
    if (!hydrating.value) dirty.value = true;
  }, { deep: true });

  return { form, extras, hydrating, dirty };
}

// Buggy save(): mutate reactive state, then flip dirty synchronously (no guard).
async function saveBuggy(s: ReturnType<typeof makeForm>, serverRow: Record<string, unknown>) {
  Object.assign(s.form, serverRow);
  s.extras.value = [{ title: "x" }];
  s.dirty.value = false;
}

// Fixed save(): guard the response-sync mutations under `hydrating`, exactly as
// load() does, and clear the flag only after the watcher has flushed.
async function saveFixed(s: ReturnType<typeof makeForm>, serverRow: Record<string, unknown>) {
  s.hydrating.value = true;
  Object.assign(s.form, serverRow);
  s.extras.value = [{ title: "x" }];
  s.dirty.value = false;
  await nextTick();
  s.hydrating.value = false;
}

// Poster changes are binary side-effects that persist immediately (their own
// PUT/updateMovie call), so syncing `form.poster_key` back into the reactive
// form must NOT mark the text form dirty.
async function setPosterKeyBuggy(s: ReturnType<typeof makeForm>, key: string) {
  s.form.poster_key = key;
}
async function setPosterKeyFixed(s: ReturnType<typeof makeForm>, key: string) {
  s.hydrating.value = true;
  s.form.poster_key = key;
  await nextTick();
  s.hydrating.value = false;
}

describe("MovieDetail poster mutations vs dirty", () => {
  it("reproduces the bug: an unguarded poster_key sync marks the form dirty", async () => {
    const s = makeForm(); // starts clean, nothing to save
    await setPosterKeyBuggy(s, "t/c/m.jpg");
    await nextTick();
    // BUG: the poster already persisted, yet the Save button lights up.
    expect(s.dirty.value).toBe(true);
  });

  it("guarded poster_key sync keeps the form clean", async () => {
    const s = makeForm();
    await setPosterKeyFixed(s, "t/c/m.jpg");
    await nextTick();
    expect(s.dirty.value).toBe(false);
  });
});

describe("MovieDetail dirty tracking after save", () => {
  it("reproduces the bug: unguarded save leaves dirty=true after the watcher flushes", async () => {
    const s = makeForm();
    // Simulate a user edit.
    s.form.original_title = "Edited";
    await nextTick();
    expect(s.dirty.value).toBe(true);

    await saveBuggy(s, { original_title: "Edited" });
    await nextTick();
    // BUG: the deep watcher refires from save()'s own reactive mutations and
    // re-sets dirty, so the Save button re-enables after a successful save.
    expect(s.dirty.value).toBe(true);
  });

  it("fixed save keeps dirty=false after the watcher flushes", async () => {
    const s = makeForm();
    s.form.original_title = "Edited";
    await nextTick();
    expect(s.dirty.value).toBe(true);

    await saveFixed(s, { original_title: "Edited" });
    expect(s.dirty.value).toBe(false);
    await nextTick();
    expect(s.dirty.value).toBe(false); // stays clean → button stays disabled
  });
});
