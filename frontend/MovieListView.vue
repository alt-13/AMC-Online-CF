<!--
  MovieListView.vue — the movies inside one catalog, as a two-pane workspace that
  mirrors the Unraid app: a virtual-scrolled TABLE on the left (color tag · poster
  thumb · title/translated · year · rating · watched), the edit form on the right.
  On a phone the detail slides over the full screen.

  The left pane is a byte-for-byte visual match of the self-hosted MovieList.vue
  (same fonts, tokens, row geometry, PrimeIcons glyphs, search bar, footer) — the
  only structural add is the catalog bar (back/title/fields/fetch), which the
  self-hosted app keeps in a global topbar this per-catalog view doesn't have.

  Two things make a 2880-row catalog usable: PrimeVue DataTable virtual scrolling
  (only the visible rows are in the DOM) and lazy thumbnails (a poster is fetched
  only when its row scrolls into view — never all at once).
-->
<template>
  <div class="workspace" :class="{ 'has-detail': selectedId }">
    <!-- LEFT: list -->
    <section class="movie-list flex flex-col min-w-0 min-h-0 h-full bg-surface border-r border-border max-[760px]:border-r-0 max-[760px]:h-[100dvh]">
      <!-- Catalog bar: back to libraries + name + field/fetch actions.
           (Self-hosted keeps these in a global topbar; this view is per-catalog.) -->
      <div class="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <!-- Deliberately `text`, not `outlined`: the catalog bar is chrome, and
             three bordered boxes flanking the title read heavier than the bar
             needs. (The detail header's actions ARE outlined.) -->
        <Button icon="pi pi-arrow-left" text size="small" title="Back to libraries" @click="$emit('back')" />
        <span class="min-w-0 font-display font-bold text-gold text-[1.05rem] tracking-wide truncate">
          {{ catalog.name || "(untitled)" }}
        </span>
        <!-- Counts, as in the self-hosted topbar: a "series" is an entry whose
             on-disk number is 1 (the Delphi app's grouping convention). -->
        <span v-if="!loading" class="flex-1 flex items-center gap-3 shrink min-w-0 text-[0.8rem] text-muted whitespace-nowrap">
          <span>{{ filmCount }} films</span>
          <span>{{ seriesCount }} series</span>
        </span>
        <span v-else class="flex-1" />
        <div class="flex gap-1.5 shrink-0">
          <Button icon="pi pi-cog" text size="small" title="Field settings" @click="settingsOpen = true" />
          <Button icon="pi pi-bolt" text size="small" title="Fetch from OMDb → new film" @click="omdbOpen = true" />
        </div>
      </div>

      <!-- Toolbar: search + new (matches the self-hosted MovieList toolbar).
           z-20 lifts the scope dropdown above the DataTable body. -->
      <div class="relative z-20 flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <div class="relative flex-1 flex items-center">
          <i class="pi pi-search absolute left-2.5 text-xs text-muted pointer-events-none" />
          <InputText
            v-model="searchInput"
            class="w-full pl-[1.8rem] pr-[3.1rem] text-[0.825rem]"
            :placeholder="searchField ? `Search ${activeScopeLabel}…` : 'Search films…'"
          />
          <!-- Scope filter: pick which field the search matches (mirrors the
               self-hosted filter icon inside the search bar). -->
          <div ref="scopeRef" class="absolute right-6 top-1/2 -translate-y-1/2 flex">
            <button
              class="inline-flex items-center justify-center bg-transparent border-none cursor-pointer text-xs px-1 leading-none transition-colors"
              :class="searchField ? 'text-gold' : 'text-muted hover:text-text'"
              :title="searchField ? `Searching: ${activeScopeLabel}` : 'Search scope'"
              @click.stop="scopeOpen = !scopeOpen"
            >
              <i class="pi pi-filter" />
            </button>
            <div
              v-if="scopeOpen"
              class="absolute top-[calc(100%+6px)] right-0 z-50 min-w-[190px] max-h-[340px] overflow-y-auto p-1 bg-elevated border border-border rounded-lg shadow-[0_10px_28px_rgba(0,0,0,0.4)]"
            >
              <template v-for="g in scopeGroups" :key="g.label || 'all'">
                <div v-if="g.label" class="px-2 pt-1.5 pb-0.5 text-[0.66rem] font-semibold uppercase tracking-wider text-muted">
                  {{ g.label }}
                </div>
                <button
                  v-for="it in g.items"
                  :key="it.value"
                  class="block w-full text-left bg-transparent border-none px-2 py-1.5 rounded cursor-pointer text-[0.8rem] whitespace-nowrap text-text hover:bg-surface"
                  :class="{ 'text-gold! bg-gold-dim': it.value === searchField }"
                  @click="pickScope(it.value)"
                >{{ it.label }}</button>
              </template>
            </div>
          </div>
          <button
            v-if="searchInput"
            class="absolute right-2 bg-transparent border-none text-muted hover:text-text cursor-pointer text-[0.7rem] p-0 leading-none"
            @click="searchInput = ''"
          >
            <i class="pi pi-times" />
          </button>
        </div>
        <Button icon="pi pi-plus" outlined :disabled="creating" title="New film" @click="onCreate()" />
      </div>

      <!-- Table -->
      <div class="flex-1 min-h-0">
        <div v-if="loading" class="flex items-center justify-center gap-2 p-8 text-muted text-sm">Loading catalog…</div>
        <div v-else-if="!filtered.length" class="flex items-center justify-center gap-2 p-8 text-muted text-sm">
          <i class="pi pi-search" /> No films match "{{ q }}"
        </div>
        <DataTable
          v-else
          :value="filtered"
          dataKey="id"
          scrollable
          scrollHeight="flex"
          :showHeaders="false"
          :virtualScrollerOptions="{ itemSize: 52 }"
          :rowClass="rowClass"
          class="movie-dt text-sm"
          @row-click="onRowClick"
        >
          <Column headerStyle="width:4px" bodyStyle="width:4px">
            <template #body="{ data }">
              <span
                class="block w-1 h-8 rounded-sm"
                :style="{ background: colorOf(data.color_tag) }"
                :title="colorNameOf(data.color_tag)"
              />
            </template>
          </Column>
          <Column headerStyle="width:28px" bodyStyle="width:28px">
            <template #body="{ data }">
              <span class="block w-7 h-10 overflow-hidden rounded-sm bg-elevated" @vue:mounted="loadThumb(data)">
                <img v-if="thumbs[data.id]" :src="thumbs[data.id]" class="w-full h-full object-cover" alt="" />
                <span v-else class="w-full h-full flex items-center justify-center text-border-hi text-xs"><i class="pi pi-image" /></span>
              </span>
            </template>
          </Column>
          <Column>
            <template #body="{ data }">
              <span class="flex flex-col gap-px min-w-0 overflow-hidden">
                <span class="text-[0.845rem] font-medium text-text truncate">{{ data.original_title || "—" }}</span>
                <span
                  v-if="data.translated_title && data.translated_title !== data.original_title"
                  class="text-xs text-muted italic truncate"
                >{{ data.translated_title }}</span>
              </span>
            </template>
          </Column>
          <Column headerStyle="width:3rem" bodyStyle="width:3rem">
            <template #body="{ data }"><span class="text-sm text-muted tabular-nums text-center block">{{ data.year > 0 ? data.year : "" }}</span></template>
          </Column>
          <Column headerStyle="width:2.5rem" bodyStyle="width:2.5rem">
            <template #body="{ data }"><span class="text-sm font-semibold text-gold tabular-nums text-right block">{{ data.rating > 0 ? (data.rating / 10).toFixed(1) : "" }}</span></template>
          </Column>
          <Column headerStyle="width:1.5rem" bodyStyle="width:1.5rem">
            <template #body="{ data }"><i v-if="data.checked" class="pi pi-eye text-success text-sm" title="Watched" /></template>
          </Column>
        </DataTable>
      </div>

      <!-- Count -->
      <div class="px-3 py-1.5 text-[0.72rem] text-muted border-t border-border shrink-0">
        {{ filtered.length }} / {{ movies.length }} films and series
      </div>
      <p v-if="error" class="text-danger text-[0.82rem] px-3 pb-1.5">{{ error }}</p>
    </section>

    <!-- RIGHT: detail (overlays on mobile) -->
    <section class="pane-detail">
      <MovieDetail
        v-if="selectedId"
        ref="detailRef"
        :movie-id="selectedId"
        :defs="defs"
        :settings="settings"
        @back="requestClose"
        @deleted="onDeleted"
        @changed="refresh"
        @live="applyLive"
        @open-settings="settingsOpen = true"
      />
      <div v-else class="flex-1 flex flex-col items-center justify-center gap-2 text-muted">
        <div class="text-5xl opacity-40">🎞</div>
        <p class="font-display text-lg text-muted">No film selected</p>
        <p class="text-[0.85rem]">Select a film from the list or create a new one</p>
      </div>
    </section>

    <SettingsDialog
      v-if="settingsOpen"
      :defs="defs"
      @close="settingsOpen = false"
      @saved="settings = $event"
    />
    <OmdbDialog
      v-if="omdbOpen"
      @close="omdbOpen = false"
      @open-settings="omdbOpen = false; settingsOpen = true"
      @apply="createFromOmdb"
    />

    <ConfirmDialog
      v-if="confirmOpen"
      title="Unsaved changes"
      :message="`You have unsaved edits${confirmMovieTitle ? ` to “${confirmMovieTitle}”` : ''}. Save them before leaving?`"
      confirm-label="Save & continue"
      discard-label="Discard"
      cancel-label="Keep editing"
      :busy="confirmBusy"
      @confirm="confirmSave"
      @discard="confirmDiscard"
      @cancel="confirmCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import {
  cf, settings as settingsApi, type CatalogRow, type MovieRow, type CustomFieldDefRow,
} from "./api";
import MovieDetail from "./MovieDetail.vue";
import SettingsDialog from "./SettingsDialog.vue";
import OmdbDialog from "./OmdbDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import {
  DEFAULT_SETTINGS, type AppSettings, COLOR_TAG_COLORS, COLOR_TAG_NAMES,
  searchScopes, scopeLabel, ALL_SEARCH_FIELDS,
} from "./fields";
import { pushView, goBack, dropView } from "./nav";

