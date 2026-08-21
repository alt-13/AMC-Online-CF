<!--
  CloudSync.vue — pick a cloud provider (header switcher), connect in-browser
  (credentials never leave the tab unless the user opts to remember them,
  encrypted at rest), and import an .amc from it. Connections are ephemeral:
  after a successful import the session is dropped (see cloud.ts). Per-catalog
  export/push lives in CatalogsView.vue and targets each catalog's own origin.

  Emits `imported(catalogId)` after a successful pull so the parent can refresh.
-->
<template>
  <div class="cloud">
    <div class="head">
      <span class="label">Cloud sync</span>
      <!-- provider switcher: relocating a wrong pick is one dropdown away -->
      <select class="switcher" :value="settings.active" @change="onSwitch">
        <option value="mega">Mega.nz</option>
        <option value="drive" disabled>Google Drive (soon)</option>
        <option value="dropbox" disabled>Dropbox (soon)</option>
        <option value="s3" disabled>S3 (soon)</option>
      </select>
      <span v-if="session.connected" class="conn">· {{ session.email }}</span>
      <div v-if="session.connected" class="headactions">
        <button v-if="active.hasCredential" class="btn ghost sm" @click="forget">
          Forget saved login
        </button>
        <button class="btn ghost sm" @click="disconnect">Disconnect</button>
      </div>
    </div>

    <!-- reconnecting from a stored credential -->
    <p v-if="!session.connected && reconnecting" class="hint">Reconnecting…</p>

    <!-- connect -->
    <form v-else-if="!session.connected" class="form" @submit.prevent="onConnect">
      <input v-model="email" type="email" placeholder="Email" autocomplete="username" required />
      <input
        v-model="password"
        type="password"
        placeholder="Password"
        autocomplete="current-password"
        required
      />
      <button class="btn" :disabled="busy">{{ busy ? "Connecting…" : "Connect" }}</button>
      <label class="rememberrow">
        <input type="checkbox" v-model="remember" />
        keep me signed in on this account (stored encrypted)
      </label>
      <p class="hint">
        {{ remember
          ? "Saved encrypted to your own server so you don't log in again — decrypted only in this browser to connect."
          : "Stays in this browser tab only — never saved, never sent to the server." }}
      </p>
    </form>

    <!-- connected -->
    <div v-else class="connected">
      <label class="pathrow">
        <span class="plabel">.amc file path</span>
        <input
          v-model="path"
          type="text"
          placeholder="/Backups/movies.amc — full path to the file (a folder or blank also works)"
          spellcheck="false"
          autocapitalize="off"
          @keyup.enter="applyPath"
          @blur="applyPath"
        />
        <span class="phelp">
          Point this at a specific file (recommended). Import reads it; push writes
          back to exactly this path.
        </span>
      </label>
      <label class="deeprow">
        <input type="checkbox" v-model="deep" @change="refresh" />
        search subfolders
      </label>

      <ul v-if="files.length" class="files">
        <li v-for="f in files" :key="f.name" class="frow">
          <span class="fname" :title="f.name">{{ f.name }}</span>
          <span class="fsize">{{ human(f.size) }}</span>
          <button class="btn" :disabled="!!importing" @click="pullFile(f)">
            {{ importing === f.name ? shortLabel : "Import" }}
          </button>
        </li>
      </ul>

      <div v-if="importing" class="progress">
        <div class="ptext">{{ phaseText }}</div>
        <div class="pbar" :class="{ indet: indeterminate }">
          <div class="pbar-fill" :style="indeterminate ? undefined : { width: pPct + '%' }" />
        </div>
      </div>
      <p v-else class="hint">
        No <code>.amc</code> files {{ path ? `at "${path}"` : "at your account root" }}.
      </p>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  cloudSession as session,
  cloudSettings as settings,
  saveActivePath,
  loadCloudConfig,
  connect,
  autoConnect,
  switchProvider,
  forgetCredential,
  disconnect as cloudDisconnect,
  listAmc,
  pull,
  type MegaAmcFile,
} from "./cloud";
import { withWakeLock } from "./wakelock";

const emit = defineEmits<{ imported: [catalogId: string] }>();

const email = ref("");
const password = ref("");
const remember = ref(false);
const busy = ref(false);
const reconnecting = ref(false);
const error = ref("");
const files = ref<MegaAmcFile[]>([]);
const importing = ref<string | null>(null);
const path = ref("");
const deep = ref(true);

const active = computed(() => settings.providers[settings.active] ?? { path: "", hasCredential: false });

