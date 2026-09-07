# AMC-Online-CF — Claude Project Context

Web app for browsing and editing Ant Movie Catalog (`.amc`) binary files, ported
to **Cloudflare serverless** (Workers + D1 + R2).

This repo is a **standalone extraction** of the Cloudflare port that used to live
under `cf/` in the [AMC-Online](https://github.com/alt-13/AMC-Online) monorepo
(the original self-hosted FastAPI + Vue version still lives there on `main`). The
port's files now sit at the repo root instead of under `cf/`.

Two things are **not** in this repo — they stay in the AMC-Online monorepo and are
shared reference only:

- The **self-hosted Vue frontend** (`frontend/src/` on `main`). `frontend/` here is
  a separate fork of it (its own components, no Pinia store). It now uses
  **Tailwind v4 (inline utilities) + PrimeVue v4** — like the monorepo frontend uses
  PrimeVue, but themed independently — so the two are **no longer kept
  source-comparable by hand**; only the rendered look is kept in the same cinema
  spirit. They share no code. Styling lives inline in the SFCs; the palette is the
  Tailwind `@theme inline` block in `frontend/theme.css` and the PrimeVue
  `CinemaPreset` (an Aura preset, adapted from the monorepo) is defined in
  `frontend/main.ts`. Both carry a **light and a dark scheme** — see rule 18. The
  only remaining `<style>` blocks are `MovieDetail.vue`'s lightbox `@keyframes` and
  `MovieListView.vue`'s workspace grid + a small DataTable `:deep()`.
- The **binary-format reference material**: the Delphi sources
  (`original/amc_sources/…/*.pas`), the Python reference parser
  (`backend/app/parser/amc_file.py`), and `BinaryFormatResearch.md`. The `.amc`
  format is shared, so those remain the source of truth the TS port mirrors.

> Read [`CF-PORT.md`](CF-PORT.md) first — it's the architecture spec (data flow,
> data-model decisions, API surface, auth, deploy).

---

## The core idea (why this port exists)

The self-hosted app loads the **entire catalog into memory** and mutates it in
place. With embedded posters that's hundreds of MB. Cloudflare Workers cap each
isolate at **128 MB**, are **stateless between requests**, and on the Free plan
allow **~10 ms CPU/request**. You cannot hold a catalog resident, and you cannot
run FastAPI/Pillow/bcrypt there.

The fix: **stop treating the catalog as one in-memory object.**

- The binary **parse/serialize runs ONLY in the browser** (`amc/parser.ts`), where
  there is real memory.
- The Worker only ever touches a **few D1 rows + at most one poster** per request.
- **D1 holds metadata only.** Every embedded JPEG goes to **R2**; the row stores
  the R2 object key, never the bytes.
- **Multi-tenant** via `tenant_id` (== the user id) on the root table + R2 key
  prefixes `{tenant}/{catalog}/{movie}.jpg`. One shared D1 (Cloudflare caps
  databases per account, so not one-DB-per-user).

```
upload:   browser: parseCatalog → catalogToRows → PUT posters(R2) + POST rows(D1)
export:   browser: GET bundle(D1) → fetch posters(R2) → rowsToCatalog → serializeCatalog → Blob
```

---

## Project structure

