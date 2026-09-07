<!--
  CatalogsView.vue — the top-level CF screen: import a new .amc, list the
  tenant's catalogs, and export any of them back to a downloadable .amc.

  This is the "First import/export" deliverable end to end. Wire it as a route
  or drop it into App.vue for the CF deployment.
-->
<template>
  <!-- drilled into one library -->
  <MovieListView v-if="openCatalog" :catalog="openCatalog" @back="goBack" @changed="onWorkspaceChanged" />

  <div v-else class="max-w-160 mx-auto px-4 py-6 flex flex-col gap-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="font-display text-gold text-xl">Your libraries</h2>
      <Button
        icon="pi pi-refresh"
        text
        size="small"
        :disabled="checking"
        :title="checking ? 'Checking the cloud…' : 'Re-check cloud sync status'"
        @click="onRefreshStatus()"
      />
    </div>

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
          <span class="text-xs text-muted flex items-center gap-2 flex-wrap">
            <span>v{{ (c.version / 10).toFixed(1) }} · updated {{ fmt(c.updated_at) }}</span>
            <span
              class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.7rem] font-medium"
              :class="chip(c).cls"
            >
              <i :class="chip(c).icon" />
              {{ chip(c).label }}
            </span>
          </span>
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
            v-if="chipKind(c) === 'changed-externally' || chipKind(c) === 'remote-gone'"
            outlined
            size="small"
            icon="pi pi-cloud-download"
            title="Re-import from the cloud (replaces this library's contents)"
            :disabled="!!busyId"
            @click.stop="onReimport(c)"
          />
          <Button
            v-if="chipKind(c) === 'conflict'"
            outlined
            severity="danger"
            size="small"
            label="Resolve…"
            :disabled="!!busyId"
            @click.stop="onResolve(c)"
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
        <!-- Only a transfer with a known total gets a bar; the phases without
             one (login, build) keep the button label alone. -->
        <ProgressBar
          v-if="busyId === c.id && busyPct !== null"
          :value="busyPct"
          :show-value="false"
          class="basis-full h-1.5"
        />
      </li>
    </ul>

    <p v-if="error" class="text-danger text-sm basis-full">{{ error }}</p>

    <!-- Themed replacement for native confirm()/prompt() on export + delete.
         A fresh instance per ask (keyed) so the input field re-initialises. -->
    <ConfirmDialog
      v-if="dialog"
      :key="dialogKey"
      v-bind="dialog"
      @confirm="(v?: string) => settleDialog('confirm', v)"
      @discard="() => settleDialog('discard')"
      @cancel="() => settleDialog('cancel')"
    />

    <ConflictDialog
      v-if="conflictFor"
      :catalog="conflictFor"
      :local-movies="conflictMovies"
      @close="conflictFor = null"
      @resolved="conflictFor = null; refresh()"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, defineAsyncComponent, h } from "vue";
import Button from "primevue/button";
import ProgressBar from "primevue/progressbar";
import CatalogImport from "./CatalogImport.vue";
import CloudSync from "./CloudSync.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
// Lazy-loaded so the movie workspace (PrimeVue DataTable + virtual scroller) is
// code-split into its own chunk and stays out of the entry bundle — it only
// loads when a catalog is opened.
//
// The fallbacks are not optional polish: the catalog list is already hidden by
// `v-if="openCatalog"` while this resolves, so a bare loader shows a blank
// screen for the whole download on a slow link, and a chunk that 404s (a tab
// left open across a redeploy, since the filename is content-hashed) fails
// silently and blanks the app for good. `delay: 150` keeps the spinner from
// flashing on a warm cache.
// Render functions, not `template:` strings — the build pulls in Vue's
// runtime-only bundle, which has no template compiler.
const LoadingWorkspace = () =>
  h("div", { class: "min-h-dvh flex items-center justify-center gap-2 text-muted text-sm" }, [
    h("i", { class: "pi pi-spin pi-spinner" }),
    "Loading workspace…",
  ]);

const WorkspaceLoadFailed = () =>
  h("div", { class: "min-h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center" }, [
    h("i", { class: "pi pi-exclamation-triangle text-2xl text-danger" }),
    h("p", { class: "m-0 text-sm text-text" }, "Couldn't load the movie workspace."),
    h("p", { class: "m-0 text-xs text-muted" },
      "This usually means the app was updated in the background. Reload to pick up the new version."),
    h("button", {
      class: "mt-1 px-3 py-1.5 rounded-md border border-border-hi bg-elevated text-text text-sm cursor-pointer hover:border-gold",
      onClick: () => window.location.reload(),
    }, "Reload"),
  ]);

const MovieListView = defineAsyncComponent({
  loader: () => import("./MovieListView.vue"),
  delay: 150, // don't flash a spinner when the chunk is already cached
  loadingComponent: LoadingWorkspace,
  errorComponent: WorkspaceLoadFailed,
});
import { cf, downloadAmcFile, session, type CatalogRow, type MovieRow } from "./api";
import { cloudSession, syncCatalogToOrigin, pushAdoptingOrigin, reimportFromOrigin, switchProvider, CloudLoginRequiredError, cloudSettings, checkRemoteStates, transfers, anyTransferActive } from "./cloud";
import { deriveStatus, formatTransfer } from "./syncstatus";
import { pushView, goBack } from "./nav";
import ConflictDialog from "./ConflictDialog.vue";

