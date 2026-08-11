<!--
  MovieDetail.vue — edit one movie: poster (upload / from-URL / OMDb), every
  scalar field (grouped, honouring the per-user visibility settings), custom
  fields, plus delete. Explicit Save (PUT /api/movies/:id). Poster changes are
  binary side-effects and persist immediately; text edits wait for Save.
-->
<template>
  <div class="detail">
    <div class="bar">
      <button class="ghost" @click="$emit('back')">← Back</button>
      <span class="crumb">#{{ form.number }} · {{ form.original_title || "Untitled" }}</span>
      <div class="bar-actions">
        <button class="ghost" @click="omdbOpen = true">⚡ Fetch</button>
        <button class="danger" @click="onDelete">🗑 Delete</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : dirty ? "Save" : "Saved ✓" }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="muted pad">Loading…</div>
    <div v-else class="grid">
      <!-- poster -->
      <div class="poster-col">
        <div class="poster">
          <img v-if="posterSrc" :src="posterSrc" alt="poster" />
          <div v-else class="poster-empty">No poster</div>
        </div>
        <div class="poster-actions">
          <label class="ghost file">
            Upload…
            <input type="file" accept="image/*" hidden @change="onFile" />
          </label>
          <button class="ghost" @click="fromUrl">From URL…</button>
        </div>
        <p v-if="posterMsg" class="muted small">{{ posterMsg }}</p>
      </div>

      <!-- fields -->
      <div class="fields-col">
        <template v-for="sec in sections" :key="sec.key">
          <div v-if="sectionHasVisible(sec)" class="sec-title">{{ sec.label }}</div>
          <template v-for="f in sec.fields" :key="f.key">
            <div v-if="showField(f.key)" class="row" :class="{ top: isMultiline(f.key) }">
              <label>{{ f.label }}</label>
              <!-- custom field -->
              <template v-if="f.key.startsWith('custom_')">
                <input
                  v-if="customType(f.key) === 'ftBoolean'"
                  type="checkbox"
                  :checked="custom[customTag(f.key)] === '1'"
                  @change="custom[customTag(f.key)] = ($event.target as HTMLInputElement).checked ? '1' : '0'"
                />
                <input
                  v-else
                  v-model="custom[customTag(f.key)]"
                  :type="customType(f.key) === 'ftInteger' ? 'number' : 'text'"
                />
              </template>
              <!-- scalar fields -->
              <input v-else-if="isDate(f.key)" type="date" :value="delphiToInput(num(f.key))"
                @change="setDate(f.key, ($event.target as HTMLInputElement).value)" />
              <input v-else-if="isBool(f.key)" type="checkbox"
                :checked="!!form[f.key as keyof MovieRow]"
                @change="(form as any)[f.key] = ($event.target as HTMLInputElement).checked ? 1 : 0" />
              <select v-else-if="f.key === 'color_tag'" v-model.number="(form as any).color_tag">
                <option v-for="(name, n) in COLOR_TAG_NAMES" :key="n" :value="Number(n)">{{ name }}</option>
              </select>
              <input v-else-if="f.key === 'rating' || f.key === 'user_rating'" type="number"
                step="0.1" min="0" max="10" :value="ratingDec(f.key)"
                @input="setRating(f.key, ($event.target as HTMLInputElement).value)" />
              <input v-else-if="isInteger(f.key)" type="number" :value="numOrBlank(f.key)"
                @input="setInt(f.key, ($event.target as HTMLInputElement).value)" />
              <textarea v-else-if="isMultiline(f.key)" rows="3" v-model="(form as any)[f.key]" />
              <input v-else type="text" v-model="(form as any)[f.key]" />
            </div>
          </template>
        </template>
      </div>
    </div>

    <p v-if="error" class="err pad">{{ error }}</p>

    <OmdbDialog
      v-if="omdbOpen"
      :initial-query="form.original_title"
      @close="omdbOpen = false"
      @apply="applyOmdb"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { cf, session, type MovieRow, type CustomFieldDefRow } from "./api";
