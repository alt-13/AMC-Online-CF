<!--
  MegaSync.vue — connect a Mega.nz account (in-browser, credentials never leave
  the tab) and import an .amc from it. The per-catalog "push to Mega" button
  lives in CatalogsView.vue and shares this component's connection via mega.ts.

  Emits `imported(catalogId)` after a successful pull so the parent can refresh.
-->
<template>
  <div class="mega">
    <div class="head">
      <span class="label">Mega.nz sync</span>
      <span v-if="state.connected" class="conn">· {{ state.email }}</span>
    </div>

    <!-- connect -->
    <form v-if="!state.connected" class="form" @submit.prevent="connect">
      <input
        v-model="email"
        type="email"
        placeholder="Mega email"
        autocomplete="username"
        required
      />
      <input
        v-model="password"
        type="password"
        placeholder="Mega password"
        autocomplete="current-password"
        required
      />
      <button class="btn" :disabled="busy">{{ busy ? "Connecting…" : "Connect" }}</button>
      <p class="hint">Stays in this browser tab — never saved, never sent to the server.</p>
    </form>

    <!-- connected -->
    <div v-else class="connected">
      <label class="pathrow">
        <span class="plabel">.amc path</span>
        <input
          v-model="path"
          type="text"
          placeholder="/Backups/movies.amc — or /Backups, or blank for root"
          spellcheck="false"
          autocapitalize="off"
          @keyup.enter="applyPath"
          @blur="applyPath"
        />
      </label>
      <label class="deeprow">
        <input type="checkbox" v-model="deep" @change="refresh" />
        search subfolders
      </label>

      <div class="bar">
        <button class="btn ghost" :disabled="busy" @click="applyPath">Refresh</button>
        <button class="btn ghost" @click="disconnect">Disconnect</button>
      </div>

      <ul v-if="files.length" class="files">
        <li v-for="f in files" :key="f.name" class="frow">
          <span class="fname" :title="f.name">{{ f.name }}</span>
          <span class="fsize">{{ human(f.size) }}</span>
          <button class="btn" :disabled="!!importing" @click="pull(f)">
            {{ importing === f.name ? importLabel : "Import" }}
          </button>
        </li>
      </ul>
      <p v-else class="hint">
        No <code>.amc</code> files {{ path ? `at "${path}"` : "at your Mega account root" }}.
      </p>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import {
  megaState as state,
  megaSettings,
  setMegaPath,
  megaConnect,
  megaDisconnect,
  megaListAmc,
  megaPull,
  type MegaAmcFile,
} from "./mega";

const emit = defineEmits<{ imported: [catalogId: string] }>();

const email = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const files = ref<MegaAmcFile[]>([]);
const importing = ref<string | null>(null);
const importLabel = ref("Import");
const path = ref(megaSettings.path);
const deep = ref(false);

async function connect() {
  busy.value = true;
  error.value = "";
  try {
    await megaConnect({ email: email.value, password: password.value });
    password.value = ""; // don't keep it in a reactive field longer than needed
    refresh();
  } catch (e) {
    error.value = msg(e);
  } finally {
    busy.value = false;
  }
}

function disconnect() {
  megaDisconnect();
  files.value = [];
  error.value = "";
}

function refresh() {
  error.value = "";
  try {
    files.value = megaListAmc(path.value, deep.value);
  } catch (e) {
    error.value = msg(e);
  }
}

/** Persist the path setting, then re-list from it. */
function applyPath() {
  const next = path.value.trim();
  path.value = next;
  setMegaPath(next);
  refresh();
}

async function pull(f: MegaAmcFile) {
  if (importing.value) return;
  importing.value = f.name;
  importLabel.value = "Downloading…";
  error.value = "";
  try {
    const id = await megaPull(f.node, (d, t, phase) => {
      importLabel.value = phase === "posters" ? `Posters ${d}/${t}` : `Rows ${d}/${t}`;
    });
    emit("imported", id);
  } catch (e) {
    error.value = msg(e);
  } finally {
    importing.value = null;
    importLabel.value = "Import";
  }
}

function human(n: number): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
</script>

<style scoped>
.mega {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem;
  background: var(--c-card, #181828);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px);
}
.head { display: flex; align-items: baseline; gap: 0.4rem; }
.label { font-weight: 600; color: var(--c-text, #e8e0d5); }
.conn { font-size: 0.78rem; color: var(--c-muted, #7e7a90); }
.form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.form input {
  flex: 1 1 12rem;
  min-width: 0;
  padding: 0.4rem 0.6rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.85rem;
}
.hint { flex-basis: 100%; margin: 0; font-size: 0.72rem; color: var(--c-muted, #7e7a90); }
.hint code { background: var(--c-elevated, #1f1f38); padding: 0 0.3rem; border-radius: 4px; }
.pathrow { display: flex; flex-direction: column; gap: 0.2rem; }
.plabel { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-muted, #7e7a90); }
.pathrow input {
  padding: 0.4rem 0.6rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.85rem;
}
.deeprow { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
.bar { display: flex; gap: 0.5rem; }
.files { list-style: none; display: flex; flex-direction: column; gap: 0.4rem; margin: 0.4rem 0 0; padding: 0; }
.frow { display: flex; align-items: center; gap: 0.6rem; }
.fname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text, #e8e0d5); font-size: 0.85rem; }
.fsize { font-size: 0.72rem; color: var(--c-muted, #7e7a90); flex: 0 0 auto; }
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
.btn.ghost { background: transparent; color: var(--c-gold, #c9a84c); border: 1px solid var(--c-border, #2a2a48); }
.btn:disabled { opacity: 0.7; cursor: default; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; margin: 0; }
</style>
