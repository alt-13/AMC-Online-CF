# AMC Online — Cloudflare port (`cf-port`)

Get AMC off Unraid and make it usable by people who don't run a server: upload
your `.amc` once, browse and edit it online, export it back whenever you want —
all on Cloudflare's free-ish tier, no always-on box.

## The one problem this solves

The Unraid app loads the **entire catalog into memory** and mutates it in place
(`backend/app/store.py`). A big library with embedded posters is hundreds of MB.
Cloudflare Workers cap each isolate at **128 MB** and are **stateless between
requests** — you can't hold a catalog resident. Porting the Python app as-is is
a non-starter (Pyodide can't run uvicorn/watchdog/Pillow/bcrypt either).

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
| `schema.sql` | D1 | tables: `catalogs`, `custom_field_defs`, `movies`, `movie_extras`, `movies_fts` |
| `worker/index.ts` | Worker | `/api/*` router: CRUD + import commit + export bundle + poster stream |
| `worker/db.ts` | Worker | prepared-statement D1 helpers |
| `browser/import.ts` | browser | `importAmcFile(file, opts)` — parse, upload posters, chunked row commit |
| `browser/export.ts` | browser | `exportAmcFile` / `downloadAmcFile` — fetch bundle, rebuild, download |
| `frontend/api.ts` | browser | thin metadata client + session (tenant/auth) + re-exports import/export |
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

## Verified

Both round-trips are **byte-identical** against a v4.2 fixture written by the
Python backend (custom fields, embedded posters, extras):

- `parseCatalog → serializeCatalog` (parser fidelity)
- `parseCatalog → catalogToRows → rowsToCatalog → serializeCatalog` (full D1/R2 path)

Re-run: build a fixture with the Python writer, then round-trip it through the TS
port (see the harness pattern in the commit history under `/tmp/amctest`).

## API surface (Worker)

| Method & path | Purpose |
|---|---|
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
| `GET /api/poster?key=` | stream a poster from R2 |

## Deploy

```sh
cd cf
npx wrangler d1 create amc                 # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create amc-posters
npx wrangler d1 execute amc --remote --file=schema.sql
(cd ../frontend && npm ci && npm run build) # builds frontend/dist for the assets binding
npx wrangler deploy
```

Dev: `npx wrangler dev` (uses local D1 + R2 emulation).

Build deps not yet added to a `package.json` here: `wrangler`,
`@cloudflare/workers-types` (for `worker/`), and the DOM lib for `browser/`.
See `cf/tsconfig.json`.

## Still to port (not blocking the data path)

- **Auth.** `backend/app/api/auth.py` (bcrypt + JWT). Tenant currently comes from
  an `x-tenant-id` header — replace `tenant()` in `worker/index.ts` with a
  verified JWT `sub`. bcrypt won't run in a Worker; use WebCrypto PBKDF2/scrypt
  or Cloudflare Access.
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
