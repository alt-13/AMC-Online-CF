<!--
  OmdbDialog.vue — search IMDb, pick a title, then choose which fetched fields to
  import (mirrors the self-hosted ScriptDialog's two-step flow). Emits an `apply`
  with the AMC-column patch (only the ticked fields) and the poster URL (only if
  its row is ticked); the parent decides how to merge (prefill on create, or
  overwrite fields on an existing movie).
-->
<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    header="Fetch from IMDb / OMDb"
    :closable="true"
    :style="{ width: '480px' }"
    :breakpoints="{ '760px': '95vw' }"
    @update:visible="(v: boolean) => { if (!v) close(); }"
  >
    <!-- ── Step 1: search ── -->
    <template v-if="phase === 'search'">
      <div class="flex gap-2 mb-3">
        <InputText
          v-model="query"
          autofocus
          class="flex-1"
          placeholder="Title, IMDb URL, or tt-id…"
          @keydown.enter="run"
        />
        <Button label="Search" :loading="busy" :disabled="busy || !query.trim()" @click="run" />
      </div>

      <div class="min-h-[60px] max-h-[60vh] overflow-y-auto">
        <p v-if="error" class="text-danger text-sm m-0">{{ error }}</p>
        <p v-else-if="!results.length && !busy && searched" class="text-muted text-sm m-0">No matches.</p>
        <ul v-else class="list-none flex flex-col gap-1.5 m-0 p-0">
          <li v-for="r in results" :key="r.tt">
            <button
              class="w-full flex items-center justify-between gap-2 text-left p-2 bg-elevated border border-border rounded-md text-text hover:border-gold disabled:opacity-60 disabled:cursor-default"
              :disabled="fetching === r.tt"
              @click="pick(r.tt)"
            >
              <span class="text-sm min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ r.label }}</span>
              <span class="text-xs text-gold flex-shrink-0">{{ fetching === r.tt ? "Fetching…" : "Use →" }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>

    <!-- ── Step 2: choose fields to import ── -->
    <template v-else>
      <div class="flex items-center gap-2 mb-3">
        <Button label="Back" icon="pi pi-arrow-left" text @click="backToSearch" />
        <span class="flex-1 min-w-0 text-xs text-muted">Fields found — check which to import:</span>
        <Button label="All" link @click="selectAll" />
        <Button label="None" link @click="clearSel" />
      </div>

      <div class="min-h-[60px] max-h-[60vh] overflow-y-auto">
        <p v-if="error" class="text-danger text-sm m-0">{{ error }}</p>
        <p v-else-if="!rows.length" class="text-muted text-sm m-0">No importable fields returned.</p>
        <div v-else class="flex flex-col border border-border rounded-md overflow-hidden">
          <label
            v-for="row in rows"
            :key="row.key"
            class="grid grid-cols-[20px_120px_1fr] items-baseline gap-2 py-1.5 px-2.5 cursor-pointer border-b border-border last:border-b-0 text-sm hover:bg-elevated"
            :class="{ 'bg-gold-dim': importKeys.has(row.key) }"
          >
            <Checkbox
              :binary="true"
              :modelValue="importKeys.has(row.key)"
              @update:modelValue="() => toggleKey(row.key)"
            />
            <span class="text-xs text-muted">{{ row.label }}</span>
            <span class="text-text overflow-hidden text-ellipsis whitespace-nowrap">{{ row.display }}</span>
          </label>
        </div>
      </div>
    </template>

    <p class="text-xs m-0 mt-3" :class="keyState && !keyState.hasKey ? 'text-danger' : 'text-muted'">
      <template v-if="keyState && !keyState.hasKey">
        <i class="pi pi-exclamation-triangle" />
        OMDb API key not configured.
        <a class="text-gold" href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">Get one</a>,
        then <Button label="add it in Settings →" link class="p-0 align-baseline" @click="emit('open-settings')" />
        <i class="pi pi-info-circle text-muted cursor-help ml-1" :title="KEY_INFO" />
      </template>
      <template v-else>
        Metadata from IMDb / OMDb. Manage your key in
        <Button label="Settings" link class="p-0 align-baseline" @click="emit('open-settings')" />.
        <i class="pi pi-info-circle text-muted cursor-help ml-1" :title="KEY_INFO" />
      </template>
    </p>

    <template v-if="phase === 'fields'" #footer>
      <Button
        :label="'Import ' + importKeys.size + ' field' + (importKeys.size === 1 ? '' : 's')"
        :disabled="importKeys.size === 0"
        @click="doImport"
      />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
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
