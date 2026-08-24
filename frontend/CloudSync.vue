<!--
  CloudSync.vue — pick a cloud provider (header switcher), connect in-browser
  (credentials never leave the tab unless the user opts to remember them,
  encrypted at rest), and import an .amc from it. Connections are ephemeral:
  after a successful import the session is dropped (see cloud.ts). Per-catalog
  export/push lives in CatalogsView.vue and targets each catalog's own origin.

  Emits `imported(catalogId)` after a successful pull so the parent can refresh.
-->
<template>
  <div class="flex flex-col gap-2.5 p-4 bg-card border border-border rounded-lg">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-semibold text-text">Cloud sync</span>
      <!-- provider switcher: relocating a wrong pick is one dropdown away -->
      <Select
        :modelValue="settings.active"
        :options="providerOptions"
        optionLabel="label"
        optionValue="value"
        optionDisabled="disabled"
        class="text-sm w-44"
        @update:modelValue="onSwitch"
      />
      <span v-if="session.connected" class="text-xs text-muted">· {{ session.email }}</span>
      <div v-if="session.connected" class="ml-auto flex gap-2">
        <Button v-if="active.hasCredential" outlined size="small" label="Forget saved login" @click="forget" />
        <Button outlined size="small" label="Disconnect" @click="disconnect" />
      </div>
    </div>

    <!-- reconnecting from a stored credential -->
    <p v-if="!session.connected && reconnecting" class="basis-full m-0 text-[0.72rem] text-muted">Reconnecting…</p>

    <!-- connect -->
    <form v-else-if="!session.connected" class="flex flex-wrap gap-2 items-center" @submit.prevent="onConnect">
      <InputText v-model="email" type="email" placeholder="Email" autocomplete="username" required class="flex-1 min-w-48" />
      <Password
        v-model="password"
        placeholder="Password"
        autocomplete="current-password"
        required
        :feedback="false"
        toggleMask
        inputClass="w-full"
        class="flex-1 min-w-48"
      />
      <Button :label="busy ? 'Connecting…' : 'Connect'" :disabled="busy" type="submit" />
      <label class="basis-full flex items-center gap-2 text-xs text-muted">
        <Checkbox v-model="remember" :binary="true" />
        keep me signed in on this account (stored encrypted)
      </label>
      <p class="basis-full m-0 text-[0.72rem] text-muted">
        {{ remember
          ? "Saved encrypted to your own server so you don't log in again — decrypted only in this browser to connect."
          : "Stays in this browser tab only — never saved, never sent to the server." }}
      </p>
    </form>

    <!-- connected -->
    <div v-else class="flex flex-col gap-2.5">
      <label class="flex flex-col gap-0.5">
        <span class="text-[0.7rem] uppercase tracking-wide text-muted">.amc file path</span>
        <InputText
          v-model="path"
          type="text"
          placeholder="/Backups/movies.amc — full path to the file (a folder or blank also works)"
          spellcheck="false"
          autocapitalize="off"
          @keyup.enter="applyPath"
          @blur="applyPath"
        />
        <span class="text-[0.7rem] text-muted">
          Point this at a specific file (recommended). Import reads it; push writes
          back to exactly this path.
        </span>
      </label>
      <label class="flex items-center gap-2 text-xs text-muted">
        <Checkbox v-model="deep" :binary="true" @change="refresh" />
        search subfolders
      </label>

      <ul v-if="files.length" class="list-none flex flex-col gap-2 mt-1 p-0 m-0">
        <li v-for="f in files" :key="f.name" class="flex items-center gap-2.5">
          <span class="flex-1 min-w-0 truncate text-text text-sm" :title="f.name">{{ f.name }}</span>
          <span class="text-[0.72rem] text-muted flex-shrink-0">{{ human(f.size) }}</span>
          <Button
            size="small"
            :disabled="!!importing"
            :label="importing === f.name ? shortLabel : 'Import'"
            @click="pullFile(f)"
          />
        </li>
      </ul>

      <div v-if="importing" class="flex flex-col gap-1 mt-0.5">
        <div class="text-xs text-muted">{{ phaseText }}</div>
        <div class="h-2 bg-elevated rounded overflow-hidden">
          <div
            class="h-full bg-gold transition-[width] duration-200"
            :class="indeterminate ? 'w-[35%] animate-pulse' : ''"
            :style="indeterminate ? undefined : { width: pPct + '%' }"
          />
        </div>
      </div>
      <p v-else class="basis-full m-0 text-[0.72rem] text-muted">
        No <code class="bg-elevated px-1.5 rounded">.amc</code> files {{ path ? `at "${path}"` : "at your account root" }}.
      </p>
    </div>

    <p v-if="error" class="text-danger text-sm m-0">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
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

const providerOptions = [
  { label: "Mega.nz", value: "mega", disabled: false },
  { label: "Google Drive (soon)", value: "drive", disabled: true },
  { label: "Dropbox (soon)", value: "dropbox", disabled: true },
  { label: "S3 (soon)", value: "s3", disabled: true },
];

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

async function onSwitch(provider: string) {
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
