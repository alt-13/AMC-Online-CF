<!--
  SettingsDialog.vue — the user's settings: light/dark mode, field visibility
  (desktop/mobile), the search field, and the OMDb key. Field visibility is one
  section of it, not the dialog's subject. Persists the one JSON blob the Worker
  stores in `user_settings` — except the mode, which is device-local (theme.ts).
  Built on PrimeVue Dialog + Accordion + Checkbox + Select + Password.
-->
<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    header="Settings"
    :closable="true"
    :style="{ width: '520px' }"
    :breakpoints="{ '760px': '95vw' }"
    @update:visible="(v: boolean) => { if (!v) close(); }"
  >
    <!-- scrollbar-gutter keeps the scrollbar's width reserved, so the content
         doesn't reflow the moment a panel expands past 60vh. -->
    <div class="max-h-[60vh] overflow-y-auto [scrollbar-gutter:stable]">
      <!-- Appearance is the one control here that applies (and persists) on
           click instead of on Save: it's device-local (localStorage, not
           `user_settings`), and a theme you can't see until you Save is a worse
           switch than one that just flips. -->
      <div class="mb-4 flex flex-col gap-2">
        <span class="text-sm font-semibold text-gold">Appearance</span>
        <SelectButton
          v-model="themeMode"
          :options="themeOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
          size="small"
        />
        <span class="text-[0.7rem] text-muted">
          Applies at once, on this device only. “System” follows your OS setting.
        </span>
      </div>

      <section>
        <span class="text-sm font-semibold text-gold">Field visibility</span>

        <!-- The column header and the per-field rows must share the same
             horizontal insets or the two toggle columns don't line up: the rows
             sit inside AccordionContent, so its padding is zeroed via `dt` and
             both grids use px-2 + identical track widths. `sticky` keeps the
             header in view while the (long) field list scrolls under it. -->
        <div
          class="sticky top-0 z-10 mt-2 grid grid-cols-[1fr_2.5rem_2.5rem] items-center
                 bg-card px-2 pb-2 border-b border-border"
        >
          <span class="text-[0.66rem] uppercase tracking-wide text-muted">Field</span>
          <i class="pi pi-desktop justify-self-center text-muted" v-tooltip.top="'Show on desktop'" aria-label="Show on desktop" />
          <i class="pi pi-mobile justify-self-center text-muted" v-tooltip.top="'Show on mobile'" aria-label="Show on mobile" />
        </div>

        <Accordion
          :value="expanded"
          multiple
          :dt="{ header: { padding: '0.75rem 0.5rem' }, content: { padding: '0 0 0.75rem 0' } }"
        >
          <AccordionPanel v-for="sec in sections" :key="sec.key" :value="sec.key">
            <!-- The section master toggles sit IN the header, on the same grid as
                 the rows below. `as="div"` because a Checkbox may not nest in a
                 <button>, the default toggle icon is suppressed and re-drawn in
                 the label cell (it renders after the slot, which would push the
                 two toggle columns out of alignment), and click/keydown are
                 stopped on the boxes so ticking one doesn't collapse the panel. -->
            <AccordionHeader as="div">
              <template #default="{ active }">
                <div class="w-full grid grid-cols-[1fr_2.5rem_2.5rem] items-center">
                  <span class="flex items-center gap-2">
                    <i :class="['pi text-xs', active ? 'pi-chevron-up' : 'pi-chevron-down']" />
                    {{ sec.label }}
                  </span>
                  <Checkbox
                    class="justify-self-center"
                    :binary="true"
                    :modelValue="secState(sec, 'desktop').all"
                    :indeterminate="secState(sec, 'desktop').some"
                    :aria-label="`Show all ${sec.label} fields on desktop`"
                    @click.stop
                    @keydown.stop
                    @update:modelValue="(v: boolean) => setSection(sec, 'desktop', v)"
                  />
                  <Checkbox
                    class="justify-self-center"
                    :binary="true"
                    :modelValue="secState(sec, 'mobile').all"
                    :indeterminate="secState(sec, 'mobile').some"
                    :aria-label="`Show all ${sec.label} fields on mobile`"
                    @click.stop
                    @keydown.stop
                    @update:modelValue="(v: boolean) => setSection(sec, 'mobile', v)"
                  />
                </div>
              </template>
              <template #toggleicon><span class="hidden" /></template>
            </AccordionHeader>
            <AccordionContent>
              <div
                v-for="f in sec.fields"
                :key="f.key"
                class="grid grid-cols-[1fr_2.5rem_2.5rem] items-center py-1 px-2 hover:bg-elevated rounded-md"
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
      </section>

      <div class="mt-3 flex flex-col gap-2">
        <span class="text-sm font-semibold text-gold">Search field</span>
        <Select
          v-model="searchFieldModel"
          :options="searchOptions"
          optionLabel="label"
          optionValue="value"
          class="w-full"
        />
      </div>

      <div class="mt-4 flex flex-col gap-2">
        <span class="text-sm font-semibold text-gold">Duplicate warning</span>
        <p class="m-0 text-xs text-muted">
          Adding a film whose value here already exists in the catalog raises a
          warning first. Title is the default; a URL from a metadata source is
          the exact match if your catalog carries one. Blank values never match.
        </p>
        <Select
          v-model="duplicateFieldModel"
          :options="duplicateOptions"
          optionLabel="label"
          optionValue="value"
          class="w-full"
        />
      </div>

      <div class="mt-4 flex flex-col gap-2">
        <span class="text-sm font-semibold text-gold">Watched / Checked</span>
        <p class="m-0 text-xs text-muted">
          The .amc format stores a Date Watched and a separate “checked” flag and
          never links them. By default this app keeps them in sync: setting a Date
          Watched marks the film watched, clearing it unmarks it. Unlink them if
          you use “checked” for something of your own — the detail form then gets
          its own <em>Checked</em> toggle under Color Tag.
        </p>
        <div class="flex items-center gap-2">
          <Checkbox v-model="draft.checked_separate" :binary="true" inputId="checked-separate" />
          <label for="checked-separate" class="text-sm">Keep Checked separate from Watched</label>
        </div>
      </div>

      <div class="mt-4 flex flex-col gap-2">
        <span class="text-sm font-semibold text-gold">Series count</span>
        <p class="m-0 text-xs text-muted">
          The catalog bar can show a “N films / N series” tally. There is no
          series flag in the .amc format, so it depends on how <em>you</em> use the
          catalog number — pick the rule that matches yours. Off by default.
        </p>
        <Select
          v-model="seriesKindModel"
          :options="seriesRuleOptions"
          optionLabel="label"
          optionValue="value"
          class="w-full"
        />
        <div v-if="draft.series_rule.kind === 'certification_in'" class="flex flex-col gap-1">
          <label class="text-xs text-muted">
            Series have one of these certifications (type a value, press Enter)
          </label>
          <InputChips
            v-model="certificationValuesModel"
            placeholder="TV Series"
            separator=","
            addOnBlur
            :allowDuplicate="false"
            class="w-full"
            inputClass="min-w-32"
          />
          <span class="text-[0.7rem] text-muted">
            Matched whole, ignoring case and surrounding spaces.
          </span>
        </div>
        <div v-if="draft.series_rule.kind === 'number_is'" class="flex items-center gap-2">
          <label class="text-xs text-muted whitespace-nowrap">Series are numbered</label>
          <InputNumber
            v-model="seriesNumberModel"
            :min="0"
            :max="MAX_MOVIE_NUMBER"
            :useGrouping="false"
            showButtons
            size="small"
            inputClass="w-20"
          />
        </div>
      </div>

      <div class="mt-4 flex flex-col gap-2">
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
import { ref, computed, watch, onMounted } from "vue";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Select from "primevue/select";
import InputNumber from "primevue/inputnumber";
import InputChips from "primevue/inputchips";
import Password from "primevue/password";
import SelectButton from "primevue/selectbutton";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import { settings as settingsApi, omdb, type CustomFieldDefRow, type OmdbKeyState } from "./api";
import {
  sectionsFor, DEFAULT_SETTINGS, MAX_MOVIE_NUMBER, DEFAULT_CERTIFICATION_VALUES,
  type AppSettings, type SeriesRule, type FieldSection, type FieldDef,
} from "./fields";

