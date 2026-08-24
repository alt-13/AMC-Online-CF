<!--
  MovieDetail.vue — edit one movie: poster (upload / from-URL / OMDb), every
  scalar field (grouped, honouring the per-user visibility settings), custom
  fields, plus delete. Explicit Save (PUT /api/movies/:id). Poster changes are
  binary side-effects and persist immediately; text edits wait for Save.

  Layout is a deliberate visual match of the self-hosted MovieForm.vue: the same
  header (inline poster + meta pills + rating badges + watched toggle + colour
  dot), the same two-column body in the same field order, and the same 4-column
  media grid — rebuilt on native controls (this build carries no PrimeVue) styled
  to match the themed PrimeVue look via the shared tokens.

  Not ported: the Extras editor. The Worker only writes extras on import
  (insertExtras); there is no PUT path to persist per-movie extra edits, so an
  editable accordion here would silently drop changes. Add a worker endpoint
  first, then the section.
-->
<template>
  <div class="movie-form">
    <div v-if="loading" class="loading-msg">Loading…</div>

    <template v-else>
      <!-- ── Header ── -->
      <div class="form-header">
        <div class="header-left">
          <!-- Poster panel (inline, 110×160) -->
          <div class="picture-panel">
            <div class="poster-wrap" @click="posterSrc ? (lightboxOpen = true) : triggerUpload()">
              <img v-if="posterSrc" :src="posterSrc" class="poster" alt="Movie poster" />
              <div v-else class="poster-placeholder">
                <i class="pi pi-image" />
                <span>Click to upload</span>
              </div>
              <div class="poster-overlay"><i :class="posterSrc ? 'pi pi-search-plus' : 'pi pi-upload'" /></div>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden-input"
              @change="onFile"
            />
            <div class="picture-actions">
              <button class="pic-btn" title="Upload poster" @click="triggerUpload">
                <i class="pi pi-upload" />
              </button>
              <button class="pic-btn" title="From URL" @click="fromUrl">
                <i class="pi pi-link" />
              </button>
              <button v-if="posterSrc" class="pic-btn danger" title="Remove poster" @click="removePoster">
                <i class="pi pi-trash" />
              </button>
            </div>
            <p v-if="posterMsg" class="poster-msg">{{ posterMsg }}</p>
          </div>

          <!-- Title + meta + ratings -->
          <div class="header-info">
            <h1 class="movie-title">{{ form.original_title || "Untitled" }}</h1>
            <p
              v-if="form.translated_title && form.translated_title !== form.original_title"
              class="movie-sub mobile-hide"
            >{{ form.translated_title }}</p>
            <div class="header-meta">
              <span v-if="form.year > 0" class="meta-tag">{{ form.year }}</span>
              <span v-if="form.category" class="meta-tag mobile-hide">{{ form.category }}</span>
              <span v-if="form.length > 0" class="meta-tag">{{ form.length }} min</span>
              <span v-if="form.director" class="meta-tag mobile-hide">Dir. {{ form.director }}</span>
            </div>
            <div class="ratings-row">
              <div v-if="form.rating > 0" class="rating-badge">
                <i class="pi pi-star-fill" />
                {{ (form.rating / 10).toFixed(1) }}
                <span class="rating-label">score</span>
              </div>
              <div v-if="form.user_rating > 0" class="rating-badge user">
                <i class="pi pi-user" />
                {{ (form.user_rating / 10).toFixed(1) }}
                <span class="rating-label">mine</span>
              </div>
              <div class="checked-toggle mobile-hide" @click="form.checked = form.checked ? 0 : 1">
                <i :class="form.checked ? 'pi pi-eye' : 'pi pi-eye-slash'" />
                <span>{{ form.checked ? "Watched" : "Unwatched" }}</span>
              </div>
              <div
                class="color-tag-badge mobile-hide"
                :style="{ background: colorOf(form.color_tag ?? 0) }"
                :title="colorNameOf(form.color_tag ?? 0)"
              />
            </div>
          </div>
        </div>

        <div class="header-actions">
          <button class="hbtn mobile-only" title="Back to list" @click="$emit('back')">
            <i class="pi pi-arrow-left" />
          </button>
          <button class="hbtn" title="Fetch from OMDb" @click="omdbOpen = true">
            <i class="pi pi-bolt" />
            <span class="hbtn-label">Fetch</span>
          </button>
          <button class="save-btn" :disabled="saving || !dirty" @click="save">
            <i v-if="saving" class="pi pi-spin pi-spinner" />
            {{ saving ? "Saving…" : dirty ? "Save" : "Saved ✓" }}
          </button>
          <button class="hbtn danger" title="Delete film" @click="deleteOpen = true">
            <i class="pi pi-trash" />
          </button>
        </div>
      </div>

      <!-- ── Body ── -->
      <div class="form-body">
        <div class="form-main">
          <!-- Left column -->
          <div class="col-left">
            <div class="field-row">
              <label class="field-label">Original Title</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.original_title" /></div>
            </div>
            <div class="field-row" v-show="showField('translated_title')">
              <label class="field-label">Translated Title</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.translated_title" /></div>
            </div>

            <!-- Crew fields alongside Actors -->
            <div
              class="crew-actors-row"
              v-show="showField('director') || showField('producer') || showField('writer') ||
                      showField('composer') || showField('actors')"
            >
              <div
                class="crew-stack"
                v-show="showField('director') || showField('producer') ||
                        showField('writer') || showField('composer')"
              >
                <div class="field-row" v-show="showField('director')">
                  <label class="field-label">Director</label>
                  <div class="field-control"><input type="text" class="full-width" v-model="form.director" /></div>
                </div>
                <div class="field-row" v-show="showField('producer')">
                  <label class="field-label">Producer</label>
                  <div class="field-control"><input type="text" class="full-width" v-model="form.producer" /></div>
                </div>
                <div class="field-row" v-show="showField('writer')">
                  <label class="field-label">Writer</label>
                  <div class="field-control"><input type="text" class="full-width" v-model="form.writer" /></div>
                </div>
                <div class="field-row" v-show="showField('composer')">
                  <label class="field-label">Composer</label>
                  <div class="field-control"><input type="text" class="full-width" v-model="form.composer" /></div>
                </div>
              </div>
              <div class="actors-stack" v-show="showField('actors')">
                <span class="inline-label">Actors</span>
                <textarea class="full-width actors-area" v-model="form.actors" />
              </div>
            </div>

            <div class="field-row" v-show="showField('category')">
              <label class="field-label">Category</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.category" /></div>
            </div>
            <div class="field-row" v-show="showField('country')">
              <label class="field-label">Country</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.country" /></div>
            </div>
            <div class="field-row" v-show="showField('url')">
              <label class="field-label">URL</label>
              <div class="field-control url-row">
                <input type="text" class="full-width" v-model="form.url" />
                <a v-if="form.url" :href="form.url" target="_blank" class="url-link">
                  <i class="pi pi-external-link" />
                </a>
              </div>
            </div>
            <div class="field-row align-top" v-show="showField('description')">
              <label class="field-label top-label">Description</label>
              <div class="field-control"><textarea class="full-width" rows="3" v-model="form.description" /></div>
            </div>
            <div class="field-row align-top comments-row" v-show="showField('comments')">
              <label class="field-label top-label">Comments</label>
              <div class="field-control"><textarea class="full-width" rows="2" v-model="form.comments" /></div>
            </div>
          </div>

          <!-- Right column -->
          <div class="col-right">
            <div class="field-row" v-show="showField('media')">
              <label class="field-label">Media</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.media" /></div>
            </div>
            <div class="field-row" v-show="showField('date')">
              <label class="field-label">Date Added</label>
              <div class="field-control">
                <input type="date" :value="delphiToInput(num('date'))"
                  @change="setDate('date', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('date_watched')">
              <label class="field-label">Date Watched</label>
              <div class="field-control">
                <input type="date" :value="delphiToInput(num('date_watched'))"
                  @change="setDate('date_watched', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('year')">
              <label class="field-label">Year</label>
              <div class="field-control">
                <input type="number" :value="numOrBlank('year')"
                  @input="setInt('year', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('length')">
              <label class="field-label">Length (min)</label>
              <div class="field-control">
                <input type="number" :value="numOrBlank('length')"
                  @input="setInt('length', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('rating')">
              <label class="field-label">Rating</label>
              <div class="field-control">
                <input type="number" step="0.1" min="0" max="10" :value="ratingDec('rating')"
                  @input="setRating('rating', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('user_rating')">
              <label class="field-label">My Rating</label>
              <div class="field-control">
                <input type="number" step="0.1" min="0" max="10" :value="ratingDec('user_rating')"
                  @input="setRating('user_rating', ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
            <div class="field-row" v-show="showField('certification')">
              <label class="field-label">Certification</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.certification" /></div>
            </div>
            <div class="field-row" v-show="showField('checked')">
              <label class="field-label">Watched</label>
              <div class="field-control">
                <label class="switch">
                  <input type="checkbox" :checked="!!form.checked"
                    @change="form.checked = ($event.target as HTMLInputElement).checked ? 1 : 0" />
                  <span class="slider" />
                </label>
              </div>
            </div>
            <div class="field-row" v-show="showField('color_tag')">
              <label class="field-label">Color Tag</label>
              <div class="field-control color-tag-control">
                <span class="dot" :style="{ background: colorOf(form.color_tag ?? 0) }" />
                <select class="full-width" v-model.number="form.color_tag">
                  <option v-for="(name, n) in COLOR_TAG_NAMES" :key="n" :value="Number(n)">{{ name }}</option>
                </select>
              </div>
            </div>
            <div class="field-row" v-show="showField('borrower')">
              <label class="field-label">Borrower</label>
              <div class="field-control"><input type="text" class="full-width" v-model="form.borrower" /></div>
            </div>
            <div class="field-row" v-show="showField('series_number')">
              <label class="field-label" title="Series grouping number — entries sharing the same number are listed as a series">Number (#)</label>
              <div class="field-control">
                <input type="number" min="0" v-model.number="form.number" />
              </div>
            </div>

            <!-- Custom fields -->
            <template v-if="defs.length > 0">
              <div class="mini-sep">Custom</div>
              <div
                v-for="def in defs"
                :key="def.tag"
                class="field-row"
                v-show="showField('custom_' + def.tag)"
              >
                <label class="field-label">{{ def.name || def.tag }}</label>
                <div class="field-control">
                  <label v-if="customTypeOf(def.tag) === 'ftBoolean'" class="switch">
                    <input type="checkbox" :checked="custom[def.tag] === '1'"
                      @change="custom[def.tag] = ($event.target as HTMLInputElement).checked ? '1' : '0'" />
                    <span class="slider" />
                  </label>
                  <input
                    v-else
                    class="full-width"
                    :type="customTypeOf(def.tag) === 'ftInteger' ? 'number' : 'text'"
                    v-model="custom[def.tag]"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- ── Media / Technical ── -->
        <div v-show="['media_type','source','disks','size','file_path','video_format',
                      'video_bitrate','resolution','framerate','audio_format',
                      'audio_bitrate','languages','subtitles'].some((k) => showField(k))">
          <div class="section-sep">Media</div>
          <div class="media-grid">
            <div class="media-col">
              <div class="field-row" v-show="showField('media_type')">
                <label class="field-label">Media Type</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.media_type" /></div>
              </div>
              <div class="field-row" v-show="showField('source')">
                <label class="field-label">Source</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.source" /></div>
              </div>
              <div class="field-row" v-show="showField('disks')">
                <label class="field-label">Disks</label>
                <div class="field-control">
                  <input type="number" :value="numOrBlank('disks')"
                    @input="setInt('disks', ($event.target as HTMLInputElement).value)" />
                </div>
              </div>
              <div class="field-row" v-show="showField('size')">
                <label class="field-label">Size</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.size" /></div>
              </div>
            </div>
            <div class="media-col">
              <div class="field-row" v-show="showField('file_path')">
                <label class="field-label">File Path</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.file_path" /></div>
              </div>
              <div class="field-row" v-show="showField('video_format')">
                <label class="field-label">Video Format</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.video_format" /></div>
              </div>
              <div class="field-row" v-show="showField('video_bitrate')">
                <label class="field-label">Video kbps</label>
                <div class="field-control">
                  <input type="number" :value="numOrBlank('video_bitrate')"
                    @input="setInt('video_bitrate', ($event.target as HTMLInputElement).value)" />
                </div>
              </div>
              <div class="field-row" v-show="showField('resolution')">
                <label class="field-label">Resolution</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.resolution" /></div>
              </div>
            </div>
            <div class="media-col">
              <div class="field-row" v-show="showField('framerate')">
                <label class="field-label">Framerate</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.framerate" /></div>
              </div>
              <div class="field-row" v-show="showField('audio_format')">
                <label class="field-label">Audio Format</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.audio_format" /></div>
              </div>
              <div class="field-row" v-show="showField('audio_bitrate')">
                <label class="field-label">Audio kbps</label>
                <div class="field-control">
                  <input type="number" :value="numOrBlank('audio_bitrate')"
                    @input="setInt('audio_bitrate', ($event.target as HTMLInputElement).value)" />
                </div>
              </div>
              <div class="field-row" v-show="showField('languages')">
                <label class="field-label">Languages</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.languages" /></div>
              </div>
            </div>
            <div class="media-col">
              <div class="field-row" v-show="showField('subtitles')">
                <label class="field-label">Subtitles</label>
                <div class="field-control"><input type="text" class="full-width" v-model="form.subtitles" /></div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Extras ── -->
        <div v-show="showField('extras')">
          <div class="section-sep extras-sep">
            <span>Extras</span>
            <button class="mini-btn" @click="addExtra"><i class="pi pi-plus" /> Add Extra</button>
          </div>
          <div v-if="!extras.length" class="no-extras">No extras yet.</div>
          <div v-else class="extras-accordion">
            <div v-for="(extra, idx) in extras" :key="idx" class="extra-panel">
              <div class="extra-header" @click="toggleExtra(idx)">
                <label class="switch" @click.stop>
                  <input type="checkbox" :checked="!!extra.checked"
                    @change="extra.checked = ($event.target as HTMLInputElement).checked ? 1 : 0" />
                  <span class="slider" />
                </label>
                <span class="extra-title">{{ extra.title || `Extra ${idx + 1}` }}</span>
                <span v-if="extra.tag" class="extra-tag-badge">{{ extra.tag }}</span>
                <button class="pic-btn danger extra-del" title="Remove extra" @click.stop="removeExtra(idx)">
                  <i class="pi pi-trash" />
                </button>
                <i class="pi extra-chevron" :class="openSet.has(idx) ? 'pi-chevron-down' : 'pi-chevron-right'" />
              </div>
              <div v-show="openSet.has(idx)" class="extra-content">
                <div class="section-cols">
                  <div class="col-fields">
                    <div class="group-label">Info</div>
                    <div class="field-row"><label class="field-label">Title</label><div class="field-control"><input type="text" class="full-width" v-model="extra.title" /></div></div>
                    <div class="field-row"><label class="field-label">Tag</label><div class="field-control"><input type="text" class="full-width" v-model="extra.tag" /></div></div>
                    <div class="field-row"><label class="field-label">Category</label><div class="field-control"><input type="text" class="full-width" v-model="extra.category" /></div></div>
                    <div class="field-row"><label class="field-label">URL</label><div class="field-control"><input type="text" class="full-width" v-model="extra.url" /></div></div>
                    <div class="field-row"><label class="field-label">Created By</label><div class="field-control"><input type="text" class="full-width" v-model="extra.created_by" /></div></div>
                  </div>
                  <div class="col-fields">
                    <div class="group-label">Notes</div>
                    <div class="field-row align-top"><label class="field-label top-label">Description</label><div class="field-control"><textarea class="full-width" rows="3" v-model="extra.description" /></div></div>
                    <div class="field-row align-top"><label class="field-label top-label">Comments</label><div class="field-control"><textarea class="full-width" rows="2" v-model="extra.comments" /></div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <p v-if="error" class="err">{{ error }}</p>

    <OmdbDialog
      v-if="omdbOpen"
      :initial-query="form.original_title"
      @close="omdbOpen = false"
      @apply="applyOmdb"
    />

    <ConfirmDialog
      v-if="deleteOpen"
      title="Delete film"
      :message="`Delete “${form.original_title || 'this movie'}”? This cannot be undone.`"
      confirm-label="Delete"
      cancel-label="Cancel"
      danger
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="deleteOpen = false"
    />

    <ConfirmDialog
      v-if="urlOpen"
      title="Poster from URL"
      message="Paste a direct link to an image. It will be fetched and stored as the poster."
      input
      input-type="url"
      input-placeholder="https://…"
      confirm-label="Fetch"
      cancel-label="Cancel"
      :busy="urlBusy"
      @confirm="submitUrl"
      @cancel="urlOpen = false"
    />

    <!-- Poster lightbox: click the inline poster to view it full-size. -->
    <Teleport to="body">
      <div v-if="lightboxOpen && posterSrc" class="lightbox" @click="lightboxOpen = false">
        <img :src="posterSrc" class="lightbox-img" alt="Movie poster" @click.stop />
        <button class="lightbox-close" title="Close" @click="lightboxOpen = false">
          <i class="pi pi-times" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onBeforeUnmount, nextTick } from "vue";