const props = defineProps<{ catalog: CatalogRow }>();
defineEmits<{ (e: "back"): void }>();

const movies = ref<MovieRow[]>([]);
const defs = ref<CustomFieldDefRow[]>([]);
const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
const loading = ref(true);
const error = ref("");
const selectedId = ref<string | null>(null);
const creating = ref(false);
const settingsOpen = ref(false);
const omdbOpen = ref(false);

// --- unsaved-changes guard --------------------------------------------------
// The detail pane owns the `dirty` flag; we read it (and call save/discard)
// through a template ref. Any navigation away from a dirty movie — clicking
// another row, the on-screen Back, or the hardware/OS Back — is intercepted and
// routed through ConfirmDialog instead of silently discarding the edits.
const detailRef = ref<InstanceType<typeof MovieDetail> | null>(null);
const confirmOpen = ref(false);
const confirmBusy = ref(false);
let pendingProceed: (() => void) | null = null;

const confirmMovieTitle = computed(
  () => movies.value.find((m) => m.id === selectedId.value)?.original_title ?? "",
);

// Run `proceed` now if the detail is clean; otherwise stash it and ask first.
function guard(proceed: () => void) {
  if (detailRef.value?.dirty) {
    pendingProceed = proceed;
    confirmOpen.value = true;
  } else {
    proceed();
  }
}

