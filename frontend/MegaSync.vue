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

    <!-- reconnecting from a stored credential -->
    <p v-if="!state.connected && reconnecting" class="hint">Reconnecting to Mega…</p>

    <!-- connect -->
    <form v-else-if="!state.connected" class="form" @submit.prevent="connect">
      <label class="providerrow">
        <span class="plabel">cloud service</span>
        <select v-model="settings.provider" class="provider">
          <option value="mega">Mega.nz</option>
          <option value="drive" disabled>Google Drive (soon)</option>
          <option value="dropbox" disabled>Dropbox (soon)</option>
          <option value="s3" disabled>S3 (soon)</option>
        </select>
      </label>
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

      <div class="bar">
        <button class="btn ghost" :disabled="busy" @click="applyPath">Refresh</button>
        <button class="btn ghost" @click="disconnect">Disconnect</button>
        <button v-if="settings.hasCredential" class="btn ghost" @click="forget">
          Forget saved login
        </button>
      </div>

      <ul v-if="files.length" class="files">
        <li v-for="f in files" :key="f.name" class="frow">
          <span class="fname" :title="f.name">{{ f.name }}</span>
          <span class="fsize">{{ human(f.size) }}</span>
          <button class="btn" :disabled="!!importing" @click="pull(f)">
            {{ importing === f.name ? shortLabel : "Import" }}
          </button>
        </li>
      </ul>

      <!-- import progress -->
      <div v-if="importing" class="progress">
        <div class="ptext">{{ phaseText }}</div>
        <div class="bar" :class="{ indet: indeterminate }">
          <div class="bar-fill" :style="indeterminate ? undefined : { width: pPct + '%' }" />
        </div>
      </div>
      <p v-else class="hint">
        No <code>.amc</code> files {{ path ? `at "${path}"` : "at your Mega account root" }}.
      </p>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  megaState as state,
  megaSettings as settings,
  saveMegaPath,
  loadCloudConfig,
  megaConnect,
  megaAutoConnect,
  megaForgetCredential,
  megaDisconnect,
  megaListAmc,
  megaPull,
  type MegaAmcFile,
} from "./mega";
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
const path = ref(settings.path);
const deep = ref(false);

// Import progress. `phase` drives whether done/total are bytes (download) or
// counts (posters/rows); "reading" is the uncountable parse step.
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
// Compact word for the button itself.
const shortLabel = computed(() => {
  switch (phase.value) {
    case "download": return pTotal.value ? `${pPct.value}%` : "Downloading…";
    case "reading": return "Reading…";
    case "posters": return "Posters…";
    case "rows": return "Importing…";
    default: return "…";
  }
});

// On load: fetch this user's saved config, then auto-reconnect if a credential
// is stored — so a remembered user never has to log in again.
onMounted(async () => {
  await loadCloudConfig();
  path.value = settings.path;
  remember.value = settings.hasCredential;
  if (settings.hasCredential && !state.connected) {
    reconnecting.value = true;
    try {
      if (await megaAutoConnect()) refresh();
    } finally {
      reconnecting.value = false;
    }
  }
});

async function connect() {
  busy.value = true;
  error.value = "";
  try {
    await megaConnect({ email: email.value, password: password.value }, remember.value);
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

async function forget() {
  error.value = "";
  try {
    await megaForgetCredential();
    remember.value = false;
  } catch (e) {
    error.value = msg(e);
  }
}

function refresh() {
  error.value = "";
  try {
    files.value = megaListAmc(path.value, deep.value);
  } catch (e) {
    error.value = msg(e);
  }
}

/** Persist the path (per-user, server-side), then re-list from it. */
async function applyPath() {
  const next = path.value.trim();
  path.value = next;
  error.value = "";
  try {
    await saveMegaPath(next);
  } catch (e) {
    error.value = msg(e);
  }
  refresh();
}

async function pull(f: MegaAmcFile) {
  if (importing.value) return;
  importing.value = f.name;
  phase.value = "download";
  pDone.value = 0;
  pTotal.value = 0;
  error.value = "";
  try {
    const id = await withWakeLock(() =>
      megaPull(f.node, (d, t, ph) => {
        phase.value = ph;
        pDone.value = d;
        pTotal.value = t;
      }),
    );
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
.providerrow { display: flex; flex-direction: column; gap: 0.2rem; flex-basis: 100%; }
.provider {
  padding: 0.4rem 0.6rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.85rem;
}
.rememberrow { flex-basis: 100%; display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
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

.progress { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.2rem; }
.ptext { font-size: 0.75rem; color: var(--c-muted, #7e7a90); }
.bar { height: 8px; background: var(--c-elevated, #1f1f38); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--c-gold, #c9a84c); transition: width 0.2s; }
/* Indeterminate: a sliding sliver for the uncountable parse step. */
.bar.indet .bar-fill { width: 35%; animation: indet 1.1s ease-in-out infinite; }
@keyframes indet {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
</style>