import { cf, session, type MovieRow, type CustomFieldDefRow, type Extra } from "./api";
import OmdbDialog from "./OmdbDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import {
  isVisible, parseCustom, delphiToInput, inputToDelphi, SENTINEL,
  COLOR_TAG_COLORS, COLOR_TAG_NAMES, type AppSettings,
} from "./fields";

const props = defineProps<{
  movieId: string;
  defs: CustomFieldDefRow[];
  settings: AppSettings;
}>();
const emit = defineEmits<{
  (e: "back"): void;
  (e: "deleted"): void;
  (e: "changed"): void;
  // Optimistic list sync: the fields the movie list renders, pushed on every
  // edit so the row mirrors the open form instantly — the same immediacy poster
  // changes already have. The parent re-applies this over a server refetch while
  // the detail is still dirty, so a poster-triggered refresh can't clobber
  // unsaved text (this was the OMDb-fetch bug: poster synced, title didn't).
  (e: "live", patch: Partial<MovieRow> & { id: string }): void;
}>();

const loading = ref(true);
const hydrating = ref(false); // suppresses the dirty watcher while load() populates the form
const saving = ref(false);
const dirty = ref(false);
const error = ref("");
const omdbOpen = ref(false);
const deleteOpen = ref(false);
const deleting = ref(false);
const urlOpen = ref(false);
const urlBusy = ref(false);
const lightboxOpen = ref(false);