async function confirmSave() {
  confirmBusy.value = true;
  const ok = await detailRef.value?.save();
  confirmBusy.value = false;
  if (!ok) {
    // Save failed — keep the detail open (the error is shown inside it) and drop
    // the pending navigation rather than leaving with unsaved changes.
    confirmOpen.value = false;
    pendingProceed = null;
    return;
  }
  finishConfirm();
}
function confirmDiscard() {
  detailRef.value?.discard();
  // Drop any optimistic edits and refetch so the row reverts to server truth
  // (discard() cleared `dirty`, so refresh won't re-apply the stale livePatch).
  livePatch = null;
  void refresh();
  finishConfirm();
}
function confirmCancel() {
  confirmOpen.value = false;
  pendingProceed = null;
}
function finishConfirm() {
  confirmOpen.value = false;
  const p = pendingProceed;
  pendingProceed = null;
  p?.();
}

const thumbs = reactive<Record<string, string>>({});
const objectUrls: string[] = [];

// Search: `searchInput` tracks keystrokes; `q` is debounced 250 ms and drives the
// filter (clearing is immediate) — same behaviour as the self-hosted MovieList.
const searchInput = ref("");
const q = ref("");
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (val) => {
  if (searchTimer) clearTimeout(searchTimer);
  if (!val) { q.value = ""; return; }
  searchTimer = setTimeout(() => { q.value = val; }, 250);
});