import { getThemeMode, setThemeMode, type ThemeMode } from "./theme";

const props = defineProps<{ defs: CustomFieldDefRow[] }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", s: AppSettings): void }>();

const sections = computed(() => sectionsFor(props.defs));
const searchable = computed(() => sections.value.flatMap((s) => s.fields));

// settings.search_field uses "" for "search every field", but PrimeVue Select
// treats an empty string as "nothing selected" (isNotEmpty) and renders a blank
// box, so the option list carries a non-empty sentinel and this proxy maps it
// back to "" on the way into the draft.
const ALL_FIELDS = "__all__";
const searchOptions = computed(() => [
  { label: "All fields", value: ALL_FIELDS },
  ...searchable.value.map((f) => ({ label: f.label, value: f.key })),
]);

// Same "" -> sentinel dance as the search field: "" means "no warning".
const NO_DUPES = "__off__";
const duplicateOptions = computed(() => [
  { label: "Off (never warn)", value: NO_DUPES },
  ...searchable.value.map((f) => ({ label: f.label, value: f.key })),
]);

const draft = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS));
const duplicateFieldModel = computed<string>({
  get: () => draft.value.duplicate_field || NO_DUPES,
  set: (v) => { draft.value.duplicate_field = v === NO_DUPES ? "" : v; },
});
const searchFieldModel = computed<string>({
  get: () => draft.value.search_field || ALL_FIELDS,
  set: (v) => { draft.value.search_field = v === ALL_FIELDS ? "" : v; },
});
// Series rule. The kind is a flat Select; `number_is` reveals a number box. The
// two proxies keep `draft.series_rule` a well-formed discriminated union at all
// times — switching kind rebuilds the whole object rather than leaving a stale
// `number` on an `off` rule.
const seriesRuleOptions = [
  { label: "Don't show counts", value: "off" },
  { label: "Certification is one of …", value: "certification_in" },
  { label: "Entries with one specific number are series", value: "number_is" },
  { label: "A number shared by 2+ entries is one series", value: "number_shared" },
];
const seriesKindModel = computed<SeriesRule["kind"]>({
  get: () => draft.value.series_rule?.kind ?? "off",
  set: (kind) => {
    draft.value.series_rule =
      kind === "number_is" ? { kind, number: 1 }
      : kind === "number_shared" ? { kind }
      : kind === "certification_in" ? { kind, values: [...DEFAULT_CERTIFICATION_VALUES] }
      : { kind: "off" };
  },
});
const certificationValuesModel = computed<string[]>({
  get: () =>
    draft.value.series_rule?.kind === "certification_in" ? draft.value.series_rule.values : [],
  set: (values) => {
    // InputChips emits null when the last chip is removed.
    draft.value.series_rule = {
      kind: "certification_in",
      values: (values ?? []).map((v) => v.trim()).filter(Boolean),
    };
  },
});
const seriesNumberModel = computed<number>({
  get: () => (draft.value.series_rule?.kind === "number_is" ? draft.value.series_rule.number : 1),
  set: (n) => {
    // InputNumber emits null when the box is cleared.
    const v = Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), MAX_MOVIE_NUMBER) : 0;
    draft.value.series_rule = { kind: "number_is", number: v };
  },
});

const themeOptions = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];
// A plain ref, not a computed proxy over localStorage: localStorage isn't
// reactive, so a computed's getter would never re-run and the buttons wouldn't
// track the click.
const themeMode = ref<ThemeMode>(getThemeMode());
watch(themeMode, setThemeMode);

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
/** Fields whose checkbox isn't disabled — the ones a section master can move. */
function togglable(sec: FieldSection): FieldDef[] {
  return sec.fields.filter((f) => !f.always && f.key !== "original_title");
}
function secState(sec: FieldSection, mode: "desktop" | "mobile") {
  const fields = togglable(sec);
  const on = fields.filter((f) => vis(f.key, mode)).length;
  return { all: fields.length > 0 && on === fields.length, some: on > 0 && on < fields.length };
}
function setSection(sec: FieldSection, mode: "desktop" | "mobile", value: boolean) {
  for (const f of togglable(sec)) set(f.key, mode, value);
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
