<!--
  MovieListView.vue — the movies inside one catalog. Grid of poster thumbs with
  search + "New movie" + field-settings; clicking a row opens MovieDetail. Owns
  the catalog's custom-field defs and the per-user settings, passing both down.
-->
<template>
  <!-- editing one movie -->
  <MovieDetail
    v-if="selectedId"
    :movie-id="selectedId"
    :defs="defs"
    :settings="settings"
    @back="selectedId = null"
    @deleted="onDeleted"
    @changed="refresh"
  />

  <!-- the grid -->
  <div v-else class="movies">
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

    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="!filtered.length" class="muted">
      {{ q ? "No matches." : "No movies yet — add one with “+ New”." }}
    </div>

    <div v-else class="grid">
      <button v-for="m in filtered" :key="m.id" class="card" @click="selectedId = m.id">
        <div class="thumb">
          <img v-if="thumbs[m.id]" :src="thumbs[m.id]" :alt="m.original_title" loading="lazy" />
          <div v-else class="thumb-empty">🎬</div>
        </div>
        <div class="meta">
          <span class="name">{{ m.translated_title || m.original_title || "Untitled" }}</span>
          <span class="sub">
            <template v-if="m.year > 0">{{ m.year }}</template>
            <template v-if="m.rating > 0"> · ★ {{ (m.rating / 10).toFixed(1) }}</template>
          </span>
        </div>
      </button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <SettingsDialog
      v-if="settingsOpen"
      :defs="defs"
      @close="settingsOpen = false"
      @saved="settings = $event"
    />
    <OmdbDialog
      v-if="omdbOpen"
      @close="omdbOpen = false"
      @apply="createFromOmdb"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from "vue";
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

// Client-side filter. Respects settings.search_field ("" = a few common
// columns; a column name = just that field; "custom_TAG" = that custom value).
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

onMounted(load);
onBeforeUnmount(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)));

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
    void loadThumbs();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  movies.value = await cf.listMovies(props.catalog.id);
  void loadThumbs();
}

// Resolve poster object URLs with bounded concurrency so a large catalog doesn't
// fire one serial fetch after another (thousands of round-trips) or all at once.
async function loadThumbs() {
  const pending = movies.value.filter((m) => m.poster_key && !thumbs[m.id]);
  const CONCURRENCY = 6;
  let i = 0;
  async function worker() {
    while (i < pending.length) {
      const m = pending[i++];
      try {
        const url = await cf.posterObjectUrl(m.poster_key!);
        thumbs[m.id] = url;
        objectUrls.push(url);
      } catch {
        /* skip */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
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
  // Create the movie with the fetched text fields, then attach the poster.
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
.movies { max-width: 900px; margin: 0 auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
.bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.title { flex: 1; min-width: 0; font-family: var(--font-display, serif); color: var(--c-gold, #c9a84c); font-size: 1.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-actions { display: flex; gap: 0.4rem; }
.search { padding: 0.5rem 0.7rem; background: var(--c-elevated, #1f1f38); color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; }
.card { display: flex; flex-direction: column; gap: 0.4rem; padding: 0; background: var(--c-card, #181828); border: 1px solid var(--c-border, #2a2a48); border-radius: 8px; overflow: hidden; cursor: pointer; text-align: left; color: var(--c-text, #e8e0d5); }
.card:hover { border-color: var(--c-gold, #c9a84c); }
.thumb { aspect-ratio: 2/3; background: var(--c-elevated, #1f1f38); display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-empty { font-size: 2rem; opacity: 0.4; }
.meta { padding: 0 0.5rem 0.55rem; display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.name { font-size: 0.82rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 0.72rem; color: var(--c-muted, #7e7a90); }
.muted { color: var(--c-muted, #7e7a90); font-size: 0.9rem; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; }
button.ghost { background: transparent; color: var(--c-text, #e8e0d5); border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; padding: 0.4rem 0.7rem; font-size: 0.8rem; cursor: pointer; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; border-radius: 6px; padding: 0.4rem 0.8rem; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
</style>
