import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Vite build for the Cloudflare port's browser app.
//
// WHY THE POLYFILL: megajs is browser-capable, but its bundle was written for
// Node — it reaches for `Buffer` (its AES + attribute packing pass buffers
// around) and touches `process`/`global`. In a plain browser bundle those are
// undefined and login/upload throw. vite-plugin-node-polyfills injects browser
// shims so the fingerprinted upload/download in browser/mega.ts actually run.
//
// `include` is narrowed to what megajs needs (buffer + process); `globals`
// makes `Buffer`/`global`/`process` real at runtime. Keep it tight so we don't
// drag the whole Node stdlib into the bundle.
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    nodePolyfills({
      include: ["buffer", "process"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  // esbuild's dep pre-bundling also needs `global` defined while scanning megajs.
  define: { global: "globalThis" },
  optimizeDeps: {
    // Force megajs through the polyfilled path rather than esbuild's own
    // (unpolyfilled) pre-bundle, which is what usually surfaces as
    // "Buffer is not defined" only in dev.
    include: ["megajs"],
  },
  server: {
    // In dev, run `wrangler dev` (serves /api on 8787) alongside `vite`.
    // In production the Worker serves the built assets and /api together, so
    // no proxy is needed there.
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
});
