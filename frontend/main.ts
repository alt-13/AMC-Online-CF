// Entry point for the Cloudflare port's browser app.
//
// App.vue owns the auth gate: it restores any existing session (httpOnly
// refresh cookie -> access token) and, when there's none, shows LoginView
// (create-account on first run, otherwise sign-in) before CatalogsView.

import { createApp } from "vue";
import "./theme.css";
import App from "./App.vue";
import { pruneCachedAmc } from "./amccache";

createApp(App).mount("#app");

// Reclaim space from any abandoned .amc download caches (older than a day).
void pruneCachedAmc();