const form = reactive({} as MovieRow);
const custom = reactive<Record<string, string>>({});
const extras = ref<Extra[]>([]);
const openSet = reactive(new Set<number>()); // which extra panels are expanded

const fileInput = ref<HTMLInputElement | null>(null);
const posterSrc = ref("");
const posterMsg = ref("");
let objectUrl = "";
// Bumped on every loadPoster() call. The component instance is reused across
// row switches (no :key remount), so several poster fetches can be in flight at
// once and — since they compete with the list's thumbnail fetches — resolve out
// of order. A stale response must not clobber the current movie's poster, so
// each call captures its generation and commits only while it is still latest.
let posterGen = 0;

const mode = ref<"desktop" | "mobile">(
  window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop",
);
const _mq = window.matchMedia("(max-width: 768px)");
const _mqListener = (e: MediaQueryListEvent) => { mode.value = e.matches ? "mobile" : "desktop"; };
_mq.addEventListener("change", _mqListener);

// Esc closes the poster lightbox.
const _escListener = (e: KeyboardEvent) => { if (e.key === "Escape") lightboxOpen.value = false; };
window.addEventListener("keydown", _escListener);

// Reload whenever the selected movie changes (the component instance is reused
// across row switches — no :key remount).
watch(() => props.movieId, load, { immediate: true });

