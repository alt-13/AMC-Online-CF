<!--
  SettingsDialog.vue — per-user field visibility (desktop/mobile) + the search
  field. Persists the one JSON blob the Worker stores in `user_settings`.
  Built on PrimeVue Dialog + Accordion + Checkbox + Select + Password.
-->
<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    header="Field visibility"
    :closable="true"
    :style="{ width: '520px' }"
    :breakpoints="{ '760px': '95vw' }"
    @update:visible="(v: boolean) => { if (!v) close(); }"
  >
    <div class="grid grid-cols-[1fr_40px_40px] items-center px-1 pb-2 border-b border-border">
      <span class="text-[0.66rem] uppercase tracking-wide text-muted">Field</span>
      <span class="text-center text-sm">🖥</span>
      <span class="text-center text-sm">📱</span>
    </div>

    <div class="max-h-[60vh] overflow-y-auto -mx-1">
      <Accordion :value="expanded" multiple>
        <AccordionPanel v-for="sec in sections" :key="sec.key" :value="sec.key">
          <AccordionHeader>{{ sec.label }}</AccordionHeader>
          <AccordionContent>
            <div
              v-for="f in sec.fields"
              :key="f.key"
              class="grid grid-cols-[1fr_40px_40px] items-center py-1 px-2 hover:bg-elevated rounded-md"
            >
              <span class="text-sm">{{ f.label }}</span>
              <Checkbox
                class="justify-self-center"
                :binary="true"
                :modelValue="vis(f.key, 'desktop')"
                :disabled="f.always || f.key === 'original_title'"
                @update:modelValue="(v: boolean) => set(f.key, 'desktop', v)"
              />
              <Checkbox
                class="justify-self-center"
                :binary="true"
                :modelValue="vis(f.key, 'mobile')"
                :disabled="f.always || f.key === 'original_title'"
                @update:modelValue="(v: boolean) => set(f.key, 'mobile', v)"
              />
            </div>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>

      <div class="mt-3 flex flex-col gap-2 px-2">
        <span class="text-sm font-semibold text-gold">Search field</span>
        <Select
          v-model="draft.search_field"
          :options="searchOptions"
          optionLabel="label"
          optionValue="value"
          class="w-full"
        />
      </div>

      <div class="mt-4 flex flex-col gap-2 px-2">
        <span class="text-sm font-semibold text-gold">OMDb API key</span>
        <p class="m-0 text-xs text-muted">
          Powers "⚡ Fetch → new" (IMDb/OMDb metadata). Get a free key at
          <a class="text-gold" href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com</a>.
        </p>
        <Password
          v-model="omdbInput"
          :feedback="false"
          toggleMask
          inputClass="w-full"
          class="w-full"
          :inputProps="{ autocomplete: 'off' }"
          :placeholder="omdbKey.personal ? 'A key is saved — type to replace it' : 'Paste your OMDb API key…'"
        />
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs" :class="omdbKey.hasKey ? 'text-gold' : 'text-muted'">
            {{ omdbKey.personal ? "✓ Your key is saved"
               : omdbKey.hasKey ? "Using the server's shared key"
               : "No key set — fetch is disabled" }}
          </span>
          <Button v-if="omdbKey.personal" label="Remove" text severity="danger" @click="removeKey" />
        </div>
      </div>
    </div>

    <p v-if="error" class="text-danger text-sm mt-3 mb-0">{{ error }}</p>

    <template #footer>
      <Button label="↩ Reset" text @click="reset" />
      <Button label="Cancel" text @click="close" />
      <Button label="Save" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Select from "primevue/select";
import Password from "primevue/password";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import { settings as settingsApi, omdb, type CustomFieldDefRow, type OmdbKeyState } from "./api";
import { sectionsFor, DEFAULT_SETTINGS, type AppSettings } from "./fields";

const props = defineProps<{ defs: CustomFieldDefRow[] }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", s: AppSettings): void }>();

const sections = computed(() => sectionsFor(props.defs));
const searchable = computed(() => sections.value.flatMap((s) => s.fields));
const searchOptions = computed(() => [
  { label: "All fields", value: "" },
  ...searchable.value.map((f) => ({ label: f.label, value: f.key })),
]);

const draft = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
const expanded = ref<string[]>(["main"]);
const saving = ref(false);
const error = ref("");

const omdbKey = ref<OmdbKeyState>({ hasKey: false, personal: false });
const omdbInput = ref("");

onMounted(async () => {
  try {
    draft.value = { ...structuredClone(DEFAULT_SETTINGS), ...(await settingsApi.get()) };
  } catch {
    /* defaults */
  }
  try {
    omdbKey.value = await omdb.keyState();
  } catch {
    /* leave defaults */
  }
});

async function removeKey() {
  error.value = "";
  try {
    omdbKey.value = await omdb.saveKey(null);
    omdbInput.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function vis(key: string, mode: "desktop" | "mobile"): boolean {
  if (key === "original_title") return true;
  return draft.value.field_visibility[mode][key] ?? true;
}
function set(key: string, mode: "desktop" | "mobile", value: boolean) {
  draft.value.field_visibility[mode][key] = value;
}
function reset() {
  draft.value = { ...draft.value, field_visibility: { desktop: {}, mobile: {} } };
}
async function save() {
  saving.value = true;
  error.value = "";
  try {
    // Only send the OMDb key when the user actually typed one (blank = keep).
    if (omdbInput.value.trim()) {
      omdbKey.value = await omdb.saveKey(omdbInput.value.trim());
      omdbInput.value = "";
    }
    const saved = await settingsApi.save(draft.value);
    emit("saved", saved);
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
function close() {
  emit("close");
}
</script>
