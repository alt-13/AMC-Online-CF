<!--
  LoginView.vue — the auth gate for the Cloudflare app.

  pm-style bootstrap: on first run no account exists, so the server reports
  needs_setup and this screen offers "Create account" (register). Once that
  single operator account exists, registration closes and it becomes a plain
  "Sign in". Emits `authed` after a successful register/login so the root can
  swap in CatalogsView.
-->
<template>
  <div class="min-h-dvh flex items-center justify-center p-4">
    <form class="w-full max-w-sm flex flex-col gap-3 p-6 bg-card border border-border rounded-lg" @submit.prevent="onSubmit">
      <div class="flex items-center gap-2">
        <span class="text-2xl">🎬</span>
        <span class="font-semibold text-lg text-text">AMC Online</span>
      </div>

      <p v-if="setupMode" class="m-0 text-xs leading-relaxed text-muted">
        First run — create the account for this catalog. It's the only login on
        this deployment, so keep the password safe.
      </p>

      <label class="flex flex-col gap-1">
        <span class="text-xs uppercase tracking-wider text-muted">Username</span>
        <InputText
          v-model="username"
          autocomplete="username"
          :disabled="busy"
          autofocus
          class="w-full"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs uppercase tracking-wider text-muted">Password</span>
        <Password
          v-model="password"
          :feedback="false"
          toggleMask
          inputClass="w-full"
          class="w-full"
          :inputProps="{ autocomplete: setupMode ? 'new-password' : 'current-password' }"
          :disabled="busy"
        />
        <span v-if="setupMode" class="text-xs text-muted">At least 8 characters.</span>
      </label>

      <p v-if="error" class="m-0 text-sm text-danger">{{ error }}</p>

      <Button type="submit" :disabled="busy" :label="busy ? '…' : setupMode ? 'Create account' : 'Sign in'" class="mt-1" />
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { auth } from "./api";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Button from "primevue/button";

const props = defineProps<{ setupMode: boolean }>();
const emit = defineEmits<{ authed: [] }>();

const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");

async function onSubmit() {
  if (!username.value || !password.value) return;
  if (props.setupMode && password.value.length < 8) {
    error.value = "Password must be at least 8 characters.";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    if (props.setupMode) {
      await auth.register(username.value, password.value);
    } else {
      await auth.login(username.value, password.value);
    }
    emit("authed");
  } catch (e) {
    error.value = props.setupMode
      ? "Could not create the account. It may already exist."
      : "Invalid username or password.";
  } finally {
    busy.value = false;
  }
}
</script>
