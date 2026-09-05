# AMC Online — Cloudflare edition

Browse and edit your **Ant Movie Catalog** (`.amc`) files in the browser — no
always-on server. Upload your catalog once, browse and edit it online, and export
it back to a byte-identical `.amc` whenever you want. Runs entirely on
Cloudflare's free-ish tier (Workers + D1 + R2).

This is the serverless port of the self-hosted [AMC-Online](https://github.com/alt-13/AMC-Online)
app. The binary `.amc` format is shared; this repo replaces the FastAPI backend
and Docker/Unraid deploy with Cloudflare Workers.

## How it works

The catalog is **never held in memory on the server**. The binary parse/serialize
runs only in the browser; the Worker touches at most a handful of D1 rows and one
poster per request.

```
upload:   browser: parse .amc → split rows/posters → PUT posters (R2) + POST rows (D1)
export:   browser: fetch bundle (D1) → fetch posters (R2) → rebuild → download .amc
```

- **D1** stores metadata only (movies, custom-field defs, extras, users, settings).
- **R2** stores every embedded poster JPEG, keyed `{tenant}/{catalog}/{movie}.jpg`.
- **Multi-tenant** — each account (`user id` == `tenant id`) sees only its own data.

See [`CF-PORT.md`](CF-PORT.md) for the full architecture (data model, auth, API
surface). Contributors should also read [`CLAUDE.md`](CLAUDE.md) for the invariants
that keep `.amc` export byte-exact.

## Features

- Upload / browse / edit `.amc` catalogs; export back to byte-identical `.amc`.
- Poster grid per catalog with search; per-movie editor for every field.
- Poster from file upload, image URL, or OMDb; JPEG normalization in the browser.
- OMDb / IMDb metadata lookup ("⚡ Fetch → new").
- Per-user field-visibility settings (desktop / mobile).
- **Mega.nz** import/export (fingerprinted so the desktop client accepts uploads);
  saved credentials are AES-256-GCM encrypted at rest. Sign-in happens straight
  from your browser, so Mega's "new login" notification email names the browser
  you are actually using (Safari on an iPhone, Chrome on a desktop, …) — that mail
  is this app connecting, not a stranger.
- Legacy Windows-1252/1250/1251 (ANSI) catalogs round-trip losslessly.

## Requirements

- Node.js 20+
- A Cloudflare account (for deploy) with Workers, D1, and R2 available.

## Local development

Single Vite project (frontend + Worker + browser modules share one `package.json`).
Dev runs as **two processes**:

```sh
npm ci

# terminal 1 — Worker + local D1/R2 emulation on :8787
npm run dev:worker

# terminal 2 — frontend on :5173, proxies /api → :8787
npm run dev
```

First time on a fresh local DB, seed the emulated D1:

```sh
npx wrangler d1 execute amc --local --file=schema.sql
npx wrangler d1 migrations apply amc --local
```

Then open http://localhost:5173 and create the first account (registration is
first-run only).

Run the tests (parser round-trips, auth crypto, OMDb parsers, Mega paths):

```sh
npm test
```

## Deploy

One command on a fresh Cloudflare account provisions everything, sets the secret,
and deploys:

```sh
./setup.sh
```

`setup.sh` logs in (or uses `CLOUDFLARE_API_TOKEN`), creates the D1 database + R2
bucket, writes the `database_id` into `wrangler.jsonc`, applies `schema.sql`, sets
`AUTH_SECRET` via stdin, builds the frontend, and deploys. It's re-runnable.

Manual equivalent:

```sh
npm install
npx wrangler d1 create amc                    # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create amc-posters
npx wrangler d1 execute amc --remote --file=schema.sql
npx wrangler secret put AUTH_SECRET           # required (JWT/PBKDF2 signing secret)
npm run build                                 # → ./dist (served via the assets binding)
npm run deploy                                # applies migrations + wrangler deploy
```

### Deploy on push (Cloudflare Workers Builds)

To have Cloudflare rebuild and redeploy automatically on every push, connect the
repo under **Workers & Pages → your Worker → Settings → Builds** (or **Create →
Workers → Import a repository**) and set:

| Dashboard field | Value |
|---|---|
| **Build command** | `npm run build` |
| **Deploy command** | `npm run deploy` |
| **Root directory** | `/` (repo root) |

- `npm run build` runs `vite build` → `./dist` (served via the `assets` binding).
- `npm run deploy` runs `wrangler d1 migrations apply amc --remote && wrangler
  deploy`, so **pending D1 migrations are applied on every deploy** and the schema
  stays current. (Use `npx wrangler deploy` instead if you prefer to apply
  migrations by hand.)

**One-time prerequisites** — Workers Builds deploys the code but does **not**
provision infrastructure, so before the first push-deploy:

- The **D1 database** (`amc`) and **R2 bucket** (`amc-posters`) must already exist
  and `wrangler.jsonc` must hold the real `database_id` (both done by `./setup.sh`
  or the manual steps above; `database_id` is committed).
- **`AUTH_SECRET` must be set as a Worker secret** in the dashboard
  (**Settings → Variables and Secrets → add secret**, name `AUTH_SECRET`). Secrets
  are never in git and `wrangler deploy` does not create them, so a build that
  skips this will deploy a Worker that can't sign tokens. `ENCRYPTION_SECRET` and a
  shared `OMDB_API_KEY` are optional (see `wrangler.jsonc`).

**OMDb key** (optional): metadata lookup uses OMDb, which needs a free key from
[omdbapi.com](https://www.omdbapi.com/apikey.aspx). Each user sets their own in
**Settings → OMDb API key** (encrypted at rest); no deploy-time secret is required.

See [`CF-PORT.md`](CF-PORT.md#deploy) for the exact Cloudflare API-token scopes and
custom-domain setup.

## Project layout

```
amc/        binary parser + model + codepage transcode (browser-side, byte-exact)
worker/     Cloudflare Worker: /api/* router, auth, crypto, omdb, D1 helpers
browser/    import/export orchestration + Mega client
frontend/   Vue 3 app (catalogs → movie list → movie detail, dialogs)
schema.sql  D1 baseline schema      migrations/  incremental deltas
setup.sh    one-shot provision + deploy       wrangler.jsonc  Worker config
```
