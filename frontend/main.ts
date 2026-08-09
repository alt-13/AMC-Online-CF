// Entry point for the Cloudflare port's browser app.
//
// Restores any existing session (httpOnly refresh cookie -> access token) before
// mounting so the catalog list loads without a re-prompt, then shows the
// top-level CatalogsView (import/export + Mega sync).

import { createApp } from "vue";
import CatalogsView from "./CatalogsView.vue";
import { auth } from "./api";

auth.restoreSession().finally(() => {
  createApp(CatalogsView).mount("#app");
});