onBeforeUnmount(() => {
  _mq.removeEventListener("change", _mqListener);
  window.removeEventListener("keydown", _escListener);
  window.removeEventListener("beforeunload", onBeforeUnload);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

async function load() {
  loading.value = true;
  hydrating.value = true;
  lightboxOpen.value = false;
  error.value = "";
  try {
    const m = await cf.getMovie(props.movieId);
    // Clear stale keys, then hydrate (reactive object is reused across reloads).
    for (const k of Object.keys(form)) delete (form as Record<string, unknown>)[k];
    Object.assign(form, m);
    for (const k of Object.keys(custom)) delete custom[k];
    Object.assign(custom, parseCustom(m));
    for (const d of props.defs) if (!(d.tag in custom)) custom[d.tag] = "";
    extras.value = (m.extras ?? []).map((e) => ({ ...e }));
    openSet.clear();
    // Show the form as soon as the metadata is in — don't gate it on the poster
    // bytes, which may still be queued behind the list's thumbnail fetches. The
    // poster fills in on its own a moment later.
    loading.value = false;
    void loadPoster(m.poster_key);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    loading.value = false;
  } finally {
    // Start clean; let the hydration mutations flush under `hydrating` so the
    // deep watcher below only flags real user edits afterwards.
    dirty.value = false;
    await nextTick();
    hydrating.value = false;
  }
}

async function loadPoster(key: string | null) {
  const gen = ++posterGen;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }
  posterSrc.value = "";
  if (!key) return;
  try {
    const url = await cf.posterObjectUrl(key);
    // A newer switch started while this fetch was in flight — drop the stale
    // result (freeing its bytes) instead of overwriting the current poster.
    if (gen !== posterGen) {
      URL.revokeObjectURL(url);
      return;
    }
    objectUrl = url;
    posterSrc.value = url;
  } catch {
    /* leave empty */
  }
}

// Flag edits (skips the initial hydrate — dirty is reset at end of load()).
watch([() => ({ ...form }), custom, extras], () => {
  if (!hydrating.value) dirty.value = true;
}, { deep: true });

// Push the list-visible fields to the parent on every change so the row updates
// live — matching how poster changes already appear at once. Guarded by
// `hydrating` (same as the dirty watcher) so a load / server-response sync
// doesn't emit; genuine edits do.
watch(
  () => ({
    original_title: form.original_title,
    translated_title: form.translated_title,
    year: form.year,
    rating: form.rating,
    checked: form.checked,
    color_tag: form.color_tag,
  }),
  (snap) => {
    if (!hydrating.value && form.id) emit("live", { id: form.id, ...snap });
  },
);

// --- extras editing ---------------------------------------------------------
function toggleExtra(i: number) {
  if (openSet.has(i)) openSet.delete(i);
  else openSet.add(i);
}
function addExtra() {
  extras.value.push({
    checked: 0, tag: "", title: "", category: "",
    url: "", description: "", comments: "", created_by: "",
  });
  openSet.add(extras.value.length - 1); // open the new one
}
function removeExtra(i: number) {
  extras.value.splice(i, 1);
  openSet.clear(); // indices shifted — collapse rather than mis-map open state
}

// --- field helpers ----------------------------------------------------------
const showField = (key: string) => isVisible(props.settings, key, mode.value);
const customTypeOf = (tag: string) =>
  props.defs.find((d) => d.tag === tag)?.field_type ?? "ftString";

function colorOf(tag: number): string {
  return COLOR_TAG_COLORS[tag] ?? "transparent";
}
function colorNameOf(tag: number): string {
  return COLOR_TAG_NAMES[tag] ?? "";
}

// --- numeric/date binding helpers ------------------------------------------
const num = (k: string) => Number((form as Record<string, unknown>)[k] ?? 0);
const numOrBlank = (k: string) => (num(k) === SENTINEL ? "" : num(k));
function setInt(k: string, v: string) {
  (form as Record<string, unknown>)[k] = v === "" ? SENTINEL : parseInt(v, 10) || 0;
}
function setDate(k: string, iso: string) {
  (form as Record<string, unknown>)[k] = inputToDelphi(iso);
  // Picking a watch date implies the film was watched — flip the flag so the
  // header toggle, the Watched switch, and the list's watched icon all agree.
  if (k === "date_watched" && iso) form.checked = 1;
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
// Returns true on success, false on failure — the unsaved-changes guard in the
// parent uses this to decide whether "Save & continue" may proceed.
async function save(): Promise<boolean> {
  saving.value = true;
  error.value = "";
  try {
    const patch: Partial<MovieRow> & { extras: Extra[] } = {
      ...form,
      custom_values: JSON.stringify(custom),
      sort_title: (form.translated_title || form.original_title).toLowerCase(),
      extras: extras.value,
    };
    const { extras: savedExtras, ...movieOnly } = await cf.updateMovie(form.id, patch);
    // Syncing the server response back into `form`/`extras` mutates the same
    // reactive sources the dirty watcher tracks, and that watcher runs on the
    // next flush (flush:'pre', async). Without this guard it refires *after* we
    // clear `dirty` and re-flags the form dirty, leaving the Save button active.
    // Mirror load(): suppress the watcher across the sync, clear it after flush.
    hydrating.value = true;
    Object.assign(form, movieOnly);
    extras.value = (savedExtras ?? []).map((e) => ({ ...e }));
    openSet.clear();
    dirty.value = false;
    emit("changed");
    await nextTick();
    hydrating.value = false;
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    saving.value = false;
  }
}

// Abandon in-flight edits. Every caller navigates away immediately after (a row
// switch reloads the form via the movieId watcher; a close unmounts the
// component), so clearing the flag is enough — the edited values are discarded
// with the view and never persisted.
function discard() {
  dirty.value = false;
}

// beforeunload guard: warn on a real page unload (tab close / reload / external
// nav) while there are unsaved text edits. Browsers only allow the native
// generic prompt here — no custom message or styled dialog is possible — but it
// fires only on actual unload, not on in-app row switches (those are guarded by
// the parent's ConfirmDialog). Poster edits persist immediately, so they never
// set `dirty` and never trigger this.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = ""; // required by Chrome to show the prompt
}
window.addEventListener("beforeunload", onBeforeUnload);

defineExpose({ dirty, save, discard });

async function confirmDelete() {
  deleting.value = true;
  try {
    await cf.deleteMovie(form.id);
    deleteOpen.value = false;
    emit("deleted");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}

// --- poster actions ---------------------------------------------------------
function triggerUpload() {
  fileInput.value?.click();
}

// Poster changes persist immediately (their own PUT/updateMovie), so syncing
// the local form must NOT flip the text form dirty. Suppress the watcher across
// the mutation and clear the flag only after it has flushed — same guard as
// save()/load(). Keep the window tight (just the mutation), not around the
// preceding network calls, so a concurrent field edit still registers.
//
// Mirror BOTH columns the server writes: poster_key and pic_path. Every poster
// updateMovie call sends pic_path=".jpg" when a key is present and "" when it's
// cleared (rule 4: embedded pictures must round-trip with a non-empty pic_path),
// so the in-memory form matches the D1 row after the write.
async function setPosterKeyQuietly(key: string | null) {
  hydrating.value = true;
  form.poster_key = key;
  form.pic_path = key ? ".jpg" : "";
  await nextTick();
  hydrating.value = false;
}

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
    await setPosterKeyQuietly(key);
    await loadPoster(key);
    posterMsg.value = "";
    emit("changed");
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (fileInput.value) fileInput.value.value = "";
  }
}

