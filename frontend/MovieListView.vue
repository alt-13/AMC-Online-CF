<!--
  MovieListView.vue — the movies inside one catalog, as a two-pane workspace that
  mirrors the Unraid app: a virtual-scrolled TABLE on the left (color tag · poster
  thumb · title/translated · year · rating · watched), the edit form on the right.
  On a phone the detail slides over the full screen.

  The left pane is a byte-for-byte visual match of the self-hosted MovieList.vue
  (same fonts, tokens, row geometry, PrimeIcons glyphs, search bar, footer) — the
  only structural add is the catalog bar (back/title/fields/fetch), which the
  self-hosted app keeps in a global topbar this per-catalog view doesn't have.

  Two things make a 2880-row catalog usable: virtual scrolling (only the visible
  rows are in the DOM) and lazy thumbnails (a poster is fetched only when its row
  scrolls into view — never all at once).
-->
<template>
  <div class="workspace" :class="{ 'has-detail': selectedId }">
    <!-- LEFT: list -->
    <section class="movie-list">
      <!-- Catalog bar: back to libraries + name + field/fetch actions.
           (Self-hosted keeps these in a global topbar; this view is per-catalog.) -->
      <div class="catalog-bar">
        <button class="icon-btn" title="Back to libraries" @click="$emit('back')">
          <i class="pi pi-arrow-left" />
        </button>
        <span class="catalog-title">{{ catalog.name || "(untitled)" }}</span>
        <div class="bar-actions">
          <button class="icon-btn" title="Field settings" @click="settingsOpen = true">
            <i class="pi pi-cog" />
          </button>
          <button class="icon-btn" title="Fetch from OMDb → new film" @click="omdbOpen = true">
            <i class="pi pi-bolt" />
          </button>
        </div>
      </div>

      <!-- Toolbar: search + new (matches the self-hosted MovieList toolbar) -->
      <div class="list-toolbar">
        <div class="search-wrap">
          <i class="pi pi-search search-icon" />
          <input
            v-model="searchInput"
            class="search-input"
            placeholder="Search films…"
            type="text"
          />
          <button v-if="searchInput" class="search-clear" @click="searchInput = ''">
            <i class="pi pi-times" />
          </button>
        </div>
        <button
          class="new-btn"
          :disabled="creating"
          title="New film"
          @click="onCreate()"
        >
          <i class="pi pi-plus" />
        </button>
      </div>

      <!-- Table -->
      <div class="table-wrap">
        <div v-if="loading" class="state-msg">Loading catalog…</div>
        <div v-else-if="!filtered.length" class="state-msg">
          <i class="pi pi-search" />
          No films match "{{ q }}"
        </div>
        <div v-else ref="scroller" class="scroller" @scroll.passive="onScroll">
          <div class="spacer" :style="{ height: totalH + 'px' }">
            <div class="window" :style="{ transform: `translateY(${offsetY}px)` }">
              <button
                v-for="m in visible"
                :key="m.id"
                class="trow"
                :class="{ sel: m.id === selectedId }"
                @click="select(m.id)"
              >
                <span
                  class="color-dot"
                  :style="{ background: colorOf(m.color_tag) }"
                  :title="colorNameOf(m.color_tag)"
                />
                <span class="thumb-wrap">
                  <img v-if="thumbs[m.id]" :src="thumbs[m.id]" class="thumb" alt="" />
                  <span v-else class="thumb-placeholder"><i class="pi pi-image" /></span>
                </span>
                <span class="title-cell">
                  <span class="orig-title">{{ m.original_title || "—" }}</span>
                  <span
                    v-if="m.translated_title && m.translated_title !== m.original_title"
                    class="trans-title"
                  >{{ m.translated_title }}</span>
                </span>
                <span class="year-cell">{{ m.year > 0 ? m.year : "" }}</span>
                <span class="rating-cell">{{ m.rating > 0 ? (m.rating / 10).toFixed(1) : "" }}</span>
                <span class="watched-cell">
                  <i v-if="m.checked" class="pi pi-eye checked-icon" title="Watched" />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Count -->
      <div class="list-footer">{{ filtered.length }} / {{ movies.length }} films and series</div>
      <p v-if="error" class="err">{{ error }}</p>
    </section>

    <!-- RIGHT: detail (overlays on mobile) -->
    <section class="pane-detail">
      <MovieDetail
        v-if="selectedId"
        :movie-id="selectedId"
        :defs="defs"
        :settings="settings"
        @back="goBack"
        @deleted="onDeleted"
        @changed="refresh"
      />
      <div v-else class="placeholder">
        <div class="empty-icon">🎞</div>
        <p class="empty-title">No film selected</p>
        <p class="empty-sub">Select a film from the list or create a new one</p>
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
import { DEFAULT_SETTINGS, type AppSettings, COLOR_TAG_COLORS, COLOR_TAG_NAMES } from "./fields";
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

// Sort by number descending (newest first), matching the self-hosted list, then
// filter client-side over that order.
const sorted = computed(() => [...movies.value].sort((a, b) => b.number - a.number));