// A movie whose on-disk number is 1 is a series entry (the same rule the
// self-hosted store uses for `is_series`); everything else counts as a film.
const seriesCount = computed(() => movies.value.filter((m) => m.number === 1).length);
const filmCount = computed(() => movies.value.length - seriesCount.value);

// Sort by number descending (newest first), matching the self-hosted list, then
// filter client-side over that order.
const sorted = computed(() => [...movies.value].sort((a, b) => b.number - a.number));

const filtered = computed(() => {
  const term = q.value.trim().toLowerCase();
  if (!term) return sorted.value;
  const field = settings.value.search_field;
  return sorted.value.filter((m) => matches(m, term, field));
});

// "All fields" (field === "") scans the full curated field set + every custom
// value — matching the self-hosted search. A specific scope matches only that
// column, or the one custom field for a `custom_<tag>` scope.
function matches(m: MovieRow, term: string, field: string): boolean {
  if (!field) {
    for (const k of ALL_SEARCH_FIELDS) {
      if (String((m as Record<string, unknown>)[k] ?? "").toLowerCase().includes(term)) return true;
    }
    return customValues(m).some((v) => v.toLowerCase().includes(term));
  }
  if (field.startsWith("custom_")) {
    const cv = parseCustom(m);
    return String(cv[field.slice(7)] ?? "").toLowerCase().includes(term);
  }
  return String((m as Record<string, unknown>)[field] ?? "").toLowerCase().includes(term);
}

