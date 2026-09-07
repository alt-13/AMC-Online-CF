// Entry point for the Cloudflare port's browser app.
//
// App.vue owns the auth gate: it restores any existing session (httpOnly
// refresh cookie -> access token) and, when there's none, shows LoginView
// (create-account on first run, otherwise sign-in) before CatalogsView.

import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";
import { definePreset } from "@primevue/themes";
import Aura from "@primevue/themes/aura";
import "primeicons/primeicons.css";
import "./theme.css";
import { applyTheme, watchSystemTheme } from "./theme";
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
      // Light mode. Same reason the dark block exists: Aura's stock ramp is a
      // COOL zinc, and this fork's page is warm paper (`--c-*` in theme.css),
      // so PrimeVue panels/inputs would read blue-grey against it. Ramp +
      // pinned foregrounds only — Aura's own light mappings are otherwise
      // mostly fine (a light ramp is what they assume), so only the component
      // re-maps below that fight a *mapping* rather than the ramp
      // (`togglebutton`, `tooltip`, `button.outlined`) carry a light twin.
      light: {
        surface: {
          0: "#fffefa",
          50: "#f7f3ea", 100: "#f0ebe0", 200: "#e6dfd1", 300: "#ddd5c5",
          400: "#c3b9a4", 500: "#a89d86", 600: "#8a8070", 700: "#6d6355",
          800: "#4a4238", 900: "#2b2620", 950: "#1a1712",
        },
        // amber.500 under white text is ~2:1 — unusable as a solid button on
        // paper. Shift primary down the ramp until it carries white text.
        primary: {
          color: "{amber.700}", contrastColor: "#fffefa",
          hoverColor: "{amber.800}", activeColor: "{amber.900}",
        },
        content: { background: "#fffefa", borderColor: "#ddd5c5", color: "#241f1a" },
        text: {
          color: "#241f1a", hoverColor: "#100d0a",
          mutedColor: "#6d6355", hoverMutedColor: "#4a4238",
        },
        formField: {
          background: "#fffefa", borderColor: "#ddd5c5", color: "#241f1a",
          hoverBorderColor: "#c3b9a4", focusBorderColor: "#8a6d1f", placeholderColor: "#6d6355",
          disabledBackground: "#f0ebe0", disabledColor: "#8a8070", iconColor: "#6d6355",
        },
        overlay: {
          modal: { background: "#fffefa", borderColor: "#ddd5c5" },
          popover: { background: "#fffefa", borderColor: "#ddd5c5" },
          select: { background: "#fffefa", borderColor: "#ddd5c5" },
        },
      },
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
    // Third instance of the ramp problem, this time inverted. A chip (the
    // InputChips values under Settings → Series count) is meant to read as a
    // value RAISED on the field, but Aura's dark chip background is
    // {surface.800} — on this navy ramp #0c0c15, i.e. darker than the #1f1f38
    // form field it sits inside, so each chip looks like a hole punched in the
    // input. Re-map onto the border/elevated steps, the same way button's
    // secondary is re-mapped below.
    chip: {
      colorScheme: {
        dark: {
          root: { background: "#2a2a48", color: "#e8e0d5" },
          icon: { color: "#a09bb4" },
          removeIcon: { color: "#a09bb4" },
        },
      },
    },
    // Fourth instance of the ramp problem (Settings → Appearance). A
    // SelectButton is a row of ToggleButtons, and Aura's dark tokens paint the
    // UNSELECTED label {surface.400} on a {surface.950} track — light-grey on
    // near-white with the stock zinc ramp, but #151526 on #080810 here, i.e.
    // invisible. Only the checked item ({surface.0}) survived. Pin the track,
    // the pill and all three label states to the palette instead. Light needs
    // it too, one notch milder: {surface.500} on {surface.100} is ~2.2:1.
    togglebutton: {
      colorScheme: {
        light: {
          root: {
            background: "#e6dfd1", checkedBackground: "#e6dfd1", hoverBackground: "#e6dfd1",
            borderColor: "#e6dfd1", checkedBorderColor: "#e6dfd1",
            color: "#6d6355", hoverColor: "#241f1a", checkedColor: "#241f1a",
          },
          content: { checkedBackground: "#fffefa" },
          icon: { color: "#6d6355", hoverColor: "#241f1a", checkedColor: "#241f1a" },
        },
        dark: {
          root: {
            background: "#11111e", checkedBackground: "#11111e", hoverBackground: "#11111e",
            borderColor: "#11111e", checkedBorderColor: "#11111e",
            color: "#a09bb4", hoverColor: "#e8e0d5", checkedColor: "#f5efe6",
          },
          content: { checkedBackground: "#2a2a48" },
          icon: { color: "#a09bb4", hoverColor: "#e8e0d5", checkedColor: "#f5efe6" },
        },
      },
    },
    // Every hint in the app is `v-tooltip`, not a native `title=`: a native
    // tooltip is painted by the browser from the OS theme, so it ignored the
    // light scheme entirely and stayed dark-on-dark. Aura's own tooltip is
    // {surface.700} — fine light, but #0e0e18 on this dark ramp, i.e. flush
    // with the page — so both schemes get a step that actually separates.
    tooltip: {
      colorScheme: {
        light: { root: { background: "#4a4238", color: "#fffefa" } },
        dark: { root: { background: "#2a2a48", color: "#f5efe6" } },
      },
    },
    inputchips: {
      colorScheme: {
        // `focusColor`, not `color`: the stylesheet reads
        // dt('inputchips.chip.focus.color') for the focused chip, so a plain
        // `color` here emits --p-inputchips-chip-color, which nothing consumes.
        dark: { chip: { focusBackground: "#3a3a60", focusColor: "#f5efe6" } },
      },
    },
    // Same ramp problem, one level down: Aura's dark button tokens use
    // {surface.300/400} as the *secondary* foreground and {surface.700/800} as
    // its background/hover. On this ramp that is dark-on-dark, which is what
    // made the Dialog close button (a text+rounded severity="secondary" Button)
    // invisible. Re-map secondary onto the border/elevated steps.
    button: {
      colorScheme: {
        // Only `outlined` needs a light twin — same rule as dark ("gold icon →
        // gold border"). Aura light breaks it the same way, one ramp step
        // lighter than the label ({x.200} border under an {x.500} label), which
        // on paper is a near-invisible pastel hairline — the Delete film button
        // read as unbordered next to Fetch. Border = label, every severity.
        light: {
          outlined: {
            primary: { borderColor: "{primary.color}" },
            secondary: { borderColor: "#6d6355", color: "#4a4238" },
            success: { borderColor: "{green.500}" },
            info: { borderColor: "{sky.500}" },
            warn: { borderColor: "{orange.500}" },
            help: { borderColor: "{purple.500}" },
            danger: { borderColor: "{red.500}" },
            contrast: { borderColor: "{surface.950}" },
            plain: { borderColor: "{surface.950}" },
          },
        },
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

applyTheme();
watchSystemTheme();

createApp(App)
  .directive("tooltip", Tooltip)
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
