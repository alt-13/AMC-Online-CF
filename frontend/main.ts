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
        // Aura's dark scheme pulls its *foregrounds* out of the surface ramp
        // (text.mutedColor / formField.iconColor / list+navigation icon colors
        // are all {surface.400}) because its stock zinc ramp is LIGHT at 0-400.
        // This fork's ramp is navy and dark the whole way down, so all of those
        // resolved to near-black on a near-black panel — invisible accordion
        // headers and carets, dropdown chevrons, disabled checkmarks and Dialog
        // close buttons. Pin every foreground token to the palette instead of
        // letting it derive from the ramp. (`--color-muted` #7e7a90 is too dim
        // for what Aura uses "muted" for — section headers, toggle icons — so
        // the muted foreground here is a lighter #a09bb4, ~6.6:1 on #181828.)
        text: {
          color: "#e8e0d5", hoverColor: "#f5efe6",
          mutedColor: "#a09bb4", hoverMutedColor: "#c8c3d6",
        },
        formField: {
          background: "#1f1f38", borderColor: "#2a2a48", color: "#e8e0d5",
          hoverBorderColor: "#3a3a60", focusBorderColor: "#c9a84c", placeholderColor: "#7e7a90",
          disabledBackground: "#181828", disabledColor: "#6f6b80", iconColor: "#a09bb4",
        },
        list: { option: { icon: { color: "#a09bb4", focusColor: "#e8e0d5" } } },
        navigation: {
          item: { icon: { color: "#a09bb4", focusColor: "#e8e0d5", activeColor: "#e8e0d5" } },
          submenuIcon: { color: "#a09bb4", focusColor: "#e8e0d5", activeColor: "#e8e0d5" },
        },
        overlay: {
          modal: { background: "#181828", borderColor: "#2a2a48" },
          popover: { background: "#1f1f38", borderColor: "#2a2a48" },
          select: { background: "#1f1f38", borderColor: "#2a2a48" },
        },
      },
    },
  },
  components: {
    // Same ramp problem, one level down: Aura's dark button tokens use
    // {surface.300/400} as the *secondary* foreground and {surface.700/800} as
    // its background/hover. On this ramp that is dark-on-dark, which is what
    // made the Dialog close button (a text+rounded severity="secondary" Button)
    // invisible. Re-map secondary onto the border/elevated steps.
    button: {
      colorScheme: {
        dark: {
          root: {
            secondary: {
              background: "#2a2a48", hoverBackground: "#3a3a60", activeBackground: "#3a3a60",
              borderColor: "#2a2a48", hoverBorderColor: "#3a3a60", activeBorderColor: "#3a3a60",
              color: "#e8e0d5", hoverColor: "#f5efe6", activeColor: "#f5efe6",
            },
          },
          text: {
            secondary: {
              color: "#c8c3d6", hoverBackground: "#2a2a48", activeBackground: "#3a3a60",
            },
          },
          // An outlined button's border matches its own label/icon colour, the
          // way the pre-PrimeVue `.hbtn` did (1px solid var(--c-gold), gold
          // text). Aura instead borders one ramp step darker than the label
          // ({primary.700} under a {primary.color} label), which on this dark
          // navy reads as a muddy brown hairline. One rule, every severity, so
          // "gold icon → gold border" holds wherever `outlined` is used.
          outlined: {
            primary: { borderColor: "{primary.color}" },
            secondary: {
              borderColor: "#c8c3d6", color: "#c8c3d6",
              hoverBackground: "rgba(255,255,255,0.04)", activeBackground: "rgba(255,255,255,0.10)",
            },
            success: { borderColor: "{green.400}" },
            info: { borderColor: "{sky.400}" },
            warn: { borderColor: "{orange.400}" },
            help: { borderColor: "{purple.400}" },
            danger: { borderColor: "{red.400}" },
            contrast: { borderColor: "{surface.0}" },
            plain: { borderColor: "{surface.0}" },
          },
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
