<!--
  CatalogsView.vue — the top-level CF screen: import a new .amc, list the
  tenant's catalogs, and export any of them back to a downloadable .amc.

  This is the "First import/export" deliverable end to end. Wire it as a route
  or drop it into App.vue for the CF deployment.
-->
<template>
  <!-- drilled into one library -->
  <MovieListView v-if="openCatalog" :catalog="openCatalog" @back="goBack" />

  <div v-else class="max-w-160 mx-auto px-4 py-6 flex flex-col gap-4">
    <h2 class="font-display text-gold text-xl">Your libraries</h2>

    <CatalogImport @imported="onImported" />
    <CloudSync @imported="onImported" />

    <div v-if="loading" class="text-muted text-sm">Loading…</div>
    <div v-else-if="!catalogs.length" class="text-muted text-sm">
      No libraries yet — import an <code class="bg-elevated px-1.5 rounded">.amc</code> file above to get started.
    </div>

    <ul v-else class="list-none flex flex-col gap-2 p-0 m-0">
      <li v-for="c in catalogs" :key="c.id"
          class="flex items-center justify-between gap-x-4 gap-y-3 flex-wrap p-3 px-4 bg-card border border-border rounded-lg cursor-pointer hover:border-gold"
          @click="openCatalog = c">
        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
          <span class="font-semibold text-text truncate">{{ c.name || "(untitled)" }}</span>
          <span class="text-xs text-muted">v{{ (c.version / 10).toFixed(1) }} · updated {{ fmt(c.updated_at) }}</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <Button
            v-if="c.source_ref"
            outlined
            size="small"
            :disabled="!!busyId"
            :label="busyId === c.id && busyKind === 'sync' ? busyLabel : 'Sync ↑'"
            @click.stop="onSync(c)"
          />
          <Button
            size="small"
            :disabled="!!busyId"
            :label="busyId === c.id && busyKind === 'export' ? busyLabel : 'Export'"
            @click.stop="onExport(c)"
          />
          <Button
            outlined
            severity="danger"
            size="small"
            :disabled="deletingId === c.id"
            :label="deletingId === c.id ? 'Deleting…' : 'Delete'"
            @click.stop="onDelete(c)"
          />
        </div>
      </li>
    </ul>

    <p v-if="error" class="text-danger text-sm basis-full">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import CatalogImport from "./CatalogImport.vue";
import CloudSync from "./CloudSync.vue";
import MovieListView from "./MovieListView.vue";
import { cf, downloadAmcFile, session, type CatalogRow } from "./api";
import { cloudSession, syncCatalogToOrigin, pushAdoptingOrigin, switchProvider, CloudLoginRequiredError, cloudSettings } from "./cloud";
import { pushView, goBack } from "./nav";

// Remember the last library the user opened and jump straight back into it on
// load, instead of making them pick every time (the single-catalog Unraid app
// always showed the one catalog; this is the multi-catalog equivalent).
const LAST_KEY = "amc:lastCatalog";

const catalogs = ref<CatalogRow[]>([]);
const openCatalog = ref<CatalogRow | null>(null);
const loading = ref(true);
const error = ref("");
const deletingId = ref<string | null>(null);

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    catalogs.value = await cf.listCatalogs();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function onImported() {
  void refresh();
}

const busyId = ref<string | null>(null);
const busyKind = ref<"sync" | "export" | null>(null);
const busyLabel = ref("");

/** Origin catalog: push back to where it came from. */
async function onSync(c: CatalogRow) {
  if (busyId.value) return;
  busyId.value = c.id;
  busyKind.value = "sync";
  busyLabel.value = "Building…";
  error.value = "";
  try {
    await syncCatalogToOrigin(c, (d, t) => {
      busyLabel.value = t ? `Posters ${d}/${t}` : "Uploading…";
    });
    busyLabel.value = "Done ✓";
    await new Promise((r) => setTimeout(r, 1200));
  } catch (e) {
    if (e instanceof CloudLoginRequiredError) {
      await switchProvider(e.provider).catch(() => {});
      error.value = `Connect ${e.provider} in the Cloud sync panel above, then press Sync again.`;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    busyId.value = null;
    busyKind.value = null;
    busyLabel.value = "";
  }
}

/** No-origin catalog: ask Download vs Upload-to-cloud. Download = local .amc;
 *  Upload = push to a chosen path on the active provider and adopt an origin. */
async function onExport(c: CatalogRow) {
  if (busyId.value) return;
  if (c.source_ref) {
    // Already has an origin: plain local download (Sync ↑ handles cloud).
    await downloadLocal(c);
    return;
  }
  const toCloud = confirm(
    `Export "${c.name || "(untitled)"}":\n\nOK = upload to your cloud provider\nCancel = download the .amc file`,
  );
  if (!toCloud) {
    await downloadLocal(c);
    return;
  }
  if (!cloudSession.connected) {
    error.value = "Connect a provider in the Cloud sync panel above, then press Export again.";
    return;
  }
  const provider = cloudSession.provider;
  const suggested = cloudSettings.providers[provider]?.path || `/${(c.name || "catalog")}.amc`;
  const dest = prompt(`Upload path on ${provider}:`, suggested);
  if (dest === null) return;
  busyId.value = c.id;
  busyKind.value = "export";
  busyLabel.value = "Building…";
  error.value = "";
  try {
    const ref = await pushAdoptingOrigin(c, provider, dest.trim(), (d, t) => {
      busyLabel.value = t ? `Posters ${d}/${t}` : "Uploading…";
    });
    try {
      await cf.setSourceRef(c.id, ref);
    } catch {
      try {
        await cf.setSourceRef(c.id, ref); // one retry for a transient blip
      } catch {
        error.value =
          `Uploaded to ${provider}, but couldn't save the origin. Re-export to the SAME path to avoid a duplicate.`;
      }
    }
    await refresh(); // re-list so the row now shows Sync ↑
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
    busyKind.value = null;
    busyLabel.value = "";
  }
}

async function downloadLocal(c: CatalogRow) {
  busyId.value = c.id;
  busyKind.value = "export";
  busyLabel.value = "Building…";
  error.value = "";
  try {
    await downloadAmcFile(c.id, c.name || "catalog", {
      ...session(),
      onProgress: (d, t) => {
        busyLabel.value = t ? `Posters ${d}/${t}` : "Building…";
      },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
    busyKind.value = null;
    busyLabel.value = "";
  }
}

async function onDelete(c: CatalogRow) {
  if (deletingId.value) return;
  if (!confirm(`Delete "${c.name || "(untitled)"}" and all its movies and posters? This cannot be undone.`)) {
    return;
  }
  deletingId.value = c.id;
  error.value = "";
  try {
    await cf.deleteCatalog(c.id);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    deletingId.value = null;
  }
}

function fmt(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

// Persist whichever catalog is open so the next visit reopens it, and push a
// history entry when one opens so the OS Back button returns here (libraries).
const catalogCloser = () => (openCatalog.value = null);
watch(openCatalog, (c, prev) => {
  if (c && !prev) pushView(catalogCloser);
  try {
    if (c) localStorage.setItem(LAST_KEY, c.id);
  } catch {
    /* storage unavailable */
  }
});

onMounted(async () => {
  await refresh();
  // Auto-open the remembered library on first load (only if it still exists).
  let lastId: string | null = null;
  try {
    lastId = localStorage.getItem(LAST_KEY);
  } catch {
    /* ignore */
  }
  if (lastId && !openCatalog.value) {
    const last = catalogs.value.find((c) => c.id === lastId);
    if (last) openCatalog.value = last;
  }
});
</script>
