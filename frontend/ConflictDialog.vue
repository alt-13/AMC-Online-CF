<!--
  ConflictDialog.vue — the explicit choice when a library AND its cloud .amc have
  both changed.

  There is no reliable auto-merge (the format has no movie id, and `number` is
  non-unique and user-editable — rule 12), so the user picks a side. The point of
  this dialog is that they pick it INFORMED:

    * the local half is free — a revision count and a touched-movie count;
    * the remote half needs the remote file downloaded and parsed, so it is
      opt-in behind a button. The bytes are cached, so choosing "Take remote"
      afterwards costs nothing extra.

  Spending a download to see what you are about to discard is a fair trade.
  Spending it unasked is not.
-->
<template>
  <Dialog
    :visible="true"
    modal
    :closable="!busy"
    header="Both sides have changed"
    :style="{ width: 'min(40rem, 92vw)' }"
    @update:visible="!busy && emit('close')"
  >
    <p class="text-sm text-muted mb-3">
      <strong class="text-text">{{ catalog.name || "(untitled)" }}</strong> has
      unsynced changes in the app, and its <code>.amc</code> on the cloud has
      also changed. There is no safe automatic merge — choose which side to keep.
    </p>

    <div class="flex flex-col gap-1 text-sm mb-4">
      <span>
        <i class="pi pi-desktop text-gold mr-1.5" />
        {{ pending }} unsynced change{{ pending === 1 ? "" : "s" }} in the app
        <span v-if="touched" class="text-muted">({{ touched }} film{{ touched === 1 ? "" : "s" }} touched)</span>
      </span>
      <span><i class="pi pi-cloud text-gold mr-1.5" />the cloud file no longer matches what was last pushed</span>
    </div>

    <div v-if="!diff" class="mb-4">
      <Button
        outlined
        size="small"
        :disabled="busy"
        :label="comparing ? compareLabel : 'Compare with remote…'"
        icon="pi pi-search"
        @click="onCompare()"
      />
      <p class="text-xs text-muted mt-1.5">
        Downloads and reads the cloud file so you can see what differs. The
        download is reused if you then keep the remote version.
      </p>
    </div>

    <div v-else class="mb-4 text-sm flex flex-col gap-1">
      <span>{{ diff.onlyRemote }} only in the cloud file<em v-if="diff.samples.onlyRemote.length" class="text-muted"> — {{ diff.samples.onlyRemote.join(", ") }}</em></span>
      <span>{{ diff.onlyLocal }} only in the app<em v-if="diff.samples.onlyLocal.length" class="text-muted"> — {{ diff.samples.onlyLocal.join(", ") }}</em></span>
      <span>{{ diff.differing }} differ<em v-if="diff.samples.differing.length" class="text-muted"> — {{ diff.samples.differing.join(", ") }}</em></span>
    </div>

    <p v-if="error" class="text-danger text-sm mb-3">{{ error }}</p>

    <template #footer>
      <Button text label="Cancel" :disabled="busy" @click="emit('close')" />
      <Button
        outlined
        severity="danger"
        :disabled="busy"
        :label="busy === 'remote' ? busyLabel : 'Take remote (discard my changes)'"
        @click="onTakeRemote()"
      />
      <Button
        severity="danger"
        :disabled="busy"
        :label="busy === 'mine' ? busyLabel : 'Push mine (overwrite the cloud)'"
        @click="onPushMine()"
      />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import { cf, type CatalogRow, type MovieRow } from "./api";
import { parseCatalog } from "../amc/parser";
import { detectEncoding, toReadable } from "../amc/transcode";
import { summarizeDiff, type DiffSummary } from "./syncdiff";
import {
  downloadOriginBytes, syncCatalogToOrigin, reimportFromOrigin,
} from "./cloud";

const props = defineProps<{ catalog: CatalogRow; localMovies: MovieRow[] }>();
const emit = defineEmits<{ (e: "close"): void; (e: "resolved"): void }>();

const pending = computed(() => Math.max(0, props.catalog.content_rev - props.catalog.synced_rev));
const touched = ref(0);
const diff = ref<DiffSummary | null>(null);
const remoteBytes = ref<Uint8Array | null>(null);
const comparing = ref(false);
const compareLabel = ref("Comparing…");
const busy = ref<"" | "mine" | "remote">("");
const busyLabel = ref("Working…");
const error = ref("");

// The touched-movie count is free on the server and makes the local half
// concrete ("5 films touched" beats "5 revisions").
void cf.catalogInfo(props.catalog.id)
  .then((info) => { touched.value = (info as { touched_since_sync?: number }).touched_since_sync ?? 0; })
  .catch(() => { /* the revision count alone is still useful */ });

async function onCompare() {
  comparing.value = true;
  error.value = "";
  try {
    const bytes = await downloadOriginBytes(props.catalog, (loaded, total) => {
      compareLabel.value = total
        ? `Comparing… ${Math.round((loaded / total) * 100)}%`
        : "Comparing…";
    });
    remoteBytes.value = bytes;
    // Read it the same way an import would, so titles match what the DB holds
    // (a legacy catalog's umlauts must go through the codepage — rule 5).
    const parsed = parseCatalog(bytes);
    const readable = toReadable(parsed, detectEncoding(parsed));
    diff.value = summarizeDiff(props.localMovies, readable.movies);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    comparing.value = false;
  }
}

async function onPushMine() {
  busy.value = "mine";
  error.value = "";
  try {
    // The push refuses a moved remote by design, so tell it this choice is
    // deliberate.
    await syncCatalogToOrigin(props.catalog, undefined, { force: true });
    emit("resolved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = "";
  }
}

async function onTakeRemote() {
  busy.value = "remote";
  error.value = "";
  try {
    // Reuse the compare download if there was one.
    await reimportFromOrigin(
      props.catalog,
      (done, total, phase) => { busyLabel.value = total ? `${phase} ${done}/${total}` : `${phase}…`; },
      remoteBytes.value ?? undefined,
    );
    emit("resolved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = "";
  }
}
</script>