```
.
├── amc/
│   ├── types.ts        ← TS model; field-for-field mirror of the Python dataclasses
│   ├── parser.ts       ← ByteReader/ByteWriter + parseCatalog/serializeCatalog (byte-exact)
│   ├── codepages.ts    ← bijective Windows-1252/1250/1251 decode/encode (legacy ANSI codecs)
│   ├── transcode.ts    ← detectEncoding + toReadable(import)/toRaw(export): legacy bytes ↔ readable D1-safe Unicode (rule 5)
│   ├── posterkey.ts    ← sha256Hex/blobKey/isBlobKey: content-addressed poster keys (rule 15)
│   └── mapping.ts      ← catalogToRows (import) / rowsToCatalog (export); the poster→R2 split
├── schema.sql          ← D1 BASELINE: users, catalogs, custom_field_defs, movies, movie_extras, movies_fts, user_cloud, user_settings
├── migrations/         ← incremental deltas applied via `wrangler d1 migrations apply` (0001 catalogs.text_encoding, 0002 multi-provider user_cloud, 0003 sync tracking, 0004 sort_title → expression index)
├── worker/
│   ├── index.ts        ← /api/* router: auth gate + CRUD + create + import/export + poster + /api/cloud + sync state + omdb + settings + proxy-image
│   ├── auth.ts         ← WebCrypto PBKDF2 password hashing + HS256 JWT + refresh cookie
│   ├── crypto.ts       ← AES-256-GCM encrypt/decrypt for cloud creds (HKDF key off AUTH_SECRET)
│   ├── omdb.ts         ← native IMDb-suggest search + omdbapi.com fetch (needs OMDB_API_KEY); pure parsers unit-tested
│   ├── movie-new.ts    ← newMovieRow: build a full movie row from an edit patch (next-number create)
│   └── db.ts           ← prepared-statement D1 helpers (Env binding lives here) + user_cloud + user_settings + SORT_TITLE_SQL (listMovies MUST order by it verbatim, else idx_movies_sort is ignored; 0004 dropped movies.sort_title)
├── browser/
│   ├── import.ts       ← importAmcFile(file, opts): parse, upload posters, chunked row commit
│   ├── export.ts       ← exportAmcFile/downloadAmcFile: fetch bundle, rebuild, download
│   ├── amcjob.ts       ← the two CPU-bound halves (parse→rows, rows→bytes) as one pure runAmcJob
│   ├── amc.worker.ts   ← Web Worker shim over runAmcJob
│   ├── amcworker.ts    ← spawn/transfer/terminate one worker per job; runs inline where Worker is absent
│   ├── pool.ts         ← runPool: bounded-concurrency task pool
│   ├── sweep.ts        ← sweepAll: client loop that drives the Worker's bounded R2 sweeps
│   ├── cloudpath.ts    ← the provider-neutral `.amc` path grammar (splitAmcPath/isAmcName)
│   ├── mega.ts         ← megajs login + fingerprinted up/download + folder resolution
│   └── mega-fingerprint.ts ← client-side Mega fingerprint (MEGAsync rejects files without it)
├── frontend/
│   ├── api.ts          ← auth (status/register/login/refresh/logout) + session + metadata client (incl. create/setPictureFromUrl) + omdb + settings + cloud config + re-exports
│   ├── fields.ts       ← shared field metadata: sections/labels, Delphi-date + colour-tag + custom-value helpers, AppSettings + SeriesRule/countSeries (no store)
│   ├── connector.ts    ← the CloudConnector seam + provider registry (add a backend = 1 file + 1 line)
│   ├── connector-mega.ts  ← Mega.nz behind the seam (megajs, folder handles, `c` fingerprint)
│   ├── connector-drive.ts ← Google Drive behind the seam (REST + GIS token client, resumable upload)
│   ├── cloud.ts        ← bridge: connector ↔ import/export; per-user cloud config + remember-me. PROVIDER-FREE
│   ├── cloudref.ts     ← catalog ↔ remote-file reference bookkeeping (source_ref/locator parsing)
│   ├── syncstatus.ts   ← deriveStatus: the ONE pure sync-status derivation (see SYNC.md)
│   ├── syncdiff.ts     ← read-only local-vs-remote diff summary for the conflict dialog
│   ├── amccache.ts     ← Cache Storage for downloaded .amc blobs (pruned on boot)
│   ├── nav.ts          ← history-stack helper so hardware Back closes a view, not the app
│   ├── wakelock.ts     ← hold a screen wake lock across long imports/exports
│   ├── theme.css       ← `@theme inline` → the var(--c-*) palette, defined twice (:root = light, .dark = dark)
│   ├── theme.ts        ← light/dark mode: the `.dark` class on <html>, localStorage, "system" follows the OS
│   ├── main.ts         ← app bootstrap + apply the theme + the PrimeVue `CinemaPreset` (Aura, light + dark)
│   ├── CloudSync.vue       ← provider picker + connect + list + import; auto-reconnect
│   ├── CatalogImport.vue   ← drag/drop upload with poster+row progress
│   ├── CatalogsView.vue    ← top-level screen: import, list catalogs, export/→Mega, drill into a library
│   ├── MovieListView.vue   ← two-pane workspace for one catalog: virtualized PrimeVue DataTable (search, create, field-settings) + MovieDetail; lazy-loaded chunk
│   ├── MovieDetail.vue     ← edit one movie: poster (upload/URL/OMDb), every field (visibility-aware), custom fields, delete
│   ├── ConflictDialog.vue  ← both sides moved: pick push/pull, with an opt-in remote compare
│   ├── OmdbDialog.vue      ← search IMDb, pick a title, fetch OMDb → patch + poster URL
│   ├── SERIES-RULES.md     ← why "series" is user-configured, and the planned rule kinds
│   └── SettingsDialog.vue  ← light/dark mode (device-local) + per-user field visibility (desktop/mobile) + search field + duplicate-warning field + series-count rule + OMDb key → user_settings
├── scripts/            ← predev hooks: ensure-dist (assets placeholder) + seed-local-db (auto-seed emulated D1)
├── setup.sh            ← one-shot bootstrap: provision D1+R2, inject db id, apply schema, set secrets via stdin, deploy
├── wrangler.jsonc      ← Worker config: D1 (DB), R2 (R2), assets (ASSETS) bindings
├── vite.config.ts      ← frontend build + megajs node-polyfill wiring + /api dev proxy
├── tsconfig.json
├── SYNC.md             ← cloud sync: revisions, status derivation, conflicts (rule 16)
└── CF-PORT.md          ← architecture doc (start here)
```