const filtered = computed(() => {
  const term = q.value.trim().toLowerCase();
  if (!term) return sorted.value;
  const field = settings.value.search_field;
  return sorted.value.filter((m) => haystack(m, field).includes(term));
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

// --- AMC colour tags (0 = none) — the shared palette from fields.ts ---------
function colorOf(tag: number): string {
  return COLOR_TAG_COLORS[tag] ?? "transparent";
}
function colorNameOf(tag: number): string {
  return COLOR_TAG_NAMES[tag] ?? "";
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

async function refresh() {
  movies.value = await cf.listMovies(props.catalog.id);
}

// Opening a movie is a history level so the OS Back button returns to the list
// (not out of the app). `detailCloser` is stable so hardware Back and the
// on-screen "← Back" both resolve to the same close.
const detailCloser = () => (selectedId.value = null);
function openDetail(id: string) {
  const wasOpen = selectedId.value !== null;
  selectedId.value = id;
  if (!wasOpen) pushView(detailCloser); // one level whether or not you switch rows
}
function select(id: string) {
  openDetail(id);
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
  void refresh();
  goBack(); // pops the detail history level and closes it
}
</script>

<style scoped>
/* Two-pane workspace: list left, detail right. List panel capped at 620px and
   floored at 320px, tracking 42% — identical to the self-hosted .panel-list. */
.workspace {
  display: grid;
  grid-template-columns: clamp(320px, 42%, 620px) 1fr;
  height: 100dvh;
  overflow: hidden;
}
.pane-detail { min-width: 0; overflow: hidden; display: flex; flex-direction: column; }

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--c-muted);
}
.empty-icon { font-size: 3rem; opacity: 0.4; }
.empty-title { font-family: var(--font-display); font-size: 1.1rem; color: var(--c-muted); }
.empty-sub { font-size: 0.85rem; }

/* ── List panel ── */
.movie-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
}

/* Catalog bar (per-catalog chrome) */
.catalog-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.catalog-title {
  flex: 1;
  min-width: 0;
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--c-gold);
  font-size: 1.05rem;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  transition: border-color 0.15s, color 0.15s;
}
.icon-btn:hover { border-color: var(--c-gold); color: var(--c-gold); }

/* Toolbar: search + new */
.list-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.search-wrap {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 0.6rem;
  font-size: 0.75rem;
  color: var(--c-muted);
  pointer-events: none;
}
.search-input {
  width: 100%;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  color: var(--c-text);
  padding: 0.4rem 1.8rem 0.4rem 1.8rem;
  border-radius: var(--radius);
  font-family: var(--font-body);
  font-size: 0.825rem;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--c-gold); }
.search-input::placeholder { color: var(--c-muted); }
.search-clear {
  position: absolute;
  right: 0.5rem;
  background: none;
  border: none;
  color: var(--c-muted);
  cursor: pointer;
  font-size: 0.7rem;
  padding: 0;
  line-height: 1;
}
.search-clear:hover { color: var(--c-text); }

.new-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--c-gold);
  border: 1px solid var(--c-gold);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s, color 0.15s;
}
.new-btn:hover { background: var(--c-gold-dim); }
.new-btn:disabled { opacity: 0.6; cursor: default; }

/* ── Virtual table ── */
.table-wrap { flex: 1; min-height: 0; overflow: hidden; }
.scroller { height: 100%; overflow-y: auto; overflow-x: hidden; }
.spacer { position: relative; width: 100%; }
.window { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }

.trow {
  display: grid;
  grid-template-columns: 4px 28px 1fr auto auto auto;
  align-items: center;
  gap: 0.6rem;
  height: 52px;
  width: 100%;
  padding: 0 0.75rem;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--c-border);
  color: var(--c-text);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}
.trow:hover:not(.sel) { background: var(--c-elevated); }
.trow.sel { background: var(--c-gold-dim); }

.color-dot {
  width: 4px;
  height: 32px;
  border-radius: 2px;
  flex-shrink: 0;
}
.thumb-wrap {
  width: 28px;
  height: 40px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--c-elevated);
  flex-shrink: 0;
}
.thumb { width: 100%; height: 100%; object-fit: cover; }
.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-border-hi);
  font-size: 0.7rem;
}

.title-cell {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
}
.orig-title {
  font-size: 0.845rem;
  font-weight: 500;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trans-title {
  font-size: 0.72rem;
  color: var(--c-muted);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.year-cell {
  font-size: 0.8rem;
  color: var(--c-muted);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.rating-cell {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--c-gold);
  font-variant-numeric: tabular-nums;
  min-width: 1.8rem;
  text-align: right;
}
.watched-cell { width: 1.2rem; text-align: center; }
.checked-icon { color: var(--c-success); font-size: 0.8rem; }

/* States */
.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem;
  color: var(--c-muted);
  font-size: 0.875rem;
}

.list-footer {
  padding: 0.35rem 0.75rem;
  font-size: 0.72rem;
  color: var(--c-muted);
  border-top: 1px solid var(--c-border);
  flex-shrink: 0;
}
.err { color: var(--c-danger); font-size: 0.82rem; padding: 0 0.75rem 0.35rem; }

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
  .movie-list { border-right: none; height: 100dvh; }
}
</style>