import OmdbDialog from "./OmdbDialog.vue";
import {
  sectionsFor, isVisible, parseCustom, delphiToInput, inputToDelphi,
  DATE_FIELDS, BOOL_FIELDS, INTEGER_FIELDS, MULTILINE, SENTINEL,
  COLOR_TAG_NAMES, type AppSettings,
} from "./fields";

const props = defineProps<{
  movieId: string;
  defs: CustomFieldDefRow[];
  settings: AppSettings;
}>();
const emit = defineEmits<{ (e: "back"): void; (e: "deleted"): void; (e: "changed"): void }>();

const loading = ref(true);
const saving = ref(false);
const dirty = ref(false);
const error = ref("");
const omdbOpen = ref(false);

const form = reactive({} as MovieRow);
const custom = reactive<Record<string, string>>({});

const posterSrc = ref("");
const posterMsg = ref("");
let objectUrl = "";

const mode = computed<"desktop" | "mobile">(() =>
  window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop",
);
const sections = computed(() => sectionsFor(props.defs));

onMounted(load);
onBeforeUnmount(() => objectUrl && URL.revokeObjectURL(objectUrl));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const m = await cf.getMovie(props.movieId);
    Object.assign(form, m);
    Object.assign(custom, parseCustom(m));
    for (const d of props.defs) if (!(d.tag in custom)) custom[d.tag] = "";
    await loadPoster(m.poster_key);
    // Start clean; the deep watcher below flags real edits.
    dirty.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadPoster(key: string | null) {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }
  posterSrc.value = "";
  if (!key) return;
  try {
    objectUrl = await cf.posterObjectUrl(key);
    posterSrc.value = objectUrl;
  } catch {
    /* leave empty */
  }
}

// Flag edits (skips the initial hydrate — dirty is reset at end of load()).
watch([() => ({ ...form }), custom], () => {
  if (!loading.value) dirty.value = true;
}, { deep: true });

// --- field-type predicates (thin wrappers so the template stays readable) ---
const showField = (key: string) => isVisible(props.settings, key, mode.value);
const isDate = (k: string) => DATE_FIELDS.has(k);
const isBool = (k: string) => BOOL_FIELDS.has(k);
const isInteger = (k: string) => INTEGER_FIELDS.has(k);
const isMultiline = (k: string) => MULTILINE.has(k);
const sectionHasVisible = (sec: { fields: { key: string }[] }) =>
  sec.fields.some((f) => showField(f.key));

const customTag = (fieldKey: string) => fieldKey.slice("custom_".length);
const customType = (fieldKey: string) =>
  props.defs.find((d) => d.tag === customTag(fieldKey))?.field_type ?? "ftString";

// --- numeric/date binding helpers ------------------------------------------
const num = (k: string) => Number((form as Record<string, unknown>)[k] ?? 0);
const numOrBlank = (k: string) => (num(k) === SENTINEL ? "" : num(k));
function setInt(k: string, v: string) {
  (form as Record<string, unknown>)[k] = v === "" ? SENTINEL : parseInt(v, 10) || 0;
}
function setDate(k: string, iso: string) {
  (form as Record<string, unknown>)[k] = inputToDelphi(iso);
}
const ratingDec = (k: string) => {
  const v = num(k);
  return v > 0 ? v / 10 : "";
};
function setRating(k: string, v: string) {
  const f = parseFloat(v);
  (form as Record<string, unknown>)[k] = v !== "" && f > 0 ? Math.round(f * 10) : SENTINEL;
}