// Remember the last library the user opened and jump straight back into it on
// load, instead of making them pick every time (the single-catalog Unraid app
// always showed the one catalog; this is the multi-catalog equivalent).
const LAST_KEY = "amc:lastCatalog";

const catalogs = ref<CatalogRow[]>([]);
const openCatalog = ref<CatalogRow | null>(null);
const loading = ref(true);
const error = ref("");
const deletingId = ref<string | null>(null);
const checking = ref(false);

// --- themed confirm/prompt --------------------------------------------------
// ConfirmDialog is event-based (emits confirm/discard/cancel), so `ask()` wraps
// one instance in a promise: the export + delete flows `await ask(...)` in place
// of the old blocking window.confirm()/prompt(). `dialogKey` forces a fresh
// mount per ask so the input field re-seeds from `inputValue`.
type DialogReq = {
  title: string;
  message?: string;
  confirmLabel?: string;
  discardLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: boolean;
  inputValue?: string;
  inputPlaceholder?: string;
  inputType?: string;
};
type DialogResult = { action: "confirm" | "discard" | "cancel"; value?: string };

const dialog = ref<DialogReq | null>(null);
const dialogKey = ref(0);
let dialogResolve: ((r: DialogResult) => void) | null = null;

function ask(req: DialogReq): Promise<DialogResult> {
  return new Promise((resolve) => {
    dialogKey.value++;
    dialog.value = req;
    dialogResolve = resolve;
  });
}
function settleDialog(action: DialogResult["action"], value?: string) {
  dialog.value = null;
  const r = dialogResolve;
  dialogResolve = null;
  r?.({ action, value });
}

/** Pull the catalog list. `silent` skips the loading placeholder — used when
 *  re-pulling rows to reflect a status check, so the list updates in place
 *  instead of blanking out to "Loading…" (the initial mount and the
 *  post-export/post-delete refreshes still want the normal loading flash). */
async function refresh(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true;
  error.value = "";
  try {
    catalogs.value = await cf.listCatalogs();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!opts.silent) loading.value = false;
  }
}

function onImported() {
  void refresh();
}

/** The workspace changed something that moves the catalog's sync counters
 *  (an edit, or a completed sync). Reload the list and re-point `openCatalog`
 *  at the fresh row, so the child's prop carries the new synced_rev — without
 *  this, the workspace's sync button would stay visible until the user
 *  navigated away, since synced_rev only ever arrives on the prop. */
async function onWorkspaceChanged() {
  const openId = openCatalog.value?.id;
  await refresh();
  if (openId) {
    const fresh = catalogs.value.find((c) => c.id === openId);
    if (fresh) openCatalog.value = fresh;
  }
}

const busyId = ref<string | null>(null);
const busyKind = ref<"sync" | "export" | "reimport" | null>(null);
const busyLabel = ref("");
/** 0-100 while a transfer reports a total, else null (no bar). */
const busyPct = ref<number | null>(null);

/** One reporter for every busy path: button label + the row's progress bar. */
function setBusy(done: number, total: number, phase: string) {
  busyPct.value = total > 0 ? Math.round((done / total) * 100) : null;
  busyLabel.value = formatTransfer(phase, done, total);
}

function clearBusy() {
  busyId.value = null;
  busyKind.value = null;
  busyLabel.value = "";
  busyPct.value = null;
}

const conflictFor = ref<CatalogRow | null>(null);
const conflictMovies = ref<MovieRow[]>([]);

function chipKind(c: CatalogRow) {
  return deriveStatus(c, transfers[c.id]).kind;
}

/** The dialog's compare step needs the local rows. Fetch them once, here,
 *  rather than holding every catalog's movies in this view. */
