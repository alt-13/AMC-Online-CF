<!--
  CatalogImport.vue — upload an .amc file and import it into D1 + R2.

  The whole binary parse happens right here in the browser (importAmcFile);
  the Worker only ever receives small JSON chunks and individual posters.
  Drop this anywhere in the CF frontend; it emits `imported` with the new
  catalog id when done.
-->
<template>
  <div class="w-full">
    <label
      class="flex flex-col items-center justify-center gap-1.5 min-h-35 p-6 border-[1.5px] border-dashed border-border-hi rounded-lg bg-card text-text cursor-pointer transition-colors hover:border-gold"
      :class="{ 'cursor-default': busy }"
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
        <span class="text-3xl">🎬</span>
        <span class="text-[0.95rem] font-semibold">Drop an <code class="bg-elevated px-1.5 rounded">.amc</code> file here</span>
        <span class="text-xs text-muted text-center">or click to choose — parsed in your browser, never uploaded whole</span>
      </template>
      <template v-else>
        <span class="text-[0.95rem] font-semibold">{{ phaseLabel }}</span>
        <div class="w-4/5 h-2 rounded overflow-hidden bg-elevated relative">
          <div
            class="h-full bg-gold transition-[width] duration-200"
            :class="indeterminate ? 'w-[35%] animate-pulse' : ''"
            :style="indeterminate ? undefined : { width: pct + '%' }"
          />
        </div>
        <span v-if="!indeterminate" class="text-xs text-muted text-center">{{ done }} / {{ total }}</span>
      </template>
    </label>

    <p v-if="error" class="mt-2.5 text-danger text-sm">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { importAmcFile, session } from "./api";
import { withWakeLock } from "./wakelock";
import type { ImportPhase } from "../browser/import";

const emit = defineEmits<{ imported: [catalogId: string] }>();

const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const phase = ref<ImportPhase>("reading");
const done = ref(0);
const total = ref(0);
const error = ref("");

const pct = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0));
const indeterminate = computed(() => phase.value === "reading" || !total.value);
const phaseLabel = computed(() => {
  switch (phase.value) {
    case "reading": return "Reading file…";
    case "hashing": return "Preparing posters…";
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
        fallbackName: file.name.replace(/\.amc$/i, ""),
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