This is a single Vite project — frontend + worker + browser modules share one
`package.json` at the root.

---

## Critical rules

These carry over from the format itself and MUST hold in the TS port.

**1. Round-trip fidelity is a hard gate.**
`parseCatalog → serializeCatalog` and the full `parseCatalog → catalogToRows →
rowsToCatalog → serializeCatalog` path must both be **byte-identical** to the
input. Both are verified against a v4.2 fixture written by the Python backend. A
regression here means the app corrupts people's `.amc` files on export. Never
merge a parser/mapping change without re-running both round-trips.

**2. Custom fields are positional, not tagged.**
In file mode the binary stores N bare Pascal strings in the same order as
`custom_field_defs`. There is no count prefix and no per-value tag. `mapping.ts`
stores them as a `{tag: value}` JSON map (`movies.custom_values`) for edit
ergonomics and **re-expands them to on-disk order on export via
`custom_field_defs.ordinal`**. `ordinal` is authoritative — never reorder defs.

**3. Ratings are stored ×10.** The binary stores ratings as int×10 (86 = 8.6);
`-1` = unset. The DB keeps them the same way; the Vue form shows 0.0–10.0.

**4. Embedded pictures must round-trip with `pic_path=".jpg"`.**
The Delphi app's `GetPictureStatus()` returns "no picture" when `PicPath` is
empty, regardless of `PicData`. Any movie that has poster bytes must carry a
non-empty `pic_path` (`.jpg`) or the original AMC desktop app won't show the
image. On import, `mapping.ts` moves the bytes to R2 (`poster_key`) but preserves
`pic_path`; on export it must re-emit `pic_path` alongside the poster bytes.

