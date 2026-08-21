// Auto-seeds the LOCAL (miniflare) D1 database before `wrangler dev` boots.
//
// The two-process dev model needs the emulated D1 seeded once, but a fresh
// clone / wiped `.wrangler` state / a DB object that miniflare created but never
// populated all leave it empty — and every `/api/*` route then 500s with
// "no such table" (this bit us on the Mega sign-in path via `user_cloud`).
//
// So: probe for a known baseline table; if it's missing, apply schema.sql then
// the migrations. Both steps are idempotent (schema is CREATE TABLE IF NOT
// EXISTS; `migrations apply` tracks applied files in d1_migrations), so a stray
// run never clobbers data — the probe just keeps the happy path quiet & fast.
//
// LOCAL ONLY. Remote D1 is seeded by setup.sh / `npm run deploy` (--remote).
//
// execSync (single quoted command string, not spawn+args) is deliberate: it runs
// through the platform shell (cmd.exe / sh) so `npx` resolves everywhere and the
// spaced SQL below is passed intact — a spawn args-array under shell:true splits it.
import { execSync } from "node:child_process";

const DB_NAME = "amc";

// stdin=ignore is deliberate: with no TTY, `migrations apply` auto-confirms its
// "about to apply" prompt (wrangler's non-interactive fallback) instead of hanging.
const INHERIT = ["ignore", "inherit", "inherit"];

function isSeeded() {
  try {
    const out = execSync(
      `npx wrangler d1 execute ${DB_NAME} --local --json ` +
        `--command "SELECT name FROM sqlite_master WHERE type='table' AND name='users' LIMIT 1;"`,
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) && parsed[0]?.results?.length > 0;
  } catch {
    return false; // query failed / unparseable → treat as unseeded (seed is idempotent)
  }
}

function seedStep(cmd, label) {
  try {
    execSync(cmd, { stdio: INHERIT });
  } catch {
    console.error(`[seed-local-db] ${label} failed — seed the DB manually (see CLAUDE.md).`);
    process.exit(1);
  }
}

if (isSeeded()) {
  process.exit(0);
}

console.log("[seed-local-db] local D1 is empty — applying schema.sql + migrations…");
seedStep(`npx wrangler d1 execute ${DB_NAME} --local --file=schema.sql`, "schema.sql");
seedStep(`npx wrangler d1 migrations apply ${DB_NAME} --local`, "migrations");
console.log("[seed-local-db] local D1 seeded ✔");
