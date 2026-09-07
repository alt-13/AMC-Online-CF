# AMC Online — Cloudflare port

Get AMC off Unraid and make it usable by people who don't run a server: upload
your `.amc` once, browse and edit it online, export it back whenever you want —
all on Cloudflare's free-ish tier, no always-on box.

## The one problem this solves

The Unraid app loads the **entire catalog into memory** and mutates it in place
(`backend/app/store.py`). A big library with embedded posters is hundreds of MB.
Cloudflare Workers cap each isolate at **128 MB** and are **stateless between
requests** — you can't hold a catalog resident. Porting the Python app as-is is
a non-starter (Pyodide can't run uvicorn/watchdog/Pillow either), and even the
auth path needed rethinking — bcrypt's cost blows the Free-plan CPU budget (see
Auth below).

The fix is to stop treating the catalog as one in-memory object:

```
                    ┌─────────────────────── browser (real memory) ───────────────────────┐
   upload .amc  ──▶ │  parseCatalog()  ──▶  catalogToRows()  ──▶  PUT posters, POST rows    │
                    └───────────────────────────────┬──────────────────────────────────────┘
                                                     ▼
                          ┌──────────── Cloudflare Worker (a few rows/req) ────────────┐
                          │   D1: metadata (movies, defs, extras)                       │
                          │   R2: poster blobs, keyed — never in D1, never in a Worker  │
                          └───────────────────────────────┬────────────────────────────┘
                                                     ▲
                    ┌────────────────────────────────┴──────────────────────────────────┐
   download .amc ◀─ │  GET export bundle  ──▶  fetch posters  ──▶  rowsToCatalog()  ──▶  serializeCatalog() │
                    └──────────────────────── browser (real memory) ──────────────────────┘
```

**The binary parse/serialize only ever runs in the browser.** A Worker request
touches at most a handful of D1 rows and one poster — so 128 MB is never in play.

## What's in this repo

| Path | Runs where | Purpose |
|------|-----------|---------|
| `amc/types.ts` | shared | TS model, field-for-field mirror of the Python dataclasses |
| `amc/parser.ts` | browser | `parseCatalog` / `serializeCatalog` — dependency-free, byte-exact |
| `amc/mapping.ts` | shared | `catalogToRows` (import) / `rowsToCatalog` (export); the poster→R2 split |
| `amc/posterkey.ts` | shared | `sha256Hex` / `blobKey` / `isBlobKey` — content-addressed poster keys |
| `amc/codepages.ts` | shared | bijective Windows-1252/1250/1251 codecs |
| `amc/transcode.ts` | browser | legacy bytes ↔ D1-safe readable Unicode |
| `amc/index.ts` | — | barrel exports |
| `migrations/` | D1 | incremental deltas applied with `wrangler d1 migrations apply` |
| `schema.sql` | D1 | BASELINE tables: `users`, `catalogs`, `custom_field_defs`, `movies`, `movie_extras`, `movies_fts`, `user_cloud`, `user_settings` |
| `worker/index.ts` | Worker | `/api/*` router: auth + CRUD + create + import commit + export bundle + poster stream + cloud + omdb + settings + proxy-image |
| `worker/auth.ts` | Worker | WebCrypto PBKDF2 password hashing + HS256 JWT + refresh cookie |
| `worker/crypto.ts` | Worker | AES-256-GCM encrypt/decrypt for saved cloud credentials (HKDF key off `AUTH_SECRET`) |
| `worker/omdb.ts` | Worker | native IMDb-suggest search + omdbapi.com fetch (needs `OMDB_API_KEY`); pure parsers unit-tested |
| `worker/movie-new.ts` | Worker | `newMovieRow` — build a full movie row (schema defaults + patch) for next-number create |
| `worker/db.ts` | Worker | prepared-statement D1 helpers |
| `browser/import.ts` | browser | `importAmcFile(file, opts)` — parse, upload posters, chunked row commit |
| `browser/export.ts` | browser | `exportAmcFile` / `downloadAmcFile` — fetch bundle, rebuild, download |
| `browser/amcjob.ts` + `amc.worker.ts` + `amcworker.ts` | browser | parse/serialize off the main thread (one Web Worker per job) |
| `browser/pool.ts` / `sweep.ts` | browser | bounded-concurrency task pool / client-driven paged R2 sweeps |
| `browser/mega.ts` + `mega-fingerprint.ts` | browser | megajs login, fingerprinted up/download, folder paths |
| `frontend/syncstatus.ts` / `syncdiff.ts` / `cloudref.ts` | browser | pure sync-status derivation / conflict diff summary / `source_ref` parsing — see `SYNC.md` |
| `frontend/api.ts` | browser | auth + session + metadata client (incl. create/setPictureFromUrl) + omdb + settings + cloud + re-exports import/export |
| `frontend/fields.ts` | browser | shared field metadata (sections, labels, Delphi-date + colour-tag + custom-value helpers) — no store |
| `frontend/CatalogImport.vue` | browser | drag/drop upload with poster+row progress; emits the new catalog id |
| `frontend/CatalogsView.vue` | browser | top-level screen: import, list libraries, export/→Mega, drill into a library |
| `frontend/MovieListView.vue` | browser | two-pane workspace for one catalog: virtualized PrimeVue DataTable (search, create, field-settings) + detail |
| `frontend/MovieDetail.vue` | browser | edit one movie: poster (upload/URL/OMDb), every field (visibility-aware), custom fields, delete |
| `frontend/OmdbDialog.vue` | browser | search IMDb, pick a title, fetch OMDb metadata → emit patch + poster URL |
| `frontend/SettingsDialog.vue` | browser | per-user field visibility (desktop/mobile) + search field; persists to `user_settings` |
| `setup.sh` | — | one-shot bootstrap: provision D1+R2, inject db id, apply schema, set secrets via stdin, deploy |
| `wrangler.jsonc` | — | Worker config (D1 + R2 + static-asset bindings) |

