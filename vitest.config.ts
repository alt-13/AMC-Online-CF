import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: the unit tests run in real Node and
// rely on the native Buffer (e.g. `Buffer.from(s).toString("base64url")` as the
// oracle for megaB64). If vitest inherited vite.config.ts it would pull in
// vite-plugin-node-polyfills, which swaps in a browser Buffer shim that lacks
// base64url. The polyfill is a *browser build* concern only.
export default defineConfig({
  test: {
    environment: "node",
    include: ["browser/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
