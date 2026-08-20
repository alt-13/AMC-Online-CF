<!--
  ConfirmDialog.vue — a themed, non-blocking confirm overlay used in place of the
  native window.confirm() (which freezes the whole tab). Teleported to <body> so
  it escapes the workspace's overflow:hidden and the virtual table's stacking
  context. Backdrop click and Esc both cancel.

  Two shapes, one component:
    • desktop — a centred card
    • mobile  — a bottom sheet with full-width, thumb-sized buttons + safe-area pad

  Supports an optional middle "discard" action, so it doubles as the three-way
  unsaved-changes prompt (Save & continue / Discard / Cancel), and an optional
  text input (`input`), so it also replaces window.prompt() (confirm emits the
  entered value).
-->
<template>
  <Teleport to="body">
    <div class="cd-backdrop" @click.self="$emit('cancel')">
      <div class="cd-card" role="dialog" aria-modal="true" :aria-label="title">
        <h2 class="cd-title">{{ title }}</h2>
        <p v-if="message" class="cd-message">{{ message }}</p>
        <input
          v-if="input"
          ref="inputEl"
          v-model="localValue"
          class="cd-input"
          :type="inputType"
          :placeholder="inputPlaceholder"
          :disabled="busy"
          @keydown.enter.prevent="onConfirm"
        />
        <div class="cd-actions">
          <button
            class="cd-btn"
            :class="danger ? 'danger-solid' : 'primary'"
            :disabled="busy"
            @click="onConfirm"
          >
            <i v-if="busy" class="pi pi-spin pi-spinner" />
            {{ confirmLabel }}
          </button>
          <button
            v-if="discardLabel"
            class="cd-btn danger"
            :disabled="busy"
            @click="$emit('discard')"
          >{{ discardLabel }}</button>
          <button class="cd-btn ghost" :disabled="busy" @click="$emit('cancel')">
            {{ cancelLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

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
const inputEl = ref<HTMLInputElement | null>(null);

function onConfirm() {
  emit("confirm", props.input ? localValue.value : undefined);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
}
onMounted(() => {
  document.addEventListener("keydown", onKey);
  if (props.input) inputEl.value?.focus();
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<style scoped>
.cd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.55);
  animation: cd-fade 0.15s ease;
}
.cd-card {
  width: 100%;
  max-width: 420px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 1.25rem 1.25rem 1rem;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  animation: cd-pop 0.15s ease;
}
.cd-title {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--c-text);
  margin: 0 0 0.4rem;
}
.cd-message { font-size: 0.85rem; color: var(--c-muted); line-height: 1.45; margin: 0 0 1rem; }

.cd-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  margin: 0 0 1rem;
  background: var(--c-elevated);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-family: var(--font-body);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cd-input:focus { border-color: var(--c-gold); box-shadow: 0 0 0 1px var(--c-gold); }
.cd-input::placeholder { color: var(--c-muted); }

.cd-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.cd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.5rem 0.9rem;
  border-radius: 6px;
  font-family: var(--font-body);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.cd-btn:disabled { opacity: 0.55; cursor: default; }
.cd-btn.primary { background: var(--c-gold); color: #0a0a14; border-color: var(--c-gold); }
.cd-btn.primary:hover:not(:disabled) { background: #dbb85a; }
.cd-btn.danger-solid { background: var(--c-danger); color: #fff; border-color: var(--c-danger); }
.cd-btn.danger-solid:hover:not(:disabled) { background: #c94444; }
.cd-btn.danger { background: transparent; color: var(--c-danger); border-color: var(--c-danger); }
.cd-btn.danger:hover:not(:disabled) { background: rgba(224, 82, 82, 0.15); }
.cd-btn.ghost { background: transparent; color: var(--c-muted); border-color: var(--c-border); }
.cd-btn.ghost:hover:not(:disabled) { color: var(--c-text); border-color: var(--c-border-hi); }

@keyframes cd-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cd-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

/* ── Mobile: bottom sheet with big, thumb-friendly buttons ── */
@media (max-width: 760px) {
  .cd-backdrop { align-items: flex-end; padding: 0; }
  .cd-card {
    max-width: none;
    border-radius: 16px 16px 0 0;
    padding: 1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom));
    animation: cd-slide 0.2s ease;
  }
  .cd-title { font-size: 1.15rem; }
  .cd-message { font-size: 0.9rem; margin-bottom: 1.25rem; }
  /* 16px font stops iOS Safari from zooming in on focus. */
  .cd-input { font-size: 1rem; min-height: 44px; margin-bottom: 1.25rem; }
  /* Stack full-width, primary on top for thumb reach. */
  .cd-actions { flex-direction: column-reverse; gap: 0.6rem; }
  .cd-btn { width: 100%; min-height: 48px; font-size: 0.95rem; }
  @keyframes cd-slide { from { transform: translateY(100%); } to { transform: none; } }
}
</style>