Cloud sync (revision counters, status derivation, conflicts, re-import) has its
own doc: [`SYNC.md`](SYNC.md).

## Data-model decisions

1. **D1 holds metadata only.** Every embedded JPEG (movie poster + extra poster)
   goes to R2; the row stores the R2 **key**, never the bytes. This is the single
   decision that removes the memory problem.
2. **One shared D1, `tenant_id` on the root table** + R2 key prefixes. Not
   one-DB-per-user — Cloudflare caps the number of databases per account.
   Poster keys are **content-addressed**: `{tenant}/{catalog}/blobs/{sha256}.jpg`
   (`amc/posterkey.ts`), so objects are immutable (cacheable for a year) and an
   import can skip bytes R2 already holds. Legacy per-movie keys
   (`{tenant}/{catalog}/{movie}.jpg`) still resolve and are never rewritten.
3. **Custom-field values stay positional.** The binary stores per-movie custom
   values by position (no per-value tag). `custom_field_defs.ordinal` is
   authoritative; import stores values as a `{tag: value}` JSON map for edit
   ergonomics, export re-expands them to on-disk order via `ordinal`.

## Auth

The Python app used **bcrypt** (12 rounds ≈ tens of ms of pure-JS CPU). That
single hash blows the Workers Free-plan **10 ms CPU/request** budget, so it can't
port as-is. Two options were considered:

- **Cloudflare Access** — a real auth mechanism, but it gates the app behind a
  Zero-Trust org + identity provider *you* administer. Overkill for a generic app
  each person deploys to their own Cloudflare account.
- **WebCrypto** (what `root/pm` ships, and what we use): PBKDF2-SHA256 runs in
  native code and HMAC (for JWTs) is microseconds — both comfortably under
  budget without dropping to an insecure round count.

Implementation (`worker/auth.ts`):

- Passwords hashed with **PBKDF2-SHA256, 100k iterations**, stored self-describing
  as `pbkdf2-sha256$<iters>$<salt-b64>$<key-b64>`; verify is timing-safe.
- **HS256 JWTs via WebCrypto HMAC**, token shape `{sub, type, exp, iat}` mirroring
  `auth.py` so the existing frontend expectations (`access_token` in the body)
  hold. `sub` is the user id **and** the tenant id — one identity, no separate
  tenant table.
- Access token (1 h) returned in the JSON body; refresh token (7 d) in an
  `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` cookie. `restoreSession()`
  swaps that cookie for a fresh access token on boot.
