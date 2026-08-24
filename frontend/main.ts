// Entry point for the Cloudflare port's browser app.
//
// App.vue owns the auth gate: it restores any existing session (httpOnly
// refresh cookie -> access token) and, when there's none, shows LoginView
// (create-account on first run, otherwise sign-in) before CatalogsView.

import { createApp } from "vue";
import PrimeVue from "primevue/config";
import { definePreset } from "@primevue/themes";
import Aura from "@primevue/themes/aura";
import "primeicons/primeicons.css";
import "./theme.css";
import App from "./App.vue";
import { pruneCachedAmc } from "./amccache";

// Base is the sibling ../AMC-Online CinemaPreset (amber primary). Extended here
// with this fork's navy surface ramp, since Aura's default dark surface is slate
// and this fork has no global page style to override it.
const CinemaPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: "{amber.50}", 100: "{amber.100}", 200: "{amber.200}", 300: "{amber.300}",
      400: "{amber.400}", 500: "{amber.500}", 600: "{amber.600}", 700: "{amber.700}",
      800: "{amber.800}", 900: "{amber.900}", 950: "{amber.950}",
    },
    colorScheme: {
      dark: {
        surface: {
          0: "#e8e0d5",
          50: "#3a3a60", 100: "#2a2a48", 200: "#1f1f38", 300: "#181828",
          400: "#151526", 500: "#131322", 600: "#11111e", 700: "#0e0e18",
          800: "#0c0c15", 900: "#0a0a14", 950: "#080810",
        },
        // Aura's default mapping resolves content/Dialog/Card background to
        // surface.900 (== the page background) and formField background to
        // surface.950 (darker than the page) — so cards/dialogs render flush
        // with the page and inputs look recessed instead of elevated. Override
        // both explicitly to match this fork's card (#181828) / elevated
        // (#1f1f38) convention.
        content: { background: "#181828", borderColor: "#2a2a48", color: "#e8e0d5" },
        formField: {
          background: "#1f1f38", borderColor: "#2a2a48", color: "#e8e0d5",
          hoverBorderColor: "#3a3a60", focusBorderColor: "#c9a84c", placeholderColor: "#7e7a90",
        },
        overlay: {
          modal: { background: "#181828", borderColor: "#2a2a48" },
          popover: { background: "#1f1f38", borderColor: "#2a2a48" },
          select: { background: "#1f1f38", borderColor: "#2a2a48" },
        },
      },
    },
  },
});

document.documentElement.classList.add("dark");

createApp(App)
  .use(PrimeVue, {
    theme: {
      preset: CinemaPreset,
      options: {
        darkModeSelector: ".dark",
        cssLayer: { name: "primevue", order: "theme, base, primevue, utilities" },
      },
    },
  })
  .mount("#app");

void pruneCachedAmc();