// --- save / delete ----------------------------------------------------------
async function save() {
  saving.value = true;
  error.value = "";
  try {
    const patch: Partial<MovieRow> = {
      ...form,
      custom_values: JSON.stringify(custom),
      sort_title: (form.translated_title || form.original_title).toLowerCase(),
    };
    const updated = await cf.updateMovie(form.id, patch);
    Object.assign(form, updated);
    dirty.value = false;
    emit("changed");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function onDelete() {
  if (!confirm(`Delete "${form.original_title || "this movie"}"? This cannot be undone.`)) return;
  try {
    await cf.deleteMovie(form.id);
    emit("deleted");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// --- poster actions ---------------------------------------------------------
async function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  posterMsg.value = "Uploading…";
  try {
    const key = form.poster_key ?? `${session().tenantId}/${form.catalog_id}/${form.id}.jpg`;
    // Re-encode to JPEG in the browser, then store + point the movie at it.
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const jpeg = await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer();
    await putPoster(key, new Uint8Array(jpeg));
    await cf.updateMovie(form.id, { poster_key: key, pic_path: ".jpg" });
    form.poster_key = key;
    await loadPoster(key);
    posterMsg.value = "";
    emit("changed");
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function fromUrl() {
  const url = prompt("Image URL:");
  if (!url) return;
  await applyPosterUrl(url);
}

async function putPoster(key: string, bytes: Uint8Array) {
  const s = session();
  const res = await fetch("/api/import/poster", {
    method: "PUT",
    headers: {
      "x-poster-key": key,
      "content-type": "application/octet-stream",
      ...(s.authHeader ? { authorization: s.authHeader } : {}),
      "x-tenant-id": s.tenantId,
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`store poster -> ${res.status}`);
}

async function applyPosterUrl(url: string) {
  posterMsg.value = "Fetching…";
  try {
    const updated = await cf.setPictureFromUrl({ ...form } as MovieRow, url);
    form.poster_key = updated.poster_key;
    await loadPoster(updated.poster_key);
    posterMsg.value = "";
    emit("changed");
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  }
}

// --- OMDb apply -------------------------------------------------------------
async function applyOmdb(patch: Partial<MovieRow>, posterUrl: string) {
  Object.assign(form, patch);
  dirty.value = true;
  if (posterUrl) await applyPosterUrl(posterUrl);
}
</script>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 0.75rem; max-width: 900px; margin: 0 auto; padding: 1rem; }
.bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.crumb { flex: 1; min-width: 0; font-weight: 600; color: var(--c-text, #e8e0d5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-actions { display: flex; gap: 0.4rem; }
.grid { display: grid; grid-template-columns: 200px 1fr; gap: 1.25rem; align-items: start; }
.poster-col { display: flex; flex-direction: column; gap: 0.5rem; }
.poster { aspect-ratio: 2/3; background: var(--c-elevated, #1f1f38); border: 1px solid var(--c-border, #2a2a48); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.poster img { width: 100%; height: 100%; object-fit: cover; }
.poster-empty { color: var(--c-muted, #7e7a90); font-size: 0.85rem; }
.poster-actions { display: flex; gap: 0.4rem; }
.poster-actions .ghost, .file { flex: 1; text-align: center; }
.file { cursor: pointer; }
.fields-col { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.sec-title { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--c-muted, #7e7a90); border-top: 1px solid var(--c-border, #2a2a48); padding-top: 0.5rem; margin-top: 0.3rem; }
.row { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 0.5rem; min-height: 30px; }
.row.top { align-items: start; }
.row label { font-size: 0.78rem; color: var(--c-muted, #7e7a90); text-align: right; }
.row input[type="text"], .row input[type="number"], .row input[type="date"], .row select, .row textarea {
  width: 100%; padding: 0.35rem 0.5rem; background: var(--c-elevated, #1f1f38); color: var(--c-text, #e8e0d5);
  border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; font: inherit; font-size: 0.85rem;
}
.row input[type="checkbox"] { justify-self: start; accent-color: var(--c-gold, #c9a84c); }
.row textarea { resize: vertical; }
button, .file { background: transparent; border: 1px solid var(--c-border, #2a2a48); border-radius: 6px; padding: 0.4rem 0.7rem; font-size: 0.8rem; color: var(--c-text, #e8e0d5); cursor: pointer; }
button.primary { background: var(--c-gold, #c9a84c); color: #0a0a14; border: none; font-weight: 600; }
button.danger { color: var(--c-danger, #e05252); border-color: var(--c-danger, #e05252); }
button:disabled { opacity: 0.6; cursor: default; }
.muted { color: var(--c-muted, #7e7a90); font-size: 0.9rem; }
.small { font-size: 0.75rem; }
.pad { padding: 0.5rem; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; }
@media (max-width: 768px) {
  .grid { grid-template-columns: 1fr; }
  .poster { max-width: 160px; }
  .row { grid-template-columns: 1fr; gap: 0.15rem; }
  .row label { text-align: left; }
}
</style>
