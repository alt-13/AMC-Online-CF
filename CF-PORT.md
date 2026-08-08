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
npx wrangler d1 create amc                 # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create amc-posters
npx wrangler d1 execute amc --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET          # JWT/PBKDF2 signing secret
(cd ../frontend && npm ci && npm run build) # builds frontend/dist for the assets binding
npx wrangler deploy
```

Dev: `npx wrangler dev` (uses local D1 + R2 emulation).

Build deps not yet added to a `package.json` here: `wrangler`,
`@cloudflare/workers-types` (for `worker/`), and the DOM lib for `browser/`.
See `cf/tsconfig.json`.

## Still to port (not blocking the data path)

- **Movie create / renumber.** The `_stored_number` series-remapping logic in
  `movies.py` isn't ported yet; import/edit/export of existing movies is.
- **Picture-from-URL & JPEG normalisation.** `_to_jpeg` used Pillow; in the
  browser use a `<canvas>`, or accept non-JPEG and convert client-side.
- **Scripts / IFS transpiler, settings, Syncthing/Mega sync.** Out of scope for
  the core "upload → edit → export" loop; export-to-cloud-storage can hang off
  `browser/export.ts` (write the Blob to Drive/Mega/S3 instead of downloading).
- **Non-UTF-8 strings.** The Python parser uses `surrogateescape` to round-trip
  Windows-1252 bytes. `TextDecoder("utf-8")` is lossy on those; the fixture is
  clean UTF-8. If real files carry ANSI text, add a latin-1 decode path mirroring
  `_s()` in `movies.py` before this ships against legacy catalogs.
