# AMC Online — Cloudflare port (`cf-port`)

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

## What's in `cf/`

| Path | Runs where | Purpose |
|------|-----------|---------|
| `amc/types.ts` | shared | TS model, field-for-field mirror of the Python dataclasses |
| `amc/parser.ts` | browser | `parseCatalog` / `serializeCatalog` — dependency-free, byte-exact |
| `amc/mapping.ts` | shared | `catalogToRows` (import) / `rowsToCatalog` (export); the poster→R2 split |
| `amc/index.ts` | — | barrel exports |
| `schema.sql` | D1 | tables: `users`, `catalogs`, `custom_field_defs`, `movies`, `movie_extras`, `movies_fts` |
| `worker/index.ts` | Worker | `/api/*` router: auth + CRUD + import commit + export bundle + poster stream |
| `worker/auth.ts` | Worker | WebCrypto PBKDF2 password hashing + HS256 JWT + refresh cookie |
| `worker/db.ts` | Worker | prepared-statement D1 helpers |
| `browser/import.ts` | browser | `importAmcFile(file, opts)` — parse, upload posters, chunked row commit |
| `browser/export.ts` | browser | `exportAmcFile` / `downloadAmcFile` — fetch bundle, rebuild, download |
| `frontend/api.ts` | browser | auth (register/login/refresh/logout) + session + metadata client + re-exports import/export |
| `frontend/CatalogImport.vue` | browser | drag/drop upload with poster+row progress; emits the new catalog id |
| `frontend/CatalogsView.vue` | browser | top-level screen: import, list libraries, export any back to `.amc` |
| `wrangler.jsonc` | — | Worker config (D1 + R2 + static-asset bindings) |

## Data-model decisions

1. **D1 holds metadata only.** Every embedded JPEG (movie poster + extra poster)
   goes to R2; the row stores the R2 **key**, never the bytes. This is the single
   decision that removes the memory problem.
2. **One shared D1, `tenant_id` on the root table** + R2 key prefixes
   (`{tenant}/{catalog}/{movie}.jpg`). Not one-DB-per-user — Cloudflare caps the
   number of databases per account.
3. **Custom-field values stay positional.** The binary stores per-movie custom
   values by position (no per-value tag). `custom_field_defs.ordinal` is
   authoritative; import stores values as a `{tag: value}` JSON map for edit
   ergonomics, export re-expands them to on-disk order via `ordinal`.

## Auth

The Python app used **bcrypt** (12 rounds ≈ tens of ms of pure-JS CPU). That
single hash blows the Workers Free-plan **10 ms CPU/request** budget, so it can't
port as-is. Two options were considered:

- **Cloudflare Access** — a real auth mechanism, but it gates the app behind a
  Zero-Trust org + identity provider *you* administer. Right for a private,
  single-operator deploy; wrong for the stated goal of a generic app strangers
  can self-serve sign up to.
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
**trusted-IP bypass** from the Unraid app is intentionally dropped — a shared
multi-tenant deploy can't blanket-trust an IP.

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
| `POST /api/auth/register` | create account, return access token + set refresh cookie |
| `POST /api/auth/login` | verify credentials, return access token + set refresh cookie |
| `POST /api/auth/refresh` | swap refresh cookie for a fresh access token |
| `POST /api/auth/logout` | clear the refresh cookie |
| `PUT /api/import/poster` (`x-poster-key`, raw body) | store one poster in R2 |
| `POST /api/import/catalog` | create catalog + custom field defs |
| `POST /api/import/movies?catalogId=` | insert a chunk of movies + extras |
| `GET /api/catalogs` | list this tenant's catalogs |
| `GET /api/catalog/:id/info` | catalog header + defs + movie count |
| `GET /api/catalog/:id/movies` | movie grid metadata |
| `GET /api/catalog/:id/export` | full row bundle (poster keys, no bytes) |
| `GET /api/movies/:id` | movie detail + extras |
| `PUT /api/movies/:id` | patch scalar movie columns |
| `DELETE /api/movies/:id` | delete movie (+ its R2 posters) |
| `GET /api/poster?key=` | stream a poster from R2 (tenant-scoped; fetch with the auth header, not a bare `<img src>` — see `posterObjectUrl`) |