**5. Non-UTF-8 (legacy ANSI) strings — handled, keep it byte-exact.**
Legacy .amc files from the Delphi app store strings as Windows-1252 (ANSI), not
UTF-8. `parser.ts` decodes/encodes via `decodeAmcString`/`encodeAmcString`, which
mirror Python's `errors='surrogateescape'`: clean UTF-8 decodes normally, and any
byte that isn't well-formed UTF-8 is preserved as a lone low surrogate
(U+DC80..U+DCFF) and re-emitted verbatim on export. This keeps parse → serialize
byte-identical for both encodings. The surrogateescape logic follows Unicode
Table 3-7 "maximal subpart" and is verified against a CPython oracle in
`amc/parser.test.ts` — do not swap in a plain `TextDecoder('utf-8')` (lossy: it
replaces bad bytes with U+FFFD and corrupts legacy catalogs on export).

BUT `parser.ts`'s surrogate representation is **binary-safe, not storage-safe**:
a lone surrogate (U+DC80..U+DCFF) has no UTF-8 encoding, so the moment it is
bound into a D1 TEXT column (SQLite is UTF-8) it becomes U+FFFD "�" — corrupting
both display and export (this was a real bug: legacy umlauts showed as `�`). So a
transcode layer sits at the **browser** storage boundary (never the Worker — its
`TextDecoder` doesn't do legacy pages):

- `amc/codepages.ts` — bijective decode/encode for Windows-1252/1250/1251 (total,
  lossless single-byte tables, so byte-exact round-trip holds).
- `amc/transcode.ts` — `detectEncoding` (auto-detects the codepage by scoring how
  word-like each candidate makes the non-UTF-8 bytes; ties → Windows-1252),
  `toReadable` (import: raw legacy bytes → readable Unicode, D1-safe) and `toRaw`
  (export: the exact inverse). The bridge REUSES `encode/decodeAmcString`, so the
  full chain is lossless.
- `catalogs.text_encoding` persists the detected page ('utf-8' | 'windows-125x');
  `import.ts` sets it, `export.ts` re-encodes with it so the .amc stays byte-exact.

Round-trip fidelity (rule 1) MUST be tested **through the D1 boundary**, not only
in memory — see the full browser→D1→browser→export test in `amc/transcode.test.ts`
(the in-memory-only test missed the U+FFFD corruption entirely). Auto-detection
can't perfectly separate Latin-1 vs Latin-2 for some CE languages; `detectEncoding`
takes an optional override for that (import.ts `legacyEncoding`).

**6. Version gates (read v3.1–v4.2, write v4.2).**
`iColorTag` added v4.1; `iDateWatched`, `iUserRating`, `strWriter`,
`strComposer`, `strCertification`, `strFilePath`, and the Extras block all added
v4.2. `custom_field_defs` (catalog header) is v4.0+. `parser.ts` gates fields on
the detected header version exactly as the Delphi/Python readers do.

## Critical rules — Cloudflare specifics

**7. D1 is metadata only; R2 holds every poster.** Never store image bytes in a
D1 column. A Worker request must never load more than a handful of rows + one
poster, or it risks the 128 MB / 10 ms limits. Any R2 sweep is **paged**: the
Worker does one list page per request and returns a `cursor`/`next`, the browser
loops it (`browser/sweep.ts`). Never write an unbounded server-side sweep.

**8. Everything is tenant-scoped; `sub` == `tenant_id`.** Every `/api/*` route
except `/api/auth/*` requires a valid Bearer access token; the JWT `sub` is the
user id AND the tenant id. `getCatalog(env, tenantId, id)` and `ownedMovie()`
enforce ownership — never query a catalog/movie without the tenant filter.
Poster keys are checked to start with `${tenant}/`.

**9. Auth is WebCrypto, never bcrypt.** bcrypt (12 rounds) alone blows the 10 ms
CPU budget. `worker/auth.ts` uses **PBKDF2-SHA256 (100k iters)** for passwords
and **HS256 JWT via WebCrypto HMAC** for tokens. Hash format is self-describing:
`pbkdf2-sha256$<iters>$<salt-b64>$<key-b64>`. Access token (1 h) in the response
body; refresh token (7 d) in an `HttpOnly; Secure; SameSite=Strict;
Path=/api/auth` cookie. Login verifies against a dummy hash for unknown emails to
keep timing uniform. Set the signing secret with `wrangler secret put
AUTH_SECRET`. The self-hosted app's **trusted-IP bypass is intentionally dropped**.
**Registration is first-run only (pm-style bootstrap):** `POST /api/auth/register`
works while `users` is empty, then returns 403 — one deploy is one operator.
`GET /api/auth/status` → `{ needs_setup }` drives the browser gate (create vs.
sign in). Cloud credentials link to the account via the `user_cloud` table.

**10. `/api/poster` is Bearer-gated, so a bare `<img src>` will 401.** An image
tag can't send an Authorization header. Use `cf.posterObjectUrl(key)` (fetch the
bytes with the session header → `URL.createObjectURL`) and revoke it when the
element unmounts. `posterUrl()` is kept only for a future cookie-auth path.