async function onResolve(c: CatalogRow) {
  error.value = "";
  try {
    conflictMovies.value = await cf.listMovies(c.id);
    conflictFor.value = c;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onReimport(c: CatalogRow) {
  if (busyId.value) return;
  busyId.value = c.id;
  busyKind.value = "reimport";
  error.value = "";
  try {
    await reimportFromOrigin(c, setBusy);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    clearBusy();
  }
}

/** Origin catalog: push back to where it came from. */
async function onSync(c: CatalogRow) {
  if (busyId.value) return;
  busyId.value = c.id;
  busyKind.value = "sync";
  busyLabel.value = "Building…";
  error.value = "";
  try {
    await syncCatalogToOrigin(c, setBusy);
    busyPct.value = null;
    busyLabel.value = "Done ✓";
    // The push wrote synced_rev/remote_state server-side; the row in hand is
    // the pre-push copy, so without a re-list the chip keeps showing the old
    // verdict ("cloud file missing") until a reload.
    await refresh({ silent: true });
    await new Promise((r) => setTimeout(r, 1200));
  } catch (e) {
    if (e instanceof CloudLoginRequiredError) {
      await switchProvider(e.provider).catch(() => {});
      error.value = `Connect ${e.provider} in the Cloud sync panel above, then press Sync again.`;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    clearBusy();
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
  const choice = await ask({
    title: `Export "${c.name || "(untitled)"}"`,
    message: "Upload this library to your cloud provider, or download the .amc file?",
    confirmLabel: "Upload to cloud",
    discardLabel: "Download .amc",
    cancelLabel: "Cancel",
  });
  if (choice.action === "cancel") return;
  if (choice.action === "discard") {
    await downloadLocal(c);
    return;
  }
  // choice.action === "confirm" → upload to the active cloud provider.
  if (!cloudSession.connected) {
    error.value = "Connect a provider in the Cloud sync panel above, then press Export again.";
    return;
  }
  const provider = cloudSession.provider;
  const suggested = cloudSettings.providers[provider]?.path || `/${(c.name || "catalog")}.amc`;
  const destAsk = await ask({
    title: `Upload path on ${provider}`,
    input: true,
    inputValue: suggested,
    inputPlaceholder: "/path/to/library.amc",
    confirmLabel: "Upload",
    cancelLabel: "Cancel",
  });
  if (destAsk.action !== "confirm") return;
  const dest = (destAsk.value ?? "").trim();
  busyId.value = c.id;
  busyKind.value = "export";
  busyLabel.value = "Building…";
  error.value = "";
  try {
    const ref = await pushAdoptingOrigin(c, provider, dest, setBusy);
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
    clearBusy();
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
      onProgress: (d, t) => setBusy(d, t, "posters"),
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    clearBusy();
  }
}

async function onDelete(c: CatalogRow) {
  if (deletingId.value) return;
  const res = await ask({
    title: "Delete library",
    message: `Delete "${c.name || "(untitled)"}" and all its movies and posters? This cannot be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (res.action !== "confirm") return;
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

/** Full local timestamp (date + hh:mm:ss). A bare date is useless for "synced"
 *  and "updated": both change several times a day. */
function fmt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/** Coarse "how long ago" for the last remote check, distinct from `fmt()`'s
 *  calendar date — the "unknown" chip needs the age of the last verdict, not
 *  the date it was taken. */
function ageLabel(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Chip appearance per status kind. Purely presentational — every decision
 *  about WHICH state we are in lives in deriveStatus. */
function chip(c: CatalogRow): { label: string; icon: string; cls: string } {
  const s = deriveStatus(c, transfers[c.id]);
  switch (s.kind) {
    case "local-only":
      return { label: "local only", icon: "pi pi-desktop", cls: "bg-elevated text-muted" };
    case "syncing":
      return {
        label: formatTransfer(s.phase, s.done, s.total),
        icon: "pi pi-spin pi-spinner",
        cls: "bg-elevated text-gold",
      };
    case "unknown": {
      // remote_checked_at is null only when never checked; deriveStatus can
      // also fall back to "unknown" for an unrecognized (future) remote_state
      // with a real timestamp, so show its age whenever one exists.
      const age = c.remote_checked_at != null ? ` (checked ${ageLabel(c.remote_checked_at)})` : "";
      return {
        label: s.localDirty ? `${s.pending} unsynced · cloud unchecked${age}` : `cloud unchecked${age}`,
        icon: "pi pi-question-circle",
        cls: "bg-elevated text-muted",
      };
    }
    case "remote-gone":
      return { label: "cloud file missing", icon: "pi pi-times-circle", cls: "bg-elevated text-danger" };
    case "synced":
      return { label: `synced ${fmt(s.at)}`, icon: "pi pi-check-circle", cls: "bg-elevated text-success" };
    case "not-synced":
      return {
        label: `${s.pending} unsynced change${s.pending === 1 ? "" : "s"}`,
        icon: "pi pi-cloud-upload",
        cls: "bg-elevated text-gold",
      };
    case "changed-externally":
      return { label: "changed in the cloud", icon: "pi pi-exclamation-triangle", cls: "bg-elevated text-gold" };
    case "conflict":
      return { label: "conflict", icon: "pi pi-exclamation-triangle", cls: "bg-elevated text-danger" };
  }
}

async function onRefreshStatus() {
  checking.value = true;
  try {
    await checkRemoteStates(catalogs.value);
    await refresh({ silent: true }); // pull the recorded verdicts back into the rows in place
  } finally {
    checking.value = false;
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
  // One tree read covers every catalog, so do it once here rather than
  // per-row. Skipped silently when no credential is stored — we never prompt
  // for a login from a page load.
  void onRefreshStatus();
});

// A push holds the tab: megajs runs in this page, so closing it mid-upload
// aborts the transfer. replaceInFolder deletes the old remote file only AFTER
// the new upload completes, so an aborted push leaves the cloud file intact and
// the catalog simply stays "not synced" — but warn anyway.
function guardUnload(e: BeforeUnloadEvent) {
  if (!anyTransferActive()) return;
  e.preventDefault();
  e.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", guardUnload));
onUnmounted(() => window.removeEventListener("beforeunload", guardUnload));
</script>