- Login runs the verify even for unknown emails (against a dummy hash) to keep
  timing uniform.

Every `/api/*` route except `/api/auth/*` requires a valid Bearer access token;
the resolved `sub` replaces the old `x-tenant-id` header. The single-operator
**trusted-IP bypass** from the Unraid app is intentionally dropped.

**Bootstrap (pm-style).** Registration is *first-run only*: `POST /api/auth/register`
succeeds while the `users` table is empty and returns **403** afterwards. Each
person self-hosts on their own Cloudflare account, so one deploy == one operator ==
one account. `GET /api/auth/status` reports `{ needs_setup }` so the browser gate
shows "create account" on first run and "sign in" forever after. Cloud credentials
are linked to that account via the `user_cloud` table.

Set the signing secret before first deploy: `wrangler secret put AUTH_SECRET`.

## Verified

Both round-trips are **byte-identical** against a v4.2 fixture written by the
Python backend (custom fields, embedded posters, extras):

- `parseCatalog → serializeCatalog` (parser fidelity)
- `parseCatalog → catalogToRows → rowsToCatalog → serializeCatalog` (full D1/R2 path)

Re-run: build a fixture with the Python writer, then round-trip it through the TS
port (see the harness pattern in the commit history under `/tmp/amctest`).

## API surface (Worker)

All routes except `/api/auth/*` require `Authorization: Bearer <access_token>`.

| Method & path | Purpose |
|---|---|
| `GET /api/auth/status` | `{ needs_setup }` — true only on first run (no account yet) |
| `POST /api/auth/register` | first-run only: create the account, return access token + set refresh cookie (403 once one exists) |
| `POST /api/auth/login` | verify credentials, return access token + set refresh cookie |
| `POST /api/auth/refresh` | swap refresh cookie for a fresh access token |
| `POST /api/auth/logout` | clear the refresh cookie |
| `PUT /api/import/poster` (`x-poster-key`, raw body) | store one poster in R2 |
| `POST /api/import/catalog` | create catalog + custom field defs |
| `POST /api/import/movies?catalogId=` | insert a chunk of movies + extras |
| `POST /api/import/abort?catalogId=` | roll back a failed import: drop rows + sweep the R2 poster prefix |
| `GET /api/catalogs` | list this tenant's catalogs |
| `GET /api/catalog/:id/info` | catalog header + defs + movie count |
| `GET /api/catalog/:id/movies?limit=&offset=` | one bounded page of grid metadata + `total` (client walks pages) |
| `GET /api/catalog/:id/export?part=meta\|movies\|extras` | the row bundle (poster keys, no bytes) — **paged, `part` required** |
| `POST /api/catalog/:id/movies` | create a movie: next on-disk `number` + schema defaults + patch |
| `POST /api/catalog/:id/supersede` | after a cloud re-pull, drop older catalogs sharing this one's `source_ref` |
| `DELETE /api/catalog/:id` | delete a catalog (+ all its movies/extras/posters) |
| `GET /api/movies/:id` | movie detail + extras |
| `PUT /api/movies/:id` | patch scalar movie columns |
| `DELETE /api/movies/:id` | delete movie (+ its R2 posters) |
| `GET /api/import/existing-blobs` | which content-addressed keys R2 already holds (skip re-upload) |
| `POST /api/catalog/:id/reimport-begin?cursor=` | replace a catalog's contents in place (paged R2 sweep) |
| `POST /api/catalog/:id/gc-posters?cursor=` | reclaim unreferenced poster blobs, one R2 list page per request |
| `POST /api/catalog/:id/source-ref` | adopt a cloud origin for a catalog that had none |
| `POST /api/catalog/:id/sync-state` | record a push outcome (`synced_rev`, hash, fingerprint, size) |
| `POST /api/catalogs/remote-state` | record a remote-check pass, no download |
| `GET /api/omdb/key` / `PUT /api/omdb/key` | per-user OMDb key (encrypted at rest) |
| `DELETE /api/poster?key=` | drop one poster object (tenant-scoped) |
| `GET /api/poster?key=` | stream a poster from R2 (tenant-scoped; fetch with the auth header, not a bare `<img src>` — see `posterObjectUrl`) |
| `GET /api/omdb/search?q=` | IMDb title suggestions (no key) |
| `GET /api/omdb/fetch?i=` | fetch one title's OMDb metadata → `{ patch, poster_url }` (needs `OMDB_API_KEY`; 503 if unset) |
| `GET /api/proxy-image?url=` | server-side image fetch (IMDb `Referer` + Chrome UA) to dodge CDN CORS, for poster-from-URL |
| `GET /api/settings` / `PUT /api/settings` | per-user field-visibility + search-field JSON blob (`user_settings`) |

