<!--
  CatalogsView.vue — the top-level CF screen: import a new .amc, list the
  tenant's catalogs, and export any of them back to a downloadable .amc.

  This is the "First import/export" deliverable end to end. Wire it as a route
  or drop it into App.vue for the CF deployment.
-->
<template>
  <div class="catalogs">
    <h2 class="title">Your libraries</h2>

    <CatalogImport @imported="onImported" />

    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="!catalogs.length" class="muted">
      No libraries yet — import an <code>.amc</code> file above to get started.
    </div>

    <ul v-else class="list">
      <li v-for="c in catalogs" :key="c.id" class="row">
        <div class="info">
          <span class="name">{{ c.name || "(untitled)" }}</span>
          <span class="sub">v{{ (c.version / 10).toFixed(1) }} · updated {{ fmt(c.updated_at) }}</span>
        </div>
        <div class="actions">
          <button
            class="btn"
            :disabled="exportingId === c.id"
            @click="onExport(c)"
          >
            {{ exportingId === c.id ? exportLabel : "Export .amc" }}
          </button>
        </div>
      </li>
    </ul>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import CatalogImport from "./CatalogImport.vue";
import { cf, downloadAmcFile, session, type CatalogRow } from "./api";

const catalogs = ref<CatalogRow[]>([]);
const loading = ref(true);
const error = ref("");
const exportingId = ref<string | null>(null);
const exportLabel = ref("Export .amc");

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

async function onExport(c: CatalogRow) {
  if (exportingId.value) return;
  exportingId.value = c.id;
  exportLabel.value = "Building…";
  error.value = "";
  try {
    await downloadAmcFile(c.id, c.name || "catalog", {
      ...session(),
      onProgress: (d, t) => {
        exportLabel.value = t ? `Posters ${d}/${t}` : "Building…";
      },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    exportingId.value = null;
    exportLabel.value = "Export .amc";
  }
}

function fmt(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

onMounted(refresh);
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
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--c-card, #181828);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px);
}
.info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.name { font-weight: 600; color: var(--c-text, #e8e0d5); }
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
}
.btn:disabled { opacity: 0.7; cursor: default; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; }
</style>
