<!--
  OmdbDialog.vue — search IMDb, pick a title, fetch its OMDb metadata. Emits an
  `apply` with the AMC-column patch and the poster URL; the parent decides how to
  merge (prefill on create, or overwrite fields on an existing movie).
-->
<template>
  <div class="backdrop" @click.self="close">
    <div class="dialog">
      <header class="head">
        <h3>Fetch from IMDb / OMDb</h3>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="search">
        <input
          ref="input"
          v-model="query"
          placeholder="Title, IMDb URL, or tt-id…"
          @keydown.enter="run"
        />
        <button class="primary" :disabled="busy || !query.trim()" @click="run">
          {{ busy ? "…" : "Search" }}
        </button>
      </div>

      <div class="body">
        <p v-if="error" class="err">{{ error }}</p>
        <p v-else-if="!results.length && !busy && searched" class="muted">No matches.</p>
        <ul v-else class="list">
          <li v-for="r in results" :key="r.tt">
            <button class="pick" :disabled="fetching === r.tt" @click="pick(r.tt)">
              <span class="label">{{ r.label }}</span>
              <span class="go">{{ fetching === r.tt ? "Fetching…" : "Use →" }}</span>
            </button>
          </li>
        </ul>
      </div>
      <p class="hint" :class="{ warn: keyState && !keyState.hasKey }">
        <template v-if="keyState && !keyState.hasKey">
          Fetch needs a free OMDb API key.
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">Get one</a>,
          then <button class="inline-link" @click="emit('open-settings')">add it in Settings →</button>
        </template>
        <template v-else>
          Metadata from IMDb / OMDb. Manage your key in
          <button class="inline-link" @click="emit('open-settings')">Settings</button>.
        </template>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { omdb, type MovieRow, type OmdbSuggestion, type OmdbKeyState } from "./api";

const props = defineProps<{ initialQuery?: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-settings"): void;
  (e: "apply", patch: Partial<MovieRow>, posterUrl: string): void;
}>();

const input = ref<HTMLInputElement>();
const query = ref(props.initialQuery ?? "");
const results = ref<OmdbSuggestion[]>([]);
const busy = ref(false);
const fetching = ref<string | null>(null);
const searched = ref(false);
const error = ref("");
const keyState = ref<OmdbKeyState | null>(null);

onMounted(() => {
  input.value?.focus();
  void omdb.keyState().then((s) => (keyState.value = s)).catch(() => {});
  if (query.value.trim()) void run();
});

async function run() {
  const q = query.value.trim();
  if (!q || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    // A URL or tt-id can be fetched directly; a plain title lists picks.
    if (/tt\d+/.test(q) || /^\d+$/.test(q)) {
      await pick(q);
      return;
    }
    results.value = await omdb.search(q);
    searched.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function pick(ttOrUrl: string) {
  fetching.value = ttOrUrl;
  error.value = "";
  try {
    const { patch, poster_url } = await omdb.fetch(ttOrUrl);
    emit("apply", patch, poster_url);
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    fetching.value = null;
  }
}

function close() {
  emit("close");
}
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 1rem; }
.dialog { width: 480px; max-width: 95vw; max-height: 85vh; display: flex; flex-direction: column; background: var(--c-card, #181828); border: 1px solid var(--c-border, #2a2a48); border-radius: var(--radius, 8px); color: var(--c-text, #e8e0d5); }
.head { display: flex; align-items: center; justify-content: space-between; padding: 0.9rem 1rem; border-bottom: 1px solid var(--c-border, #2a2a48); }
.head h3 { font-family: var(--font-display, serif); color: var(--c-gold, #c9a84c); font-size: 1.05rem; }
.x { background: none; border: none; color: var(--c-muted, #7e7a90); font-size: 1rem; cursor: pointer; }
.search { display: flex; gap: 0.5rem; padding: 0.8rem 1rem; }
.search input { flex: 1; padding: 0.45rem 0.6rem; background: var(--c-elevated, #1f1f38); color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; }
.body { overflow-y: auto; padding: 0 1rem; min-height: 60px; }
.list { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
.pick { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; text-align: left; padding: 0.5rem 0.6rem; background: var(--c-elevated, #1f1f38); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; color: var(--c-text, #e8e0d5); cursor: pointer; }
.pick:hover { border-color: var(--c-gold, #c9a84c); }
.pick:disabled { opacity: 0.6; cursor: default; }
.label { font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go { font-size: 0.72rem; color: var(--c-gold, #c9a84c); flex-shrink: 0; }
.muted { color: var(--c-muted, #7e7a90); font-size: 0.85rem; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; }
.hint { padding: 0.6rem 1rem 0.9rem; font-size: 0.72rem; color: var(--c-muted, #7e7a90); }
.hint.warn { color: var(--c-danger, #e05252); }
.hint a { color: var(--c-gold, #c9a84c); }
.inline-link { background: none; border: none; padding: 0; font: inherit; color: var(--c-gold, #c9a84c); cursor: pointer; text-decoration: underline; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
button.primary:disabled { opacity: 0.6; cursor: default; }
</style>