## Deploy

### Cloudflare API token

`setup.sh` authenticates via `wrangler login` (browser OAuth) OR a
`CLOUDFLARE_API_TOKEN` env var (headless / CI). If you use a token, create it at
**dash.cloudflare.com → My Profile → API Tokens** with these permissions — the
account *role* doesn't matter, only the scopes ticked on the token itself:

| Scope | Permission | Why |
| --- | --- | --- |
| Account · **D1** | Edit | create the `amc` database, apply the schema |
| Account · **Workers R2 Storage** | Edit | create the `amc-posters` bucket |
| Account · **Workers Scripts** | Edit | deploy the Worker + static assets |
| Zone · **Workers Routes** | Edit | *(custom domain only)* attach `app.example.com` |
| Zone · **DNS** | Edit | *(custom domain only)* the record `custom_domain` creates |
| Zone · **Zone** | Read | *(custom domain only)* resolve the zone |

Shortcut: start from the **"Edit Cloudflare Workers"** template, then **add D1 →
Edit** (not in the template) and the three Zone rows if you're using a custom
domain. Scope the Zone rows to just the domain you're deploying to.

No OMDb secret is required — the OMDb key is set per-user in-app (Settings),
encrypted at rest. See "OMDb key" below.

**One command on a fresh account:**

```sh
./setup.sh
```

`setup.sh` logs in if needed, creates the D1 database + R2 bucket, **writes the
`database_id` into `wrangler.jsonc`**, prompts for an **optional custom domain**
(`wrangler.jsonc` commits its `routes` line commented out, so no operator's
hostname is in git and an untouched clone deploys to
`<name>.<subdomain>.workers.dev`), applies `schema.sql`, sets `AUTH_SECRET`
and (optionally) `ENCRYPTION_SECRET` **via stdin — never the dashboard**, then
builds the frontend and deploys. It's re-runnable (existing resources are
detected and skipped), so it doubles as a rotate-a-secret tool.

The equivalent manual steps:

```sh
npm install                                  # frontend + worker build deps
npx wrangler d1 create amc                  # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create amc-posters
npx wrangler d1 execute amc --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET          # JWT/PBKDF2 signing secret (required)
npm run build                                # vite -> ./dist (the assets binding)
npx wrangler deploy
```

`AUTH_SECRET` (and optional `ENCRYPTION_SECRET`) are the only true secrets
(encrypted secret store, set via stdin). The D1 `database_id` is not sensitive —
it lives in the committed `wrangler.jsonc` and is useless without your account
credentials.

