<!--
  MovieListView.vue — the movies inside one catalog, as a two-pane workspace that
  mirrors the Unraid app: a virtual-scrolled TABLE on the left (color tag · poster
  thumb · title/translated · year · rating · watched), the edit form on the right.
  On a phone the detail slides over the full screen.

  Two things make a 2880-row catalog usable: virtual scrolling (only the visible
  rows are in the DOM) and lazy thumbnails (a poster is fetched only when its row
  scrolls into view — never all at once).
-->
<template>
  <div class="workspace" :class="{ 'has-detail': selectedId }">
    <!-- LEFT: list -->
    <section class="pane-list">
      <div class="bar">
        <button class="ghost" @click="$emit('back')">← Libraries</button>
        <span class="title">{{ catalog.name || "(untitled)" }}</span>
        <div class="bar-actions">
          <button class="ghost" @click="settingsOpen = true">⚙ Fields</button>
          <button class="ghost" @click="omdbOpen = true">⚡ Fetch → new</button>
          <button class="primary" :disabled="creating" @click="onCreate()">+ New</button>
        </div>
      </div>

      <input v-model="q" class="search" :placeholder="searchPlaceholder" />

      <div v-if="loading" class="muted pad">Loading…</div>
      <div v-else-if="!filtered.length" class="muted pad">
        {{ q ? "No matches." : "No movies yet — add one with “+ New”." }}
      </div>

      <!-- virtual-scrolled table -->
      <div v-else ref="scroller" class="table" @scroll.passive="onScroll">
        <div class="spacer" :style="{ height: totalH + 'px' }">
          <div class="window" :style="{ transform: `translateY(${offsetY}px)` }">
            <button
              v-for="m in visible"
              :key="m.id"
              class="trow"
              :class="{ sel: m.id === selectedId }"
              @click="select(m.id)"
            >
              <span class="c-color" :style="{ background: colorOf(m.color_tag) }" />
              <span class="c-thumb">
                <img v-if="thumbs[m.id]" :src="thumbs[m.id]" :alt="m.original_title" />
                <span v-else class="ph">🎬</span>
              </span>
              <span class="c-title">
                <span class="t1">{{ m.original_title || m.translated_title || "Untitled" }}</span>
                <span
                  v-if="m.translated_title && m.translated_title !== m.original_title"
                  class="t2"
                >{{ m.translated_title }}</span>
              </span>
              <span class="c-year">{{ m.year > 0 ? m.year : "" }}</span>
              <span class="c-rating">{{ m.rating > 0 ? (m.rating / 10).toFixed(1) : "" }}</span>
              <span class="c-watched">{{ m.checked ? "👁" : "" }}</span>
            </button>
          </div>
        </div>
      </div>

      <footer class="count">{{ filtered.length }} / {{ movies.length }} films and series</footer>
      <p v-if="error" class="err">{{ error }}</p>
    </section>

    <!-- RIGHT: detail (overlays on mobile) -->
    <section class="pane-detail">
      <MovieDetail
        v-if="selectedId"
        :movie-id="selectedId"
        :defs="defs"
        :settings="settings"
        @back="selectedId = null"
        @deleted="onDeleted"
        @changed="refresh"
      />
      <div v-else class="placeholder muted">Select a movie to view or edit it.</div>
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
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import {
  cf, settings as settingsApi, type CatalogRow, type MovieRow, type CustomFieldDefRow,
} from "./api";
import MovieDetail from "./MovieDetail.vue";
import SettingsDialog from "./SettingsDialog.vue";
import OmdbDialog from "./OmdbDialog.vue";
import { DEFAULT_SETTINGS, type AppSettings } from "./fields";

const props = defineProps<{ catalog: CatalogRow }>();
defineEmits<{ (e: "back"): void }>();

const movies = ref<MovieRow[]>([]);
const defs = ref<CustomFieldDefRow[]>([]);
const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
const loading = ref(true);
const error = ref("");
const q = ref("");
const selectedId = ref<string | null>(null);
const creating = ref(false);
const settingsOpen = ref(false);
const omdbOpen = ref(false);

const thumbs = reactive<Record<string, string>>({});
const objectUrls: string[] = [];

const searchPlaceholder = computed(() =>
  settings.value.search_field ? `Search ${settings.value.search_field}…` : "Search…",
);

// Client-side filter over the already-ordered list (order comes from the server:
// by number, then title). "" searches a few common columns; a column name limits
// to that field; "custom_TAG" searches that custom value.
const filtered = computed(() => {
  const term = q.value.trim().toLowerCase();
  if (!term) return movies.value;
  const field = settings.value.search_field;
  return movies.value.filter((m) => haystack(m, field).includes(term));
});

function haystack(m: MovieRow, field: string): string {
  if (!field) {
    return [m.original_title, m.translated_title, m.director, m.actors, m.category]
      .join(" ")
      .toLowerCase();
  }
  if (field.startsWith("custom_")) {
    try {
      const cv = JSON.parse(m.custom_values || "{}") as Record<string, string>;
      return String(cv[field.slice(7)] ?? "").toLowerCase();
    } catch {
      return "";
    }
  }
  return String((m as Record<string, unknown>)[field] ?? "").toLowerCase();
}

// --- virtual scroll --------------------------------------------------------
const ROW_H = 52;
const BUFFER = 8;
const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(700);

const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - BUFFER));
const visibleCount = computed(() => Math.ceil(viewportH.value / ROW_H) + BUFFER * 2);
const end = computed(() => Math.min(filtered.value.length, start.value + visibleCount.value));
const visible = computed(() => filtered.value.slice(start.value, end.value));
const totalH = computed(() => filtered.value.length * ROW_H);
const offsetY = computed(() => start.value * ROW_H);