**11. Imports are chunked and idempotent-ish per catalog.** `importAmcFile`
uploads posters first (PUT `/api/import/poster`), then POSTs the catalog +
custom-field defs, then POSTs movies in chunks (default 200) to
`/api/import/movies`. Keep chunk sizes small enough that a single request stays
well under Worker limits.

**12. `movies.number` is user-editable, non-unique, and int32-bounded.** It is the
on-disk catalog number and it is the one column a user can freely collide: real
catalogs are full of duplicates and 0s, so `schema.sql` deliberately carries **no
`UNIQUE(catalog_id, number)`** (a unique constraint would reject those imports).
`nextMovieNumber()` (MAX+1) only picks a number on CREATE — it is a convenience,
not a guarantee, and an edit may change it afterwards. Two things follow:

- **Clamp it.** The exporter writes it with `w.i32` → `setInt32(v | 0)`, which
  **wraps silently**, so a value wider than `MAX_INT32` (`amc/types.ts`) would
  come back out of the `.amc` as a negative — a rule 1 violation reached through
  the edit form. `normalizeMovieNumber()` in `worker/db.ts` clamps at the storage
  boundary; the form clamps too, but the Worker is the one that must hold.
- **Never infer "series" from it.** There is no series flag in the format, and
  what makes an entry a series is a per-catalog convention (`number = 1` for all
  of them, one number shared by a series' episodes, a certification string, a
  custom field, …). The user states the rule — `SeriesRule`/`countSeries` in
  `frontend/fields.ts`, persisted as `series_rule` in `user_settings`, **default
  off**. See [`frontend/SERIES-RULES.md`](frontend/SERIES-RULES.md). Don't add a
  heuristic default.

**13. `movies.checked` ("Watched") is derived from `date_watched` — by default.**
The format stores both and never links them, so whether `checked` means "watched"
is the user's convention: `checked_separate` in `user_settings` (**default
false** = synced) decides.

- **Synced (default).** The detail form has no Watched control: setting a Date
  Watched marks the film watched, clearing it marks it unwatched (`dateWatched`
  in `MovieDetail.vue`), and the header badge is read-only display. It reads the
  **stored flag**, not the date, so a legacy row ticked in the Delphi app with no
  date still reads (and exports as) watched — nothing rewrites `checked` unless
  the date is edited.
- **Separate.** `dateWatched` stops writing `checked`; a "Checked" checkbox
  appears under Color Tag and owns the flag. The header badge then reads the
  **date** (the flag no longer means watching), and the list's `pi pi-eye` marker
  is retitled "Checked".

Both modes share the `checked` visibility key (labelled "Watched / Checked").

**14. Per-user settings need no migration.** `user_settings` holds one opaque
JSON blob. The Worker's `DEFAULT_SETTINGS` in `worker/index.ts` is spread
*under* the parsed blob on GET, so adding a key there + to `AppSettings`/
`DEFAULT_SETTINGS` in `frontend/fields.ts` backfills every existing user. Keep
the two in sync — they are the same shape written twice.