**OMDb key.** Movie-metadata lookup ("⚡ Fetch → new") uses OMDb, which needs a
free key from [omdbapi.com](https://www.omdbapi.com/apikey.aspx). Each user sets
their own in **Settings → OMDb API key**; it's encrypted at rest in
`user_settings.omdb_key` and never leaves the server. An operator *may* still set
a global `OMDB_API_KEY` secret as a shared fallback, but it's optional — the
deploy needs no OMDb secret at all.

Dev: run `npx wrangler dev` (local D1 + R2 emulation, serves /api on :8787) and
`npm run dev` (vite on :5173, proxies /api to :8787) side by side.

The frontend is a self-contained vite app at the repo root (`vite.config.ts`,
`index.html`, `frontend/main.ts` -> `CatalogsView.vue`). `npm run build` emits
`./dist`, which `wrangler.jsonc` serves as static assets while the Worker handles `/api/*`.

**megajs needs a Node polyfill in the browser build.** megajs is browser-capable
but its bundle reaches for `Buffer` (AES + attribute packing) and touches
`process`/`global`. `vite.config.ts` wires `vite-plugin-node-polyfills`
(`include: ["buffer","process"]`, `globals` for Buffer/global/process) plus
`define: { global: "globalThis" }` so login and the fingerprinted upload/download
run. Without it you get `Buffer is not defined` at runtime (often only in dev,
where esbuild pre-bundles megajs unpolyfilled). `optimizeDeps.include: ["megajs"]`
routes it through the polyfilled path.

Build deps still not added for the Worker itself: `wrangler` and
`@cloudflare/workers-types` (for `worker/`). See `tsconfig.json`.

## Mega import / export

**Status: implemented** — `browser/mega.ts` (login, fingerprinted upload/download,
folder-path helpers), `frontend/cloud.ts` (bridge to import/export + the
per-user cloud config), and `CloudSync.vue` (provider picker + connect + list +
import) with
a per-catalog "→ Mega" push button in `CatalogsView.vue`. Both concerns below
(fingerprint, credentials) are handled: the fingerprint is computed client-side
(`mega-fingerprint.ts`) and injected as `attributes.c`; login always happens in
the browser (megajs's crypto can't live in a Worker), and the plaintext password
is never handled server-side except to encrypt it (see credential storage below).

The `.amc` needn't sit at the account root: the location is a `"/"`-path
(the per-user cloud `path`) that can name a folder to list/push into
(`/Backups`) or one
specific file (`/Backups/movies.amc`); `resolveAmcFile` deep-searches by filename
as a fallback. The path input lives in `CloudSync.vue`. Tests:
`mega-paths.test.ts` (path parsing + navigation), `mega-fingerprint.test.ts`, and
the gated `mega.integration.test.ts`.

### Cloud config + credential storage (per user)

Provider, `.amc` path, and an optional saved credential live server-side per user
in the `user_cloud` table — not in `localStorage`, so they follow the account
across browsers. The Worker exposes three authenticated routes (`worker/index.ts`),
all keyed on the JWT's user id:

- `GET  /api/cloud` → `{ provider, path, hasCredential }` — never returns the secret.
- `PUT  /api/cloud` → save `provider`/`path`; `credential` omitted/`""` = keep,
  `null` = forget, a string = encrypt + store.
- `POST /api/cloud/connect` → hands back the **decrypted** credential (404 if none),
  the one call that does so — for the browser to log in with.

Credentials are encrypted at rest with **AES-256-GCM** (`worker/crypto.ts`,
mirroring the pm project's SMTP-password pattern): an HKDF-SHA-256 key derived from
`env.AUTH_SECRET` with a per-purpose `info` label, a random 12-byte IV per record,
stored as `base64(iv‖ciphertext+tag)`. Tests in `worker/crypto.test.ts`
(round-trip, no plaintext leak, distinct IVs, GCM auth rejects a wrong secret).

**Trust model.** "Self-hosting" here means each person deploys the app to their
*own* Cloudflare account — single-operator, single-user. The `AUTH_SECRET` holder
is therefore the same person as the account owner, so server-side encrypt-at-rest
is honest: it protects the credential against a D1 dump or console exposure, and
the decrypted secret only ever round-trips back to that same user's browser (it
has to — megajs runs there). Mega has no OAuth/JWT, so the stored blob is
`{email,password}` JSON; when Drive/Dropbox/S3 land they should use scoped OAuth
refresh tokens instead. The `remember` checkbox is opt-in — unchecked, the session
stays in tab memory only and nothing is persisted. `CloudSync.vue` auto-reconnects
on load when a credential is stored, and offers a "Forget saved login" button.

The original sketch, for reference:

The self-hosted app syncs the `.amc` to Mega.nz through **MEGAcmd**, a native C++
binary bundled in the Docker image. A Worker can't run a native binary, and
doing Mega's crypto in a Worker would fight the CPU/time budget — so on this
branch Mega belongs **in the browser**, bolted onto the export/import flow that
already holds the whole `.amc` Blob in memory.

**Can the SDK run in the browser? Yes.** There's no official JS SDK, but the
community [`megajs`](https://mega.js.org) library is pure JavaScript and runs
in-browser (load via a `<script>` tag → `window.mega`, or bundle it). It ports
Mega's crypto: it uses WebCrypto for AES in Node, but because WebCrypto can't
stream, in the browser it falls back to a pure-JS AES implementation. Mega's API
sends permissive CORS, so a page on your own origin can log in and transfer
directly — no proxying through the Worker.

Sketch:

- **Export → Mega:** `downloadAmcFile()` already produces a `Blob`; instead of
  triggering a download, `new Storage({email, password}).upload(name, buffer)`.
- **Import ← Mega:** `File.fromURL(link).downloadBuffer()` (or list the account
  and pick a file) → feed the bytes to `importAmcFile()` exactly like an upload.

Two things to settle before shipping it:

1. **File fingerprint.** The desktop MEGAsync client refuses files that lack the
   fingerprint attribute ("file fingerprint missing") — this is exactly why the
   self-hosted app dropped rclone for MEGAcmd. Verify `megajs` writes a
   fingerprint on upload; if not, compute and set it, or accept that only the
   web client / this app can read what we upload.
2. **Credentials.** Settled — see "Cloud config + credential storage" above. Login
   is always in the browser; the password reaches the Worker only to be AES-256-GCM
   encrypted at rest (opt-in), never stored in plaintext.

## Still to port (not blocking the data path)

The four "done" items below now ship with a **browser edit UI**, not just an API:
`CatalogsView` drills into `MovieListView` (poster grid + search + create +
field-settings) and then `MovieDetail` (per-field editor honouring the visibility
settings, poster via upload/URL/OMDb, custom fields, delete). `OmdbDialog` and
`SettingsDialog` back the lookup and settings. Field metadata is shared through
`frontend/fields.ts`.

- **Movie create / renumber — done.** `POST /api/catalog/:id/movies` assigns the
  next on-disk `number` (`db.nextMovieNumber`) and fills schema defaults
  (`worker/movie-new.ts`). The Delphi `_stored_number` split is gone by
  construction: the CF schema already separates identity (`id`, uuid PK) from the
  on-disk `number`, so there is nothing to remap.
- **Picture-from-URL & JPEG normalisation — done.** `GET /api/proxy-image` is a
  dumb server-side fetch (IMDb `Referer` + Chrome UA) that dodges the CDN's
  missing CORS headers; the browser then re-encodes to JPEG via an
  `OffscreenCanvas` (`cf.setPictureFromUrl` in `frontend/api.ts`) before the
  bytes land in R2 — image work stays in the browser, like import/export.
- **OMDb / IMDb lookup — done (the only metadata source kept for the POC).**
  `GET /api/omdb/search` (IMDb suggestion API, no key) and `GET /api/omdb/fetch`
  (omdbapi.com, needs `OMDB_API_KEY`) run as plain `fetch()` in the Worker —
  `worker/omdb.ts`, field mapping unit-tested in `omdb.test.ts`. Fetch returns
  `{ patch, poster_url }`: apply the patch via `updateMovie`, then feed
  `poster_url` to `setPictureFromUrl`.
- **Field-visibility settings — done.** `GET`/`PUT /api/settings` persist one
  opaque JSON blob per user (`user_settings` table) — `{ field_visibility:
  { desktop, mobile }, search_field }` — mirroring pm's `settings.json`.
- **`.ifs` web-scraping scripts — dropped, not ported.** The WebSocket runner +
  IFS transpiler + Python subprocess machinery is out of scope; OMDb above
  replaces it as a native lookup. (The `excluded_in_scripts` *data* column stays
  — it's part of the on-disk custom-field format, unrelated to the runner.)
- **Cloud sync (Mega).** See `CloudSync.vue` / `browser/mega.ts` — export-to-cloud
  hangs off `browser/export.ts` (write the Blob to Mega instead of downloading).
- **Non-UTF-8 (legacy ANSI) strings — done.** `decodeAmcString`/`encodeAmcString`
  in `parser.ts` mirror Python's `errors="surrogateescape"`: clean UTF-8 decodes
  normally, non-UTF-8 bytes survive as lone low surrogates (U+DC80..U+DCFF) and are
  re-emitted verbatim, so a Windows-1252 catalog round-trips byte-for-byte. The
  maximal-subpart logic (Unicode Table 3-7) is verified against a CPython oracle in
  `amc/parser.test.ts`.
