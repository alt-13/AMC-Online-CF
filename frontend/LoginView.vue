<!--
  LoginView.vue — the auth gate for the Cloudflare app.

  pm-style bootstrap: on first run no account exists, so the server reports
  needs_setup and this screen offers "Create account" (register). Once that
  single operator account exists, registration closes and it becomes a plain
  "Sign in". Emits `authed` after a successful register/login so the root can
  swap in CatalogsView.
-->
<template>
  <div class="shell">
    <form class="card" @submit.prevent="onSubmit">
      <div class="head">
        <span class="logo">🎬</span>
        <span class="title">AMC Online</span>
      </div>

      <p v-if="setupMode" class="intro">
        First run — create the account for this catalog. It's the only login on
        this deployment, so keep the password safe.
      </p>

      <label class="field">
        <span class="flabel">Username</span>
        <input
          v-model="username"
          autocomplete="username"
          :disabled="busy"
          autofocus
        />
      </label>

      <label class="field">
        <span class="flabel">Password</span>
        <input
          v-model="password"
          type="password"
          :autocomplete="setupMode ? 'new-password' : 'current-password'"
          :disabled="busy"
        />
        <span v-if="setupMode" class="fhelp">At least 8 characters.</span>
      </label>

      <p v-if="error" class="error">{{ error }}</p>

      <button class="btn" type="submit" :disabled="busy">
        {{ busy ? "…" : setupMode ? "Create account" : "Sign in" }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { auth } from "./api";

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

<style scoped>
.shell {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.card {
  width: 100%;
  max-width: 22rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding: 1.5rem;
  background: var(--c-card, #181828);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: var(--radius, 8px);
}
.head { display: flex; align-items: center; gap: 0.5rem; }
.logo { font-size: 1.4rem; }
.title { font-weight: 600; font-size: 1.15rem; color: var(--c-text, #e8e0d5); }
.intro { margin: 0; font-size: 0.8rem; line-height: 1.4; color: var(--c-muted, #7e7a90); }
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.flabel { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-muted, #7e7a90); }
.fhelp { font-size: 0.72rem; color: var(--c-muted, #7e7a90); }
.field input {
  padding: 0.45rem 0.6rem;
  background: var(--c-elevated, #1f1f38);
  border: 1px solid var(--c-border, #2a2a48);
  border-radius: 6px;
  color: var(--c-text, #e8e0d5);
  font-size: 0.9rem;
}
.error { margin: 0; font-size: 0.8rem; color: #e08a8a; }
.btn {
  margin-top: 0.2rem;
  background: var(--c-gold, #c9a84c);
  color: #0a0a14;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled { opacity: 0.6; cursor: default; }
</style>