type Phase = "download" | "reading" | "posters" | "rows" | "";
const phase = ref<Phase>("");
const pDone = ref(0);
const pTotal = ref(0);
const pPct = computed(() => (pTotal.value ? Math.round((pDone.value / pTotal.value) * 100) : 0));
const indeterminate = computed(() => phase.value === "reading" || (!pTotal.value && phase.value !== ""));
const phaseText = computed(() => {
  switch (phase.value) {
    case "download": return `Downloading ${human(pDone.value)} / ${human(pTotal.value)}`;
    case "reading": return "Reading file…";
    case "posters": return `Posters ${pDone.value} / ${pTotal.value}`;
    case "rows": return `Importing ${pDone.value} / ${pTotal.value}`;
    default: return "Starting…";
  }
});
const shortLabel = computed(() => {
  switch (phase.value) {
    case "download": return pTotal.value ? `${pPct.value}%` : "Downloading…";
    case "reading": return "Reading…";
    case "posters": return "Posters…";
    case "rows": return "Importing…";
    default: return "…";
  }
});

onMounted(async () => {
  await loadCloudConfig();
  path.value = active.value.path;
  remember.value = active.value.hasCredential;
  if (active.value.hasCredential && !session.connected) {
    reconnecting.value = true;
    try {
      if (await autoConnect(settings.active)) refresh();
    } finally {
      reconnecting.value = false;
    }
  }
});

async function onSwitch(e: Event) {
  const provider = (e.target as HTMLSelectElement).value;
  error.value = "";
  files.value = [];
  reconnecting.value = true;
  try {
    await switchProvider(provider);
    path.value = active.value.path;
    remember.value = active.value.hasCredential;
    if (session.connected) refresh();
  } catch (e) {
    error.value = msg(e);
  } finally {
    reconnecting.value = false;
  }
}

async function onConnect() {
  busy.value = true;
  error.value = "";
  try {
    await connect(settings.active, { email: email.value, password: password.value }, remember.value);
    password.value = "";
    path.value = active.value.path;
    refresh();
  } catch (e) {
    error.value = msg(e);
  } finally {
    busy.value = false;
  }
}

function disconnect() {
  cloudDisconnect();
  files.value = [];
  error.value = "";
}

async function forget() {
  error.value = "";
  try {
    await forgetCredential(settings.active);
    remember.value = false;
  } catch (e) {
    error.value = msg(e);
  }
}

function refresh() {
  error.value = "";
  try {
    files.value = listAmc(path.value, deep.value);
  } catch (e) {
    error.value = msg(e);
  }
}

async function applyPath() {
  const next = path.value.trim();
  path.value = next;
  error.value = "";
  try {
    await saveActivePath(next);
  } catch (e) {
    error.value = msg(e);
  }
  refresh();
}

async function pullFile(f: MegaAmcFile) {
  if (importing.value) return;
  importing.value = f.name;
  phase.value = "download";
  pDone.value = 0;
  pTotal.value = 0;
  error.value = "";
  try {
    const id = await withWakeLock(() =>
      pull(f, (d, t, ph) => {
        phase.value = ph;
        pDone.value = d;
        pTotal.value = t;
      }),
    );
    files.value = []; // session dropped after import (ephemeral)
    emit("imported", id);
  } catch (e) {
    error.value = msg(e);
  } finally {
    importing.value = null;
    phase.value = "";
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
.cloud {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem;
  background: var(--c-card, #181828);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px);
}
.head { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.label { font-weight: 600; color: var(--c-text, #e8e0d5); }
.switcher {
  padding: 0.25rem 0.5rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.8rem;
}
.conn { font-size: 0.78rem; color: var(--c-muted, #7e7a90); }
.headactions { margin-left: auto; display: flex; gap: 0.4rem; }
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
.phelp { font-size: 0.7rem; color: var(--c-muted, #7e7a90); }
.pathrow input {
  padding: 0.4rem 0.6rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.85rem;
}
.deeprow { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
.rememberrow { flex-basis: 100%; display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
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
.btn.sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
.btn:disabled { opacity: 0.7; cursor: default; }
.err { color: var(--c-danger, #e05252); font-size: 0.82rem; margin: 0; }
.progress { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.2rem; }
.ptext { font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
.pbar { height: 8px; background: var(--c-elevated, #1f1f38); border-radius: 4px; overflow: hidden; }
.pbar-fill { height: 100%; background: var(--c-gold, #c9a84c); transition: width 0.2s; }
.pbar.indet .pbar-fill { width: 35%; animation: indet 1.1s ease-in-out infinite; }
@keyframes indet {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
</style>