function fromUrl() {
  urlOpen.value = true;
}
async function submitUrl(url?: string) {
  const u = (url ?? "").trim();
  if (!u) {
    urlOpen.value = false;
    return;
  }
  // Keep the dialog open with a spinner while fetching; applyPosterUrl reports
  // any failure via posterMsg, so close afterwards either way.
  urlBusy.value = true;
  await applyPosterUrl(u);
  urlBusy.value = false;
  urlOpen.value = false;
}

async function removePoster() {
  if (!form.poster_key) return;
  posterMsg.value = "Removing…";
  try {
    await cf.updateMovie(form.id, { poster_key: null, pic_path: "" });
    await setPosterKeyQuietly(null);
    await loadPoster(null);
    posterMsg.value = "";
    emit("changed");
  } catch (e) {
    posterMsg.value = e instanceof Error ? e.message : String(e);
  }
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
    await setPosterKeyQuietly(updated.poster_key);
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
.movie-form {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--c-bg);
}
.loading-msg { padding: 2rem; color: var(--c-muted); font-size: 0.875rem; }

/* ── Header ── */
.form-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem 0.75rem;
  background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}
.header-left { display: flex; gap: 1rem; flex: 1; min-width: 0; }
.header-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.25rem;
}
.movie-title {
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--c-text);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
}
.movie-sub { font-size: 0.85rem; color: var(--c-muted); font-style: italic; margin: 0; }
.header-meta { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.meta-tag {
  font-size: 0.72rem;
  color: var(--c-muted);
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
}
.ratings-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.rating-badge {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  padding: 0.2rem 0.55rem;
  border-radius: 12px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--c-gold);
}
.rating-badge.user { color: #7ec8e3; }
.rating-badge .pi { font-size: 0.7rem; }
.rating-label { font-weight: 300; font-size: 0.7rem; color: var(--c-muted); }
.checked-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  color: var(--c-muted);
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  border-radius: 10px;
  border: 1px solid var(--c-border);
  transition: all 0.15s;
}
.checked-toggle:hover { border-color: var(--c-gold); color: var(--c-gold); }
.color-tag-badge {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  gap: 0.4rem;
  align-items: flex-start;
  flex-shrink: 0;
  padding-top: 0.25rem;
}
.hbtn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: transparent;
  color: var(--c-gold);
  border: 1px solid var(--c-gold);
  border-radius: 6px;
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background 0.15s;
}
.hbtn:hover { background: var(--c-gold-dim); }
.hbtn.danger { color: var(--c-danger); border-color: var(--c-danger); }
.hbtn.danger:hover { background: rgba(224,82,82,0.15); }
.save-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--c-gold);
  color: #0a0a14;
  border: 1px solid var(--c-gold);
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  font-family: var(--font-body);
  cursor: pointer;
}
.save-btn:hover:not(:disabled) { background: #dbb85a; }
.save-btn:disabled { opacity: 0.55; cursor: default; }
.mobile-only { display: none; }

/* ── Poster panel ── */
.picture-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  width: 110px;
  flex-shrink: 0;
}
.poster-wrap {
  position: relative;
  width: 110px;
  height: 160px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  cursor: pointer;
  transition: border-color 0.15s;
}
.poster-wrap:hover { border-color: var(--c-gold); }
.poster-wrap:hover .poster-overlay { opacity: 1; }
.poster { width: 100%; height: 100%; object-fit: cover; display: block; }
.poster-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  color: var(--c-muted);
  font-size: 0.7rem;
}
.poster-placeholder .pi { font-size: 1.4rem; }
.poster-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  color: #fff;
  font-size: 1.2rem;
}
.picture-actions { display: flex; gap: 0.15rem; }
.pic-btn {
  background: transparent;
  border: none;
  color: var(--c-muted);
  cursor: pointer;
  padding: 0.25rem;
  font-size: 0.85rem;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.pic-btn:hover { color: var(--c-gold); background: var(--c-elevated); }
.pic-btn.danger:hover { color: var(--c-danger); }
.poster-msg { font-size: 0.7rem; color: var(--c-muted); text-align: center; }
.hidden-input { display: none; }

/* ── Poster lightbox ── */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
  animation: lb-fade 0.15s ease;
}
.lightbox-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  cursor: default;
  animation: lb-pop 0.15s ease;
}
.lightbox-close {
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 50%;
  font-size: 1.1rem;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.lightbox-close:hover { background: rgba(0, 0, 0, 0.8); border-color: var(--c-gold); color: var(--c-gold); }
@keyframes lb-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes lb-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }

/* ── Scrollable body ── */
.form-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: clip;
  padding: 0.5rem 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* ── Two-column main ── */
.form-main {
  display: flex;
  gap: 0.75rem;
  align-items: stretch; /* left column stretches to the right column's height */
  min-width: 0;
  margin-bottom: 0.5rem; /* breathing room between Comments and the Media separator */
}
/* One flex box holding every left-hand field; it grows to fill the width left by
   the fixed-width right column, so all its fields share the same width. */
.col-left { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 0.18rem; }
.col-right { flex: 0 0 300px; min-width: 0; display: flex; flex-direction: column; gap: 0.18rem; }

/* ── Crew + Actors side-by-side ── */
.crew-actors-row { display: flex; flex-direction: row; gap: 0.5rem; align-items: stretch; }
.crew-stack { flex: 3; display: flex; flex-direction: column; gap: 0.18rem; }
.actors-stack { flex: 2; display: flex; flex-direction: column; gap: 0.18rem; min-width: 0; }
.inline-label { font-size: 0.78rem; color: var(--c-muted); display: block; padding-left: 0.1rem; }
.actors-area { flex: 1; resize: none; min-height: 90px; line-height: 1.4; }

/* ── Field layout ── */
.field-row { display: flex; align-items: center; gap: 0.35rem; min-height: 26px; }
.field-row.align-top { align-items: flex-start; }
/* Comments is the last row of the (usually shorter) left column: let it grow to
   fill the leftover vertical space so its bottom aligns with the right column.
   The align-items override needs to out-specify `.field-row.align-top` (which
   forces flex-start) or the field-control won't stretch and the textarea stays
   at its content height. */
