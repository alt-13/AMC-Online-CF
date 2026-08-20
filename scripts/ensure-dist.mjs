// Guarantees ./dist exists so `wrangler dev` can boot its `assets` binding.
//
// In the two-process dev model (see CLAUDE.md "Running / testing"), the UI is
// served by the vite dev server on :5173 and `/api` is proxied to `wrangler dev`
// on :8787 — wrangler's own copy of the assets is never actually used in dev.
// But wrangler still refuses to start if assets.directory (./dist) is missing.
// So drop in a placeholder if there's no real build yet. A real `npm run build`
// (vite) empties and overwrites dist, so this never masks a production bundle.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const indexHtml = join(distDir, "index.html");

if (!existsSync(indexHtml)) {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    indexHtml,
    "<!doctype html><meta charset=utf-8><title>amc dev worker</title>" +
      "<p>Placeholder. The worker is running — open the vite dev server " +
      "(<code>npm run dev</code>, http://localhost:5173) for the UI, or run " +
      "<code>npm run build</code> to serve the real bundle from here.</p>\n",
  );
  console.log("[ensure-dist] created placeholder dist/index.html");
}
