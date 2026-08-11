<!--
  SettingsDialog.vue — per-user field visibility (desktop/mobile) + the search
  field. Persists the one JSON blob the Worker stores in `user_settings`.
  Plain modal; no component library.
-->
<template>
  <div class="backdrop" @click.self="close">
    <div class="dialog">
      <header class="head">
        <h3>Field visibility</h3>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="cols">
        <span class="field-h">Field</span>
        <span class="mode-h">🖥</span>
        <span class="mode-h">📱</span>
      </div>

      <div class="body">
        <div v-for="sec in sections" :key="sec.key" class="section">
          <div class="sec-head" @click="toggle(sec.key)">
            <span class="chev">{{ expanded.has(sec.key) ? "▼" : "▶" }}</span>
            <span class="sec-label">{{ sec.label }}</span>
          </div>
          <template v-if="expanded.has(sec.key)">
            <div v-for="f in sec.fields" :key="f.key" class="row">
              <span class="name">{{ f.label }}</span>
              <input
                type="checkbox"
                :checked="vis(f.key, 'desktop')"
                :disabled="f.always"
                @change="set(f.key, 'desktop', ($event.target as HTMLInputElement).checked)"
              />
              <input
                type="checkbox"
                :checked="vis(f.key, 'mobile')"
                :disabled="f.always"
                @change="set(f.key, 'mobile', ($event.target as HTMLInputElement).checked)"
              />
            </div>
          </template>
        </div>

        <div class="section">
          <div class="sec-head static"><span class="sec-label">Search field</span></div>
          <div class="search-row">
            <select v-model="draft.search_field">
              <option value="">All fields</option>
              <option v-for="f in searchable" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
          </div>
        </div>
      </div>

      <footer class="foot">
        <button class="link" @click="reset">↩ Reset</button>
        <div class="btns">
          <button class="ghost" @click="close">Cancel</button>
          <button class="primary" :disabled="saving" @click="save">
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </footer>
      <p v-if="error" class="err">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { settings as settingsApi, type CustomFieldDefRow } from "./api";
import { sectionsFor, DEFAULT_SETTINGS, type AppSettings } from "./fields";

const props = defineProps<{ defs: CustomFieldDefRow[] }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", s: AppSettings): void }>();

const sections = computed(() => sectionsFor(props.defs));
const searchable = computed(() => sections.value.flatMap((s) => s.fields));

const draft = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
const expanded = ref(new Set(["main"]));
const saving = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    draft.value = { ...structuredClone(DEFAULT_SETTINGS), ...(await settingsApi.get()) };
  } catch {
    /* defaults */
  }
});

function vis(key: string, mode: "desktop" | "mobile"): boolean {
  if (key === "original_title") return true;
  return draft.value.field_visibility[mode][key] ?? true;
}
function set(key: string, mode: "desktop" | "mobile", value: boolean) {
  draft.value.field_visibility[mode][key] = value;
}
function toggle(key: string) {
  expanded.value.has(key) ? expanded.value.delete(key) : expanded.value.add(key);
  expanded.value = new Set(expanded.value);
}
function reset() {
  draft.value = { ...draft.value, field_visibility: { desktop: {}, mobile: {} } };
}
async function save() {
  saving.value = true;
  error.value = "";
  try {
    const saved = await settingsApi.save(draft.value);
    emit("saved", saved);
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
function close() {
  emit("close");
}
</script>

<style scoped>
.backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 1rem;
}
.dialog {
  width: 520px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;
  background: var(--c-card, #181828); border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px); color: var(--c-text, #e8e0d5);
}
.head { display: flex; align-items: center; justify-content: space-between; padding: 0.9rem 1rem; border-bottom: 1px solid var(--c-border, #2a2a48); }
.head h3 { font-family: var(--font-display, serif); color: var(--c-gold, #c9a84c); font-size: 1.05rem; }
.x { background: none; border: none; color: var(--c-muted, #7e7a90); font-size: 1rem; cursor: pointer; }
.cols { display: grid; grid-template-columns: 1fr 40px 40px; gap: 0.5rem; padding: 0.4rem 1rem; border-bottom: 1px solid var(--c-border, #2a2a48); }
.field-h { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-muted, #7e7a90); }
.mode-h { text-align: center; font-size: 0.8rem; }
.body { overflow-y: auto; padding: 0.25rem 0; }
.section { border-bottom: 1px solid var(--c-border, #2a2a48); }
.sec-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 1rem; background: var(--c-elevated, #1f1f38); cursor: pointer; user-select: none; }
.sec-head.static { cursor: default; }
.chev { font-size: 0.6rem; color: var(--c-muted, #7e7a90); width: 10px; }
.sec-label { font-size: 0.78rem; font-weight: 600; color: var(--c-gold, #c9a84c); }
.row { display: grid; grid-template-columns: 1fr 40px 40px; align-items: center; padding: 0.28rem 1rem 0.28rem 1.75rem; }
.row:hover { background: var(--c-elevated, #1f1f38); }
.row input { justify-self: center; accent-color: var(--c-gold, #c9a84c); }
.name { font-size: 0.8rem; }
.search-row { padding: 0.5rem 1rem 0.7rem 1.75rem; }
.search-row select { width: 100%; padding: 0.4rem; background: var(--c-elevated, #1f1f38); color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; }
.foot { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; border-top: 1px solid var(--c-border, #2a2a48); }
.link { background: none; border: none; color: var(--c-muted, #7e7a90); font-size: 0.75rem; cursor: pointer; }
.link:hover { color: var(--c-gold, #c9a84c); }
.btns { display: flex; gap: 0.5rem; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; border-radius: 6px; padding: 0.4rem 0.9rem; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
button.ghost { background: transparent; color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; padding: 0.4rem 0.9rem; font-size: 0.82rem; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
.err { color: var(--c-danger, #e05252); font-size: 0.8rem; padding: 0 1rem 0.75rem; }
</style>
