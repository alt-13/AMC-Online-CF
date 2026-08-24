<!--
  OmdbDialog.vue — search IMDb, pick a title, then choose which fetched fields to
  import (mirrors the self-hosted ScriptDialog's two-step flow). Emits an `apply`
  with the AMC-column patch (only the ticked fields) and the poster URL (only if
  its row is ticked); the parent decides how to merge (prefill on create, or
  overwrite fields on an existing movie).
-->
<template>
  <div class="backdrop" @click.self="close">
    <div class="dialog">
      <header class="head">
        <h3>Fetch from IMDb / OMDb</h3>
        <button class="x" @click="close">✕</button>
      </header>

      <!-- ── Step 1: search ── -->
      <template v-if="phase === 'search'">
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
      </template>

      <!-- ── Step 2: choose fields to import ── -->
      <template v-else>
        <div class="fields-head">
          <button class="back" @click="backToSearch"><i class="pi pi-arrow-left" /> Back</button>
          <span class="fields-title">Fields found — check which to import:</span>
          <button class="mini text" @click="selectAll">All</button>
          <button class="mini text" @click="clearSel">None</button>
        </div>

        <div class="body">
          <p v-if="error" class="err">{{ error }}</p>
          <p v-else-if="!rows.length" class="muted">No importable fields returned.</p>
          <div v-else class="results-grid">
            <label
              v-for="row in rows"
              :key="row.key"
              class="result-row"
              :class="{ selected: importKeys.has(row.key) }"
            >
              <input type="checkbox" :checked="importKeys.has(row.key)" @change="toggleKey(row.key)" />
              <span class="result-key">{{ row.label }}</span>
              <span class="result-val">{{ row.display }}</span>
            </label>
          </div>
        </div>

        <div class="fields-footer">
          <button
            class="primary"
            :disabled="importKeys.size === 0"
            @click="doImport"
          >Import {{ importKeys.size }} field{{ importKeys.size === 1 ? "" : "s" }}</button>
        </div>
      </template>

      <p class="hint" :class="{ warn: keyState && !keyState.hasKey }">
        <template v-if="keyState && !keyState.hasKey">
          <i class="pi pi-exclamation-triangle" />
          OMDb API key not configured.
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">Get one</a>,
          then <button class="inline-link" @click="emit('open-settings')">add it in Settings →</button>
          <i class="pi pi-info-circle info" :title="KEY_INFO" />
        </template>
        <template v-else>
          Metadata from IMDb / OMDb. Manage your key in
          <button class="inline-link" @click="emit('open-settings')">Settings</button>.
          <i class="pi pi-info-circle info" :title="KEY_INFO" />
        </template>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { omdb, type MovieRow, type OmdbSuggestion, type OmdbKeyState } from "./api";
import { FIELD_LABELS } from "./fields";

const props = defineProps<{ initialQuery?: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-settings"): void;
  (e: "apply", patch: Partial<MovieRow>, posterUrl: string): void;
}>();

// Detailed explainer for the OMDb key, shown as a native tooltip on the ⓘ icon.
const KEY_INFO =
  "API key for the OMDb API, used by the built-in fetch script to retrieve movie " +
  "details. Get a free key (1,000 req/day) at https://www.omdbapi.com/apikey.aspx " +
  "— search works without a key, only detail fetch requires it.";

// Synthetic row key for the poster (kept out of the MovieRow patch — it flows out
// as the separate posterUrl argument, matching setPictureFromUrl's contract).
const POSTER_KEY = "__poster__";

type FieldRow = { key: string; label: string; display: string; poster?: boolean };

const input = ref<HTMLInputElement>();
const query = ref(props.initialQuery ?? "");
const results = ref<OmdbSuggestion[]>([]);
const busy = ref(false);
const fetching = ref<string | null>(null);
const searched = ref(false);
const error = ref("");
const keyState = ref<OmdbKeyState | null>(null);

// Two-step flow: 'search' lists picks, 'fields' shows the fetched fields to tick.
const phase = ref<"search" | "fields">("search");
const rows = ref<FieldRow[]>([]);
const importKeys = ref(new Set<string>());
let fetched: { patch: Partial<MovieRow>; poster_url: string } | null = null;

// Persist the keys the user has deliberately unticked, so the next fetch defaults
// to the same selection (mirrors the self-hosted ScriptDialog behaviour).
const LS_KEY = "amc_omdb_excluded_fields";
function loadExcluded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveExcluded(s: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...s]));
  } catch {
    /* non-critical */
  }
}
const excludedKeys = loadExcluded();

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
    const res = await omdb.fetch(ttOrUrl);
    fetched = res;
    rows.value = buildRows(res.patch, res.poster_url);
    // Default the ticks to every returned field except ones the user last unticked.
    importKeys.value = new Set(rows.value.map((r) => r.key).filter((k) => !excludedKeys.has(k)));
    phase.value = "fields";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    fetching.value = null;
  }
}

