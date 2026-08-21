<!--
  CatalogsView.vue — the top-level CF screen: import a new .amc, list the
  tenant's catalogs, and export any of them back to a downloadable .amc.

  This is the "First import/export" deliverable end to end. Wire it as a route
  or drop it into App.vue for the CF deployment.
-->
<template>
  <!-- drilled into one library -->
  <MovieListView v-if="openCatalog" :catalog="openCatalog" @back="goBack" />

  <div v-else class="catalogs">
    <h2 class="title">Your libraries</h2>

    <CatalogImport @imported="onImported" />
    <CloudSync @imported="onImported" />

    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="!catalogs.length" class="muted">
      No libraries yet — import an <code>.amc</code> file above to get started.
    </div>

    <ul v-else class="list">
      <li v-for="c in catalogs" :key="c.id" class="row" @click="openCatalog = c">
        <div class="info">
          <span class="name">{{ c.name || "(untitled)" }}</span>
          <span class="sub">v{{ (c.version / 10).toFixed(1) }} · updated {{ fmt(c.updated_at) }}</span>
        </div>
        <div class="actions">
          <button
            v-if="c.source_ref"
            class="btn ghost"
            :disabled="busyId === c.id"
            @click.stop="onSync(c)"
          >
            {{ busyId === c.id ? busyLabel : "Sync ↑" }}
          </button>
          <button
            class="btn"
            :disabled="busyId === c.id"
            @click.stop="onExport(c)"
          >
            {{ busyId === c.id && !c.source_ref ? busyLabel : "Export" }}
          </button>
          <button
            class="btn ghost danger"
            :disabled="deletingId === c.id"
            @click.stop="onDelete(c)"
          >
            {{ deletingId === c.id ? "Deleting…" : "Delete" }}
          </button>
        </div>
      </li>
    </ul>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
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
const busyLabel = ref("");

/** Origin catalog: push back to where it came from. */
async function onSync(c: CatalogRow) {
  if (busyId.value) return;
  busyId.value = c.id;
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
  busyLabel.value = "Building…";
  error.value = "";
  try {
    const ref = await pushAdoptingOrigin(c, provider, dest.trim(), (d, t) => {
      busyLabel.value = t ? `Posters ${d}/${t}` : "Uploading…";
    });
    await cf.setSourceRef(c.id, ref);
    await refresh(); // re-list so the row now shows Sync ↑
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
    busyLabel.value = "";
  }
}

async function downloadLocal(c: CatalogRow) {
  busyId.value = c.id;
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

<style scoped>
.catalogs { max-width: 640px; margin: 0 auto; padding: 1.5rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
.title { font-family: var(--font-display, serif); color: var(--c-gold, #c9a84c); font-size: 1.3rem; }
.muted { color: var(--c-muted, #7e7a90); font-size: 0.9rem; }
.muted code { background: var(--c-elevated, #1f1f38); padding: 0 0.3rem; border-radius: 4px; }
.list { list-style: none; display: flex; flex-direction: column; gap: 0.5rem; }
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  flex-wrap: wrap;
  padding: 0.75rem 1rem;
  background: var(--c-card, #181828);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px);
  cursor: pointer;
}
.row:hover { border-color: var(--c-gold, #c9a84c); }
.info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1 1 auto; }
.name { font-weight: 600; color: var(--c-text, #e8e0d5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
.btn {
  background: var(--c-gold, #c9a84c);
  color: #0a0a14;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 0.8rem;
  font-weight: 600;
  font-size: 0.82rem;
  cursor: pointer;
  white-space: nowrap;
}
.btn.ghost { background: transparent; color: var(--c-gold, #c9a84c); border: 1px solid var(--c-border, #2a2a48); }
.btn.ghost.danger { color: var(--c-danger, #e05252); }
.btn.ghost.danger:hover { border-color: var(--c-danger, #e05252); }
.btn:disabled { opacity: 0.7; cursor: default; }
/* On a phone the three actions wrap under the name instead of overlapping it. */
.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; flex-basis: 100%; }
</style>
