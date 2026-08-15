<!--
  CatalogImport.vue — upload an .amc file and import it into D1 + R2.

  The whole binary parse happens right here in the browser (importAmcFile);
  the Worker only ever receives small JSON chunks and individual posters.
  Drop this anywhere in the CF frontend; it emits `imported` with the new
  catalog id when done.
-->
<template>
  <div class="import-card">
    <label
      class="dropzone"
      :class="{ busy }"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <input
        ref="fileInput"
        type="file"
        accept=".amc"
        hidden
        @change="onPick"
      />
      <template v-if="!busy">
        <span class="dz-icon">🎬</span>
        <span class="dz-title">Drop an <code>.amc</code> file here</span>
        <span class="dz-sub">or click to choose — parsed in your browser, never uploaded whole</span>
      </template>
      <template v-else>
        <span class="dz-title">{{ phaseLabel }}</span>
        <div class="bar" :class="{ indet: indeterminate }">
          <div class="bar-fill" :style="indeterminate ? undefined : { width: pct + '%' }" />
        </div>
        <span v-if="!indeterminate" class="dz-sub">{{ done }} / {{ total }}</span>
      </template>
    </label>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { importAmcFile, session } from "./api";
import { withWakeLock } from "./wakelock";

const emit = defineEmits<{ imported: [catalogId: string] }>();

const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const phase = ref<"reading" | "posters" | "rows">("reading");
const done = ref(0);
const total = ref(0);
const error = ref("");

const pct = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0));
const indeterminate = computed(() => phase.value === "reading" || !total.value);
const phaseLabel = computed(() => {
  switch (phase.value) {
    case "reading": return "Reading file…";
    case "posters": return "Uploading posters…";
    default: return "Importing movies…";
  }
});

function onPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void run(file);
}

function onDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0];
  if (file) void run(file);
}

async function run(file: File) {
  if (busy.value) return;
  error.value = "";
  busy.value = true;
  phase.value = "reading";
  done.value = 0;
  total.value = 0;
  try {
    const catalogId = await withWakeLock(() =>
      importAmcFile(file, {
        ...session(),
        onProgress: (d, t, ph) => {
          phase.value = ph;
          done.value = d;
          total.value = t;
        },
      }),
    );
    emit("imported", catalogId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}
</script>

<style scoped>
.import-card { width: 100%; }
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 140px;
  padding: 1.5rem;
  border: 1.5px dashed var(--c-border-hi, #3a3a60);
  border-radius: var(--radius, 8px);
  background: var(--c-card, #181828);
  color: var(--c-text, #e8e0d5);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone:hover { border-color: var(--c-gold, #c9a84c); }
.dropzone.busy { cursor: default; }
.dz-icon { font-size: 1.8rem; }
.dz-title { font-size: 0.95rem; font-weight: 600; }
.dz-title code { background: var(--c-elevated, #1f1f38); padding: 0 0.3rem; border-radius: 4px; }
.dz-sub { font-size: 0.78rem; color: var(--c-muted, #7e7a90); text-align: center; }
.bar {
  width: 80%;
  height: 8px;
  background: var(--c-elevated, #1f1f38);
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill { height: 100%; background: var(--c-gold, #c9a84c); transition: width 0.2s; }
.bar.indet { position: relative; }
.bar.indet .bar-fill { width: 35%; animation: indet 1.1s ease-in-out infinite; }
@keyframes indet {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.err { margin-top: 0.6rem; color: var(--c-danger, #e05252); font-size: 0.82rem; }
</style>