.comments-row { flex: 1 1 auto; }
.field-row.align-top.comments-row { align-items: stretch; }
.comments-row .field-control { align-items: stretch; }
.comments-row textarea { height: 100%; min-height: 3rem; }
.field-label {
  flex: 0 0 100px;
  font-size: 0.78rem;
  color: var(--c-muted);
  text-align: right;
  padding-right: 0.25rem;
  white-space: nowrap;
}
.top-label { padding-top: 0.3rem; }
.field-control { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.4rem; }
.full-width { width: 100%; }
.url-row { display: flex; align-items: center; gap: 0.4rem; width: 100%; }
.url-link { color: var(--c-gold); font-size: 0.85rem; flex-shrink: 0; text-decoration: none; opacity: 0.8; transition: opacity 0.15s; }
.url-link:hover { opacity: 1; }

/* ── Native controls, themed to match the self-hosted PrimeVue look ── */
/* .actors-area lives outside a .field-control (it sits in .actors-stack), so it
   is listed explicitly or it would fall back to the browser's default textarea. */
.actors-area,
.field-control input[type="text"],
.field-control input[type="number"],
.field-control input[type="date"],
.field-control select,
.field-control textarea {
  /* Without border-box, `width: 100%` is the CONTENT width and padding+border are
     added on top, so every control overflowed its container to the right (the
     Actors textarea spilling past .actors-stack was the visible symptom). */
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 0.4rem 0.55rem;
  background: var(--c-elevated);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-family: var(--font-body);
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.actors-area:focus,
.field-control input:focus,
.field-control select:focus,
.field-control textarea:focus {
  border-color: var(--c-gold);
  box-shadow: 0 0 0 1px var(--c-gold);
}
.field-control textarea { resize: vertical; line-height: 1.4; }
.field-control input[type="date"] { color-scheme: dark; }

/* Color-tag select with a leading swatch */
.color-tag-control { display: flex; align-items: center; gap: 0.4rem; }
.color-tag-control .dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.15); flex-shrink: 0; }