## Deploy

```sh
cd cf
npm install                                  # frontend + worker build deps
npx wrangler d1 create amc                  # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create amc-posters
npx wrangler d1 execute amc --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET          # JWT/PBKDF2 signing secret
npm run build                                # vite -> cf/dist (the assets binding)
npx wrangler deploy
```

Dev: run `npx wrangler dev` (local D1 + R2 emulation, serves /api on :8787) and
`npm run dev` (vite on :5173, proxies /api to :8787) side by side.

The frontend is a self-contained vite app in `cf/` (`vite.config.ts`, `index.html`,
`frontend/main.ts` -> `CatalogsView.vue`). `npm run build` emits `cf/dist`, which
`wrangler.jsonc` serves as static assets while the Worker handles `/api/*`.

**megajs needs a Node polyfill in the browser build.** megajs is browser-capable
but its bundle reaches for `Buffer` (AES + attribute packing) and touches
`process`/`global`. `vite.config.ts` wires `vite-plugin-node-polyfills`
(`include: ["buffer","process"]`, `globals` for Buffer/global/process) plus
`define: { global: "globalThis" }` so login and the fingerprinted upload/download
run. Without it you get `Buffer is not defined` at runtime (often only in dev,
where esbuild pre-bundles megajs unpolyfilled). `optimizeDeps.include: ["megajs"]`
routes it through the polyfilled path.

Build deps still not added for the Worker itself: `wrangler` and
`@cloudflare/workers-types` (for `worker/`). See `cf/tsconfig.json`.

## Mega import / export

**Status: implemented** — `browser/mega.ts` (login, fingerprinted upload/download,
folder-path helpers), `frontend/mega.ts` (bridge to import/export + a persisted
path setting), and `MegaSync.vue` (provider picker + connect + list + import) with
a per-catalog "→ Mega" push button in `CatalogsView.vue`. Both concerns below
(fingerprint, credentials) are handled: the fingerprint is computed client-side
(`mega-fingerprint.ts`) and injected as `attributes.c`; login always happens in
the browser (megajs's crypto can't live in a Worker), and the plaintext password
is never handled server-side except to encrypt it (see credential storage below).

The `.amc` needn't sit at the account root: the location is a `"/"`-path
(`megaSettings.path`) that can name a folder to list/push into (`/Backups`) or one
specific file (`/Backups/movies.amc`); `resolveAmcFile` deep-searches by filename
as a fallback. Bind the path input in `MegaSync.vue` — the CF port has no
standalone settings page yet, so the config lives in the Mega panel. Tests:
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
stays in tab memory only and nothing is persisted. `MegaSync.vue` auto-reconnects
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

- **Movie create / renumber.** The `_stored_number` series-remapping logic in
  `movies.py` isn't ported yet; import/edit/export of existing movies is.
- **Picture-from-URL & JPEG normalisation.** `_to_jpeg` used Pillow; in the
  browser use a `<canvas>`, or accept non-JPEG and convert client-side.
- **Scripts / IFS transpiler, settings, Syncthing/Mega sync.** Out of scope for
  the core "upload → edit → export" loop; export-to-cloud-storage can hang off
  `browser/export.ts` (write the Blob to Drive/Mega/S3 instead of downloading).
- **Non-UTF-8 (legacy ANSI) strings — done.** `decodeAmcString`/`encodeAmcString`
  in `parser.ts` mirror Python's `errors="surrogateescape"`: clean UTF-8 decodes
  normally, non-UTF-8 bytes survive as lone low surrogates (U+DC80..U+DCFF) and are
  re-emitted verbatim, so a Windows-1252 catalog round-trips byte-for-byte. The
  maximal-subpart logic (Unicode Table 3-7) is verified against a CPython oracle in
  `amc/parser.test.ts`.