**15. Poster keys are content-addressed and immutable.**
`{tenant}/{catalog}/blobs/{sha256}.jpg` (`amc/posterkey.ts`). The key IS the hash,
so an object never changes: `/api/poster` serves blob keys `immutable` for a year,
an import can skip bytes R2 already holds (`GET /api/import/existing-blobs`), and
"same artwork?" is answerable without a movie identity the `.amc` format doesn't
provide. Consequences:

- A changed poster **writes a new key and leaves the old object behind** — it may
  be shared by identical artwork, so no write path may delete it. Reclaim happens
  only in `POST /api/catalog/:id/gc-posters`, which skips objects younger than 1 h
  (an import PUTs blobs before committing the rows referencing them).
- Legacy per-movie keys are never rewritten; both shapes coexist and `isBlobKey`
  decides the cache policy. `isBlobKey` rejects traversal via its explicit
  `includes("..")` guard, **not** the regex — keep the guard.

**16. Cloud sync state lives in one place.** `content_rev`/`synced_rev` on
`catalogs`, derived by the single pure `deriveStatus` in `frontend/syncstatus.ts`.
Ambiguity always resolves away from "synced", and rows are never merged by
`number + title`. See [`SYNC.md`](SYNC.md) before touching sync, conflicts, or
re-import.

**17. Keep this file (and its satellites) up to date.** A change that alters
anything a future session would otherwise have to re-derive — a new rule of the
format, a new module or table, a route surface change, an invariant, a settings
key, a dev-workflow step — updates the docs **in the same commit** as the code.
Corollary: keep it short. A rule that grows past ~15 lines moves into its own
`.md` linked from here (`CF-PORT.md`, `SYNC.md`, `frontend/SERIES-RULES.md`) —
next to the source it describes when one directory owns it — leaving a two-line
pointer behind. Delete what stopped being true instead of appending
next to it.


**18. Light/dark mode has ONE switch: the `.dark` class on `<html>`.**
It drives the palette *and* PrimeVue (`darkModeSelector: ".dark"`), so both
schemes must be defined in both places:

- `frontend/theme.css` — `@theme inline` maps every `--color-*` onto a
  `var(--c-*)`, so a utility (`bg-card`) emits the variable, not a resolved
  hex; `:root` holds the light values and `.dark` the dark ones. `inline` is
  what makes the cascade able to re-point a utility — drop it and both schemes
  render the same. Never hardcode a scheme's hex in an SFC; add a `--c-*`.
- `frontend/main.ts` — `CinemaPreset` needs a `colorScheme.light` too: Aura's
  stock ramp is cool zinc and this fork's light page is warm paper.
- `frontend/theme.ts` owns the class. The mode is **device-local**
  (`localStorage`, not `user_settings`) — one account, two screens, two modes —
  and `index.html` re-applies it inline before first paint to avoid a flash.
- Hints are `v-tooltip` (directive registered in `main.ts`), **never a native
  `title=`**: the browser paints a native tooltip from the OS theme, so it can't
  follow the page scheme. `title=` is still the right thing on `ConfirmDialog`,
  where it's a prop, not an attribute. An icon-only control keeps an
  `aria-label` — the tooltip is not an accessible name.

---

## Git workflow — branching

Fixes and very small features (**1–3 commits**) may commit directly on the
current branch, **including `main`**. Anything larger gets a feature branch
first, then a `--ff-only` merge back. When unsure, **ask before committing**.
Pushing is always a separate, explicit ask.

---

## Running / testing

Single Vite project (frontend + worker + browser modules, one `package.json`).
Dev is **two processes**: `wrangler dev` serves `/api` on :8787 with local D1 + R2
emulation, and `vite` serves the frontend and proxies `/api` → :8787
(`vite.config.ts` `server.proxy`).