function buildRows(patch: Partial<MovieRow>, posterUrl: string): FieldRow[] {
  const out: FieldRow[] = [];
  for (const [key, val] of Object.entries(patch)) {
    if (val == null || val === "") continue;
    out.push({ key, label: FIELD_LABELS[key] ?? key, display: displayVal(key, val) });
  }
  if (posterUrl) out.push({ key: POSTER_KEY, label: "Poster", display: posterUrl, poster: true });
  return out;
}

// Rating is stored ×10 (87 → 8.7); everything else shows as-is.
function displayVal(key: string, val: unknown): string {
  if (key === "rating" && typeof val === "number") return (val / 10).toFixed(1);
  return String(val);
}

function toggleKey(key: string) {
  const s = new Set(importKeys.value);
  if (s.has(key)) {
    s.delete(key);
    excludedKeys.add(key);
  } else {
    s.add(key);
    excludedKeys.delete(key);
  }
  importKeys.value = s;
  saveExcluded(excludedKeys);
}

function selectAll() {
  importKeys.value = new Set(rows.value.map((r) => r.key));
  excludedKeys.clear();
  saveExcluded(excludedKeys);
}

function clearSel() {
  for (const r of rows.value) excludedKeys.add(r.key);
  importKeys.value = new Set();
  saveExcluded(excludedKeys);
}

function backToSearch() {
  phase.value = "search";
  error.value = "";
}

function doImport() {
  if (!fetched) return;
  const outPatch: Partial<MovieRow> = {};
  let posterUrl = "";
  for (const row of rows.value) {
    if (!importKeys.value.has(row.key)) continue;
    if (row.poster) {
      posterUrl = fetched.poster_url;
      continue;
    }
    (outPatch as Record<string, unknown>)[row.key] = (fetched.patch as Record<string, unknown>)[row.key];
  }
  emit("apply", outPatch, posterUrl);
  emit("close");
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

/* ── Field picker (step 2) ── */
.fields-head { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem 0.4rem; }
.fields-title { flex: 1; min-width: 0; font-size: 0.78rem; color: var(--c-muted, #7e7a90); }
.back { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: none; color: var(--c-gold, #c9a84c); font: inherit; font-size: 0.78rem; cursor: pointer; padding: 0; }
.mini.text { background: none; border: none; color: var(--c-gold, #c9a84c); font-size: 0.75rem; cursor: pointer; padding: 0 0.15rem; }
.results-grid { display: flex; flex-direction: column; border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; overflow: hidden; }
.result-row { display: grid; grid-template-columns: 20px 120px 1fr; align-items: baseline; gap: 0.5rem; padding: 0.4rem 0.6rem; cursor: pointer; border-bottom: 1px solid var(--c-border, #2a2a48); font-size: 0.82rem; }
.result-row:last-child { border-bottom: none; }
.result-row:hover { background: var(--c-elevated, #1f1f38); }
.result-row.selected { background: var(--c-gold-dim, rgba(201,168,76,0.12)); }
.result-row input { cursor: pointer; accent-color: var(--c-gold, #c9a84c); }
.result-key { color: var(--c-muted, #7e7a90); font-size: 0.78rem; }
.result-val { color: var(--c-text, #e8e0d5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fields-footer { display: flex; justify-content: flex-end; padding: 0.7rem 1rem 0.3rem; }

.hint { padding: 0.6rem 1rem 0.9rem; font-size: 0.72rem; color: var(--c-muted, #7e7a90); }
.hint.warn { color: var(--c-danger, #e05252); }
.hint a { color: var(--c-gold, #c9a84c); }
.hint .info { margin-left: 0.3rem; color: var(--c-muted, #7e7a90); cursor: help; }
.inline-link { background: none; border: none; padding: 0; font: inherit; color: var(--c-gold, #c9a84c); cursor: pointer; text-decoration: underline; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
button.primary:disabled { opacity: 0.6; cursor: default; }
</style>