function parseCustom(m: MovieRow): Record<string, string> {
  try {
    return JSON.parse(m.custom_values || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function customValues(m: MovieRow): string[] {
  return Object.values(parseCustom(m)).map(String);
}

// --- search scope (the inline filter icon) ---------------------------------
const scopeOpen = ref(false);
const scopeRef = ref<HTMLElement | null>(null);
const searchField = computed(() => settings.value.search_field);
const scopeGroups = computed(() => searchScopes(defs.value));
const activeScopeLabel = computed(() => scopeLabel(defs.value, searchField.value));

async function pickScope(value: string) {
  scopeOpen.value = false;
  if (settings.value.search_field === value) return;
  settings.value = { ...settings.value, search_field: value };
  // Persist like the self-hosted control; searching still works in-memory if it fails.
  try {
    await settingsApi.save(settings.value);
  } catch {
    /* non-critical */
  }
}

// Close the scope menu on an outside click.
function onDocClick(e: MouseEvent) {
  if (scopeOpen.value && scopeRef.value && !scopeRef.value.contains(e.target as Node)) {
    scopeOpen.value = false;
  }
}

// --- DataTable row styling + click ------------------------------------------
// Selection stays MANUAL (rowClass + row-click routed through the guard) so the
// unsaved-changes prompt keeps control — DataTable's own selectionMode would
// change the selection before the guard could prompt.
function rowClass(data: MovieRow) {
  return data.id === selectedId.value ? "amc-row amc-row-sel" : "amc-row";
}
function onRowClick(e: { data: MovieRow }) {
  select(e.data.id); // existing guard — prompts if the open detail is dirty
}

// Lazy thumbnails: fetch a poster only for rows currently on screen, and cap how
// many are in flight at once. `loadThumb` is called from the poster cell's
// `@vue:mounted`, so it fires exactly when a row scrolls into view (the virtual
// scroller only mounts visible rows). Without the cap, fast-scrolling a large
// catalog would fire a request for every row it passes — hundreds of pending
// fetches that saturate the browser's per-host connection pool and stall the
// detail pane when you click a row. The cap is kept below the ~6-per-host browser
// limit so the detail pane always has a free connection.
const MAX_CONCURRENT_THUMBS = 4;
const requested = new Set<string>(); // loaded or in flight — never fetched twice
let thumbQueue: MovieRow[] = [];
let activeThumbs = 0;

function loadThumb(m: MovieRow) {
  if (!m.poster_key || thumbs[m.id] || requested.has(m.id)) return;
  thumbQueue.push(m);
  pumpThumbs();
}

function pumpThumbs() {
  while (activeThumbs < MAX_CONCURRENT_THUMBS && thumbQueue.length) {
    const m = thumbQueue.shift()!;
    if (!m.poster_key || thumbs[m.id] || requested.has(m.id)) continue;
    requested.add(m.id);
    activeThumbs++;
    cf.posterObjectUrl(m.poster_key)
      .then((url) => { thumbs[m.id] = url; objectUrls.push(url); })
      .catch(() => { requested.delete(m.id); }) // let it retry if it scrolls back
      .finally(() => { activeThumbs--; pumpThumbs(); });
  }
}

// --- AMC colour tags (0 = none) — the shared palette from fields.ts ---------
function colorOf(tag: number): string {
  return COLOR_TAG_COLORS[tag] ?? "transparent";
}
function colorNameOf(tag: number): string {
  return COLOR_TAG_NAMES[tag] ?? "";
}

// --- lifecycle -------------------------------------------------------------
onMounted(async () => {
  await load();
  document.addEventListener("click", onDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  dropView(detailCloser); // don't leak a closer if we unmount with detail open
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [info, list, s] = await Promise.all([
      cf.catalogInfo(props.catalog.id),
      cf.listMovies(props.catalog.id),
      settingsApi.get().catch(() => structuredClone(DEFAULT_SETTINGS)),
    ]);
    defs.value = info.custom_field_defs;
    settings.value = s;
    movies.value = list;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// Optimistic list sync from the open detail form. `livePatch` holds the last
// snapshot the detail pushed so a refetch (e.g. triggered by an immediate poster
// save) doesn't overwrite still-unsaved text edits with server truth — we
// re-apply it while the detail reports itself dirty. A clean detail (just
// saved / discarded) skips the re-apply, letting the server data win.
let livePatch: (Partial<MovieRow> & { id: string }) | null = null;

function applyLive(patch: Partial<MovieRow> & { id: string }) {
  livePatch = patch;
  const row = movies.value.find((mv) => mv.id === patch.id);
  if (row) Object.assign(row, patch);
}

async function refresh() {
  movies.value = await cf.listMovies(props.catalog.id);
  if (livePatch && detailRef.value?.dirty) {
    const row = movies.value.find((mv) => mv.id === livePatch!.id);
    if (row) Object.assign(row, livePatch);
  }
}

// Opening a movie is a history level so the OS Back button returns to the list
// (not out of the app). `detailCloser` is stable so hardware Back and the
// on-screen "← Back" both resolve to the same close.
const detailCloser = () => {
  if (detailRef.value?.dirty) {
    // The hardware/OS Back already popped this history level via popstate. Re-push
    // it so a *confirmed* close still has an entry to pop, then ask before we
    // actually close. (Save/Discard clear `dirty`, so the follow-up goBack falls
    // straight through to the close below.)
    pushView(detailCloser);
    guard(() => goBack());
    return;
  }
  selectedId.value = null;
};
function openDetail(id: string) {
  const wasOpen = selectedId.value !== null;
  selectedId.value = id;
  if (!wasOpen) pushView(detailCloser); // one level whether or not you switch rows
}
function select(id: string) {
  if (id === selectedId.value) return; // no-op re-click: never prompt
  guard(() => openDetail(id));
}
// On-screen Back button (mobile) routes through the same guard as hardware Back.
function requestClose() {
  guard(() => goBack());
}

async function onCreate(patch: Partial<MovieRow> = {}) {
  creating.value = true;
  error.value = "";
  try {
    const created = await cf.createMovie(props.catalog.id, patch);
    await refresh();
    openDetail(created.id); // jump straight into the editor
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

async function createFromOmdb(patch: Partial<MovieRow>, posterUrl: string) {
  creating.value = true;
  try {
    const created = await cf.createMovie(props.catalog.id, patch);
    if (posterUrl) {
      try {
        await cf.setPictureFromUrl(created, posterUrl);
      } catch {
        /* text saved; poster is best-effort */
      }
    }
    await refresh();
    openDetail(created.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

function onDeleted() {
  // The movie is gone; clear any dirty flag so the Back below closes cleanly
  // instead of the guard re-prompting for edits that no longer have a target.
  detailRef.value?.discard();
  void refresh();
  goBack(); // pops the detail history level and closes it
}
</script>

<style scoped>
/* Two-pane workspace: list left, detail right. List panel capped at 620px and
   floored at 320px, tracking 42% — identical to the self-hosted .panel-list.
   minmax(0, 1fr) floors the single row at 0 so it stays viewport-sized and the
   DataTable's flex scroll body stays scrollable/virtualized. */
.workspace {
  display: grid;
  grid-template-columns: clamp(320px, 42%, 620px) 1fr;
  grid-template-rows: minmax(0, 1fr);
  height: 100dvh;
  overflow: hidden;
}
.pane-detail { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

/* Mobile: single column; the detail slides over the full screen when a row is picked. */
@media (max-width: 760px) {
  .workspace { grid-template-columns: 1fr; }
  .pane-detail {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--c-bg);
    display: none;
  }
  .workspace.has-detail .pane-detail { display: block; }
}

/* Compress the PrimeVue DataTable to the ~52px row geometry and apply the row
   hover/selection styling by hand (selection is manual, via rowClass). Scoped
   :deep() is unlayered, so it wins over PrimeVue's `primevue` cascade layer.
   PrimeVue paints the row background on the <tr> (never the <td>), so the reset
   below is what the manual rules have to beat.

   Every manual rule keeps the full `.p-datatable-tbody > tr` shape on purpose:
   a bare `.amc-row-sel` ties the reset on class count but loses on its extra
   type selector, and `background: transparent` then swallowed the selected-row
   highlight entirely (hover survived only because :hover + :not() pushed it one
   class ahead). Same shape everywhere → source order decides, not arithmetic. */
:deep(.movie-dt .p-datatable-thead) { display: none; }
:deep(.movie-dt .p-datatable-tbody > tr) { background: transparent; }
:deep(.movie-dt .p-datatable-tbody > tr > td) {
  padding: 0 4px;
  border: none;
  border-bottom: 1px solid var(--c-border);
  height: 52px;
}
:deep(.movie-dt .p-datatable-tbody > tr.amc-row) { cursor: pointer; transition: background 0.15s; }
:deep(.movie-dt .p-datatable-tbody > tr.amc-row:hover:not(.amc-row-sel)) { background: var(--c-elevated); }
:deep(.movie-dt .p-datatable-tbody > tr.amc-row-sel) { background: var(--c-gold-dim); }
</style>