```sh
npm ci                 # once

# run BOTH (two terminals / two IntelliJ npm run configs):
npm run dev:worker     # wrangler dev  → Worker + local D1/R2 on :8787
npm run dev            # vite          → frontend on :5173, proxies /api → :8787
```

`dev:worker` has a `predev:worker` hook that runs two scripts before `wrangler
dev` boots:
- `scripts/ensure-dist.mjs` drops a placeholder `dist/index.html` if there's no
  build yet — wrangler's `assets` binding refuses to boot without `./dist`, and in
  the two-process model you use vite's :5173 for the UI so wrangler's assets copy
  is unused anyway. A real `npm run build` overwrites the placeholder.
- `scripts/seed-local-db.mjs` **auto-seeds the emulated D1** on first run: it
  probes for the `users` table and, if the local DB is empty (fresh clone / wiped
  `.wrangler` state), applies `schema.sql` + migrations. Both steps are idempotent,
  so it's a no-op (quiet, fast) once seeded. This is why a missing `user_cloud`
  table no longer 500s the Mega sign-in path on a fresh checkout.

To seed the emulated D1 manually (the auto-seed does this for you):

```sh
npx wrangler d1 execute amc --local --file=schema.sql
npx wrangler d1 migrations apply amc --local
```

Production-like single server (Worker serves built assets + `/api` together, no
Vite proxy — matches deploy):

```sh
npm run build          # → ./dist (served via the `assets` binding)
npx wrangler dev
```

Unit tests (parser round-trips, auth crypto, omdb parsers, mega + drive paths):

```sh
npm test               # vitest run
```

Round-trip check (the important one): parse a fixture through the TS port and
diff bytes. Both parser-only and full D1/R2-path round-trips must produce
byte-identical output — see `amc/parser.test.ts` and `amc/transcode.test.ts`.

Deploy: see [`CF-PORT.md`](CF-PORT.md) / [`README.md`](README.md).

---

## AMC file format quick reference

- Header: 65-byte fixed ASCII string (e.g. `" AMC_4.2 Ant Movie Catalog 4.2.x   antp/soulsnake    www.antp.be "`)
- Strings: 4-byte LE uint32 length + UTF-8 bytes (images: raw bytes, no length-as-UTF-8)
- Ints: 4-byte LE signed int32; Bools: 1 byte
- Ratings ×10 (86 = 8.6); `-1` = unset
- Strings are Windows-1252 (ANSI) in files from the Delphi app (see rule 5)
- CustomFieldsProperties in file header (v4.0+); per-movie custom values = N positional strings, no count prefix

## Key source references

The `.amc` format is shared with the original self-hosted app; the reference
implementations the TS port mirrors live in the
[AMC-Online](https://github.com/alt-13/AMC-Online) monorepo, not this repo.

| What | Where |
|---|---|
| Architecture (this repo) | `CF-PORT.md` |
| Cloud sync / revisions / conflicts | `SYNC.md` |
| Series counting | `frontend/SERIES-RULES.md` |
| TS model / parser / mapping | `amc/types.ts`, `amc/parser.ts`, `amc/mapping.ts` |
| Binary format spec | `BinaryFormatResearch.md` *(AMC-Online monorepo)* |
| Python parser (reference impl the TS port mirrors) | `backend/app/parser/amc_file.py` *(AMC-Online monorepo)* |
| TMovie serialisation | `original/amc_sources/Movie Catalog/movieclass.pas` lines 4511–4650 *(monorepo)* |
| TCustomFieldProperties | `movieclass.pas` lines 879–960 *(monorepo)* |
| TCustomFields (per-movie values) | `movieclass.pas` lines 1826–1873 *(monorepo)* |
| TMoviePicture | `movieclass.pas` lines 2776–2830 *(monorepo)* |
| TMovieExtra / TMovieExtras | `movieclass.pas` lines 3041–3429 *(monorepo)* |
| AMC field constants | `original/amc_sources/Movie Catalog/fields.pas` *(monorepo)* |
