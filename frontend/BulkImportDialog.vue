<!--
  BulkImportDialog.vue — paste a "title + year" list, and for each line: search
  IMDb, take the best match (bulk.ts `bestMatch`), fetch it from OMDb and create
  the film with its poster. Lines without a confident match, duplicates and
  failures are listed at the end (and can be copied back into the box to retry).
  The OMDb dialog's remembered unticked fields apply here too.
-->
<template>
  <Dialog
    :visible="true"
    modal
    header="Bulk add from IMDb / OMDb"
    :closable="!running"
    :style="{ width: '520px' }"
    :breakpoints="{ '760px': '95vw' }"
    @update:visible="(v: boolean) => { if (!v) emit('close'); }"
  >
    <template v-if="!started">
      <p class="text-xs text-muted m-0 mb-2">
        One film per line, title and year — e.g. <code>Heat (1995)</code>, <code>Alien, 1979</code>, <code>Up 2009</code>.
      </p>
      <Textarea v-model="text" autofocus rows="12" class="w-full font-mono text-[0.8rem]" placeholder="Heat (1995)&#10;Alien 1979" />
      <p v-if="error" class="text-danger text-sm m-0 mt-2">{{ error }}</p>
    </template>

    <template v-else>
      <ProgressBar :value="Math.round((done / Math.max(lines.length, 1)) * 100)" class="h-2 mb-2" :show-value="false" />
      <p class="text-sm m-0 mb-3">
        {{ done }} / {{ lines.length }} — <span class="text-gold">{{ added }} added</span>
        <template v-if="missed.length">, <span class="text-danger">{{ missed.length }} not added</span></template>
        <span v-if="running" class="text-muted"> · {{ current }}</span>
      </p>
      <div v-if="missed.length" class="max-h-[45vh] overflow-y-auto border border-border rounded-md">
        <div
          v-for="(m, i) in missed"
          :key="i"
          class="grid grid-cols-[1fr_auto] gap-2 py-1.5 px-2.5 border-b border-border last:border-b-0 text-sm"
        >
          <span class="truncate">{{ m.raw }}</span>
          <span class="text-xs text-muted">{{ m.reason }}</span>
        </div>
      </div>
    </template>

    <template #footer>
      <Button v-if="!started" label="Start" :disabled="!lines.length" @click="start" />
      <template v-else-if="running">
        <Button label="Stop" severity="secondary" :disabled="stopping" @click="stopping = true" />
      </template>
      <template v-else>
        <Button v-if="missed.length" label="Retry not added" text @click="retry" />
        <Button label="Close" @click="emit('close')" />
      </template>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import Dialog from "primevue/dialog";
import Textarea from "primevue/textarea";
import Button from "primevue/button";
import ProgressBar from "primevue/progressbar";
import { cf, omdb, type MovieRow } from "./api";
import { findDuplicate } from "./fields";
import { parseBulkList, bestMatch } from "./bulk";

const props = defineProps<{ catalogId: string; movies: MovieRow[]; duplicateField: string }>();
const emit = defineEmits<{ (e: "close"): void; (e: "changed", contentRev?: number): void }>();

const text = ref("");
const lines = computed(() => parseBulkList(text.value));
const started = ref(false);
const running = ref(false);
const stopping = ref(false);
const done = ref(0);
const added = ref(0);
const current = ref("");
const error = ref("");
const missed = ref<{ raw: string; reason: string }[]>([]);

// Same localStorage key OmdbDialog writes: the fields the user last unticked
// there (incl. "__poster__") are left out here too.
function excludedFields(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("amc_omdb_excluded_fields") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

async function start() {
  error.value = "";
  const key = await omdb.keyState().catch(() => null);
  if (!key?.hasKey) {
    error.value = "No OMDb API key — add a free key in Settings first.";
    return;
  }
  const excluded = excludedFields();
  const known = [...props.movies];
  started.value = running.value = true;
  done.value = added.value = 0;
  missed.value = [];
  let rev: number | undefined;

  // ponytail: one film at a time (gentle on OMDb's 1,000/day and keeps
  // next-number assignment ordered); a small runPool if long lists feel slow.
  for (const line of lines.value) {
    if (stopping.value) {
      missed.value.push({ raw: line.raw, reason: "stopped" });
      continue;
    }
    current.value = line.title;
    try {
      const pick = bestMatch(line, await omdb.search(line.title));
      if (!pick) {
        missed.value.push({ raw: line.raw, reason: "no match" });
        continue;
      }
      const res = await omdb.fetch(pick.tt);
      const patch = Object.fromEntries(
        Object.entries(res.patch).filter(([k]) => !excluded.has(k)),
      ) as Partial<MovieRow>;
      const dupe = findDuplicate(known, res.patch, props.duplicateField);
      if (dupe) {
        missed.value.push({ raw: line.raw, reason: `already in catalog (${pick.label})` });
        continue;
      }
      const created = await cf.createMovie(props.catalogId, patch);
      rev = created.content_rev ?? rev;
      known.push(created);
      if (res.poster_url && !excluded.has("__poster__")) {
        try {
          rev = (await cf.setPictureFromUrl(created, res.poster_url)).content_rev ?? rev;
        } catch {
          /* text saved; poster is best-effort, as in single create */
        }
      }
      added.value++;
    } catch (e) {
      missed.value.push({ raw: line.raw, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      done.value++;
    }
  }
  running.value = stopping.value = false;
  if (added.value) emit("changed", rev);
}

function retry() {
  text.value = missed.value.map((m) => m.raw).join("\n");
  started.value = false;
}
</script>