function onScroll() {
  if (scroller.value) scrollTop.value = scroller.value.scrollTop;
}
function measure() {
  if (scroller.value) viewportH.value = scroller.value.clientHeight || 700;
}

// A new search resets the scroll to the top so you don't land mid-list.
watch(q, () => {
  scrollTop.value = 0;
  if (scroller.value) scroller.value.scrollTop = 0;
});

// Lazy thumbnails: fetch a poster only for rows currently visible.
const requested = new Set<string>();
watch(visible, (rows) => {
  for (const m of rows) void ensureThumb(m);
});
async function ensureThumb(m: MovieRow) {
  if (!m.poster_key || thumbs[m.id] || requested.has(m.id)) return;
  requested.add(m.id);
  try {
    const url = await cf.posterObjectUrl(m.poster_key);
    thumbs[m.id] = url;
    objectUrls.push(url);
  } catch {
    requested.delete(m.id); // let it retry if the row scrolls back
  }
}

// --- AMC colour tags (0 = none) --------------------------------------------
const TAG_COLORS = [
  "", "#d64545", "#d68a45", "#d6c445", "#8ac445", "#45c48a",
  "#45c4c4", "#4587c4", "#4550c4", "#8a45c4", "#c445a8", "#7a5230", "#9aa0a6",
];
function colorOf(tag: number): string {
  return TAG_COLORS[tag] ?? "";
}

// --- lifecycle -------------------------------------------------------------
let ro: ResizeObserver | null = null;
onMounted(async () => {
  await load();
  await nextTick();
  measure();
  if (typeof ResizeObserver !== "undefined" && scroller.value) {
    ro = new ResizeObserver(measure);
    ro.observe(scroller.value);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
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

async function refresh() {
  movies.value = await cf.listMovies(props.catalog.id);
}

function select(id: string) {
  selectedId.value = id;
}

async function onCreate(patch: Partial<MovieRow> = {}) {
  creating.value = true;
  error.value = "";
  try {
    const created = await cf.createMovie(props.catalog.id, patch);
    await refresh();
    selectedId.value = created.id; // jump straight into the editor
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
    selectedId.value = created.id;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = false;
  }
}

function onDeleted() {
  selectedId.value = null;
  void refresh();
}
</script>

<style scoped>
/* Two-pane workspace: list left, detail right (Unraid layout). */
.workspace {
  display: grid;
  grid-template-columns: minmax(340px, 42%) 1fr;
  height: 100dvh;
  overflow: hidden;
}
.pane-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--c-border, #2a2a48);
  padding: 0.75rem;
  gap: 0.6rem;
}
.pane-detail { min-width: 0; overflow-y: auto; }
.placeholder { display: flex; align-items: center; justify-content: center; height: 100%; }

.bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.title { flex: 1; min-width: 0; font-family: var(--font-display, serif); color: var(--c-gold, #c9a84c); font-size: 1.1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.search { padding: 0.5rem 0.7rem; background: var(--c-elevated, #1f1f38); color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; }

/* virtual table */
.table { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid var(--c-border, #2a2a48); border-radius: 8px; background: var(--c-card, #181828); }
.spacer { position: relative; width: 100%; }
.window { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.trow {
  display: grid;
  grid-template-columns: 4px 30px 1fr auto auto auto;
  align-items: center;
  gap: 0.6rem;
  height: 52px;
  width: 100%;
  padding: 0 0.7rem 0 0;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--c-border, #2a2a48);
  color: var(--c-text, #e8e0d5);
  text-align: left;
  cursor: pointer;
}
.trow:hover { background: var(--c-elevated, #1f1f38); }
.trow.sel { background: color-mix(in srgb, var(--c-gold, #c9a84c) 18%, transparent); }
.c-color { align-self: stretch; width: 4px; }
.c-thumb { width: 30px; height: 44px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--c-elevated, #1f1f38); border-radius: 3px; }
.c-thumb img { width: 100%; height: 100%; object-fit: cover; }
.c-thumb .ph { font-size: 0.9rem; opacity: 0.4; }
.c-title { min-width: 0; display: flex; flex-direction: column; line-height: 1.15; }
.t1 { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t2 { font-size: 0.72rem; color: var(--c-muted, #7e7a90); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-year { font-size: 0.78rem; color: var(--c-muted, #7e7a90); font-variant-numeric: tabular-nums; }
.c-rating { font-size: 0.8rem; color: var(--c-gold, #c9a84c); font-variant-numeric: tabular-nums; min-width: 1.8rem; text-align: right; }
.c-watched { font-size: 0.85rem; width: 1.2rem; text-align: center; }

.count { font-size: 0.72rem; color: var(--c-muted, #7e7a90); padding: 0 0.2rem; }
.muted { color: var(--c-muted, #7e7a90); font-size: 0.9rem; }
.pad { padding: 1rem 0.2rem; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; }
button.ghost { background: transparent; color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; padding: 0.4rem 0.7rem; font-size: 0.8rem; cursor: pointer; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; border-radius: 6px; padding: 0.4rem 0.8rem; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }

/* Mobile: single column; the detail slides over the full screen when a row is picked. */
@media (max-width: 760px) {
  .workspace { grid-template-columns: 1fr; }
  .pane-detail {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--c-bg, #0d0d17);
    display: none;
  }
  .workspace.has-detail .pane-detail { display: block; }
  .pane-list { border-right: none; height: 100dvh; }
}
</style>