/* ── Toggle switch (Watched + boolean custom fields) ── */
.switch { position: relative; display: inline-block; width: 38px; height: 20px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--c-elevated);
  border: 1px solid var(--c-border);
  border-radius: 20px;
  transition: background 0.15s, border-color 0.15s;
}
.switch .slider::before {
  content: "";
  position: absolute;
  height: 14px;
  width: 14px;
  left: 2px;
  top: 2px;
  background: var(--c-muted);
  border-radius: 50%;
  transition: transform 0.15s, background 0.15s;
}
.switch input:checked + .slider { background: var(--c-gold-dim); border-color: var(--c-gold); }
.switch input:checked + .slider::before { transform: translateX(18px); background: var(--c-gold); }

/* ── Separators ── */
.mini-sep {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--c-muted);
  padding-top: 0.35rem;
  margin-top: 0.2rem;
  border-top: 1px solid var(--c-border);
}
.section-sep {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--c-muted);
  margin-top: 0.3rem;
}
.section-sep::after { content: ""; flex: 1; height: 1px; background: var(--c-border); }

/* ── Media grid ── */
.media-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.18rem 0.75rem; align-items: start; }
.media-col { min-width: 0; display: flex; flex-direction: column; gap: 0.18rem; }
.media-col .field-label { flex: 0 0 75px; }

/* ── Extras (collapsible accordion) ── */
.extras-sep { justify-content: space-between; }
.extras-sep::after { display: none; }
.mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  background: transparent;
  color: var(--c-gold);
  border: 1px solid var(--c-gold);
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.72rem;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background 0.15s;
}
.mini-btn:hover { background: var(--c-gold-dim); }
.no-extras { color: var(--c-muted); font-size: 0.875rem; padding: 0.5rem 0; }
.extras-accordion { display: flex; flex-direction: column; gap: 4px; margin-top: 0.3rem; }
.extra-panel { border: 1px solid var(--c-border); border-radius: var(--radius); overflow: hidden; }
.extra-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  background: var(--c-elevated);
  cursor: pointer;
  transition: background 0.15s;
}
.extra-header:hover { background: var(--c-border); }
.extra-title {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.extra-tag-badge {
  font-size: 0.7rem;
  background: var(--c-gold-dim);
  color: var(--c-gold);
  padding: 0.1rem 0.4rem;
  border-radius: 8px;
  border: 1px solid rgba(201,168,76,0.3);
}
.extra-del { color: var(--c-muted); }
.extra-chevron { color: var(--c-muted); font-size: 0.7rem; }
.extra-content { padding: 0.75rem 0.6rem; background: var(--c-card); }
.section-cols {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1.25rem;
  align-items: start;
}
.col-fields { display: flex; flex-direction: column; gap: 0.18rem; }
.group-label {
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--c-muted);
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--c-border);
  margin-bottom: 0.4rem;
}

.err { color: var(--c-danger); font-size: 0.82rem; padding: 0.5rem 1.25rem; }

/* ── Mobile ── */
@media (max-width: 768px) {
  .form-header { padding: 0.5rem 0.75rem; max-height: 20vh; overflow: hidden; align-items: center; }
  .mobile-hide { display: none !important; }
  .mobile-only { display: inline-flex; }
  .header-actions { flex-direction: column; gap: 0.3rem; align-items: center; }
  .header-left { flex-direction: row; align-items: center; gap: 0.5rem; overflow: hidden; }
  .poster-wrap { width: 48px !important; height: 70px !important; flex-shrink: 0; }
  .picture-actions, .poster-msg { display: none; }
  .header-info { overflow: hidden; }
  .movie-title { font-size: 1rem; }
  .form-body { padding: 0.5rem 0.5rem 1rem; }
  .form-main { flex-direction: column; }
  .col-left, .col-right { flex: 0 0 auto; }
  .crew-actors-row { flex-direction: column; }
  .field-row { flex-direction: column; align-items: stretch; gap: 0.15rem; min-height: unset; }
  .field-row.align-top { align-items: stretch; }
  .field-label { flex: 0 0 auto; text-align: left; padding-right: 0; white-space: normal; }
  .top-label { padding-top: 0; }
  .media-grid { grid-template-columns: 1fr 1fr; }
}
</style>
