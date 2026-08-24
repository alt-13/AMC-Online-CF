<!--
  App.vue — root of the Cloudflare app. Decides between the auth gate and the
  catalog view. On boot it tries to restore an existing session (httpOnly
  refresh cookie -> access token); if there's none it asks the server whether
  this is first run (no account yet) so LoginView can offer create-vs-sign-in.
-->
<template>
  <div v-if="!ready" class="min-h-dvh flex items-center justify-center text-muted">Loading…</div>
  <LoginView v-else-if="!authed" :setup-mode="setupMode" @authed="authed = true" />
  <CatalogsView v-else />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import LoginView from "./LoginView.vue";
import CatalogsView from "./CatalogsView.vue";
import { auth } from "./api";

const ready = ref(false);
const authed = ref(false);
const setupMode = ref(false);

onMounted(async () => {
  authed.value = await auth.restoreSession();
  if (!authed.value) setupMode.value = await auth.needsSetup();
  ready.value = true;
});
</script>
