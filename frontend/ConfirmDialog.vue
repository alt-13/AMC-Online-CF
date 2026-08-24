<!--
  ConfirmDialog.vue — a themed, non-blocking confirm overlay used in place of the
  native window.confirm() (which freezes the whole tab). Built on PrimeVue Dialog,
  which owns the teleport-to-body, modal mask, Esc-to-close and focus trap.
  Backdrop click and Esc both cancel.

  One component, all shapes handled by Dialog's own responsive breakpoints.

  Supports an optional middle "discard" action, so it doubles as the three-way
  unsaved-changes prompt (Save & continue / Discard / Cancel), and an optional
  text input (`input`), so it also replaces window.prompt() (confirm emits the
  entered value).
-->
<template>
  <Dialog
    :visible="true"
    modal
    dismissable-mask
    :header="title"
    :closable="!busy"
    :style="{ width: '420px' }"
    :breakpoints="{ '760px': '95vw' }"
    @update:visible="(v: boolean) => { if (!v) $emit('cancel'); }"
  >
    <p v-if="message" class="m-0 mb-4 text-sm text-muted leading-relaxed">{{ message }}</p>
    <InputText
      v-if="input"
      v-model="localValue"
      autofocus
      class="w-full"
      :type="inputType"
      :placeholder="inputPlaceholder"
      :disabled="busy"
      @keydown.enter.prevent="onConfirm"
    />
    <template #footer>
      <Button :label="cancelLabel" text :disabled="busy" @click="$emit('cancel')" />
      <Button
        v-if="discardLabel"
        :label="discardLabel"
        severity="danger"
        outlined
        :disabled="busy"
        @click="$emit('discard')"
      />
      <Button
        :label="confirmLabel"
        :severity="danger ? 'danger' : undefined"
        :loading="busy"
        @click="onConfirm"
      />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import InputText from "primevue/inputtext";

const props = withDefaults(
  defineProps<{
    title: string;
    message?: string;
    confirmLabel?: string;
    discardLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
    danger?: boolean; // filled-red confirm button for destructive actions
    input?: boolean; // render a text field; `confirm` emits its value
    inputValue?: string; // initial field value
    inputPlaceholder?: string;
    inputType?: string;
  }>(),
  {
    confirmLabel: "Confirm", cancelLabel: "Cancel", busy: false, danger: false,
    input: false, inputValue: "", inputType: "text",
  },
);

const emit = defineEmits<{
  (e: "confirm", value?: string): void;
  (e: "discard"): void;
  (e: "cancel"): void;
}>();

const localValue = ref(props.inputValue);

function onConfirm() {
  emit("confirm", props.input ? localValue.value : undefined);
}
</script>
