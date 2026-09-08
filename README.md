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
- **Mega.nz**, **Google Drive**, **OneDrive** and **Dropbox** import/export. Mega
  uploads carry a correct fingerprint so the desktop client accepts them; the
  other three each need a one-off OAuth client ID (plus, for Drive, its client
  secret — Google's token endpoint demands one) (see
  [Connecting Google Drive](#connecting-google-drive) /
  [Connecting OneDrive](#connecting-onedrive) /
  [Connecting Dropbox](#connecting-dropbox)). Saved
  credentials are AES-256-GCM encrypted at rest, and sign-in happens straight
  from your browser — so Mega's "new login" notification email names the browser
  you are actually using (Safari on an iPhone, Chrome on a desktop, …). That mail
  is this app connecting, not a stranger.
- Legacy Windows-1252/1250/1251 (ANSI) catalogs round-trip losslessly.

## Requirements

- Node.js 20+
- A Cloudflare account (for deploy) with Workers, D1, and R2 available.
- **For Google Drive, OneDrive or Dropbox sync only:** your own OAuth client ID
  (Drive: and its client secret) — about five minutes in the Google Cloud Console
  / Microsoft Entra admin center / Dropbox App Console, once per deploy. This is
  unavoidable: all three vendors bind an OAuth client to specific *redirect URIs*
  and none allows a wildcard, so no client ID can be shipped that covers your
  domain. Walkthroughs:
  [Connecting Google Drive](#connecting-google-drive),
  [Connecting OneDrive](#connecting-onedrive),
  [Connecting Dropbox](#connecting-dropbox).
  **Mega.nz needs none of this** — email and password, nothing to register.

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

Run the tests (parser round-trips, auth crypto, OMDb parsers, cloud connectors):

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
bucket, writes the `database_id` into `wrangler.jsonc`, asks for an optional
custom domain, applies `schema.sql`, sets `AUTH_SECRET` via stdin, builds the
frontend, and deploys. It's re-runnable.

**Custom domain.** No hostname is committed: `wrangler.jsonc` ships its `routes`
line commented out, so an untouched clone deploys to
`<name>.<your-subdomain>.workers.dev`. Attach a hostname either in the dashboard
(Worker → Settings → Domains & Routes — keeps the repo config clean, and is the
right choice with deploy-on-push) or by entering it at the setup prompt, which
uncomments the line so `custom_domain: true` has Cloudflare create the DNS
record + edge cert — the zone must already be on your account, and the API
token needs the three Zone rows in [`CF-PORT.md`](CF-PORT.md#cloudflare-api-token).

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

### Connecting Google Drive

> **Heads up — Drive is not zero-setup.** Before the app can see your Drive you
> must register an OAuth client in the Google Cloud Console and paste its client
> ID **and secret** into the Cloud sync panel once. Hosted services skip this
> only because the vendor registered *their* one domain; a self-hosted deploy has
> to register its own, since Google allows no wildcard redirect URIs. Budget five
> minutes. If that is not worth it, use Mega.nz instead — it needs nothing.

Unlike the other two providers, Google's token endpoint refuses a Web-application
client that sends no client secret, PKCE or not — so Drive needs both halves.
There is still no Worker secret and no redeploy: the secret is stored with your
other saved credentials (AES-256-GCM at rest, per user) and used only from your
own browser. One-off setup:

1. [Google Cloud Console](https://console.cloud.google.com/) → create (or pick) a
   project → **APIs & Services → Library** → enable the **Google Drive API**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Web application**.
3. Add your deploy's origin *with a trailing slash* — e.g.
   `https://amc.example.com/`, or `http://localhost:5173/` for local dev — under
   **Authorized redirect URIs** (the app signs in with the OAuth code flow, so
   the redirect URI is what must match, not just the JavaScript origin).
4. Leave the consent screen in **Testing** and add yourself as a test user. The
   app asks for the full `drive` scope — it has to see `.amc` files that the
   desktop Ant Movie Catalog put there, which the narrower `drive.file` scope
   cannot. Google calls that a restricted scope: fine for your own deploy in
   Testing, but publishing the client would require Google's verification.
5. In the app: **Cloud sync → Google Drive**, paste the client ID and the client
   secret, tick "keep me signed in" so they are remembered (encrypted, per user),
   and Connect.

Google's popup does the signing in, so no password of yours ever reaches this app.
The grant returns a **refresh token**, so every reconnect after the first — the
background remote-check included — is silent; the popup comes back only if you
revoke the app in your Google account.

> A consent screen left in **Testing** expires its refresh tokens after 7 days.
> If Drive starts asking for the popup roughly weekly, that is why.

> Upgrading from a build before the client secret was required? Drive's stored
> login has no secret in it, so it cannot reconnect: paste the client ID and
> secret in the panel once more (and add the redirect URI from step 3, which the
> old Identity-Services flow did not need).

### Connecting OneDrive

Same shape as Drive, same five minutes: register an app, paste its client ID
once. It is public — and unlike Drive there is no client secret at all, no Worker
secret and no redeploy.

1. [Microsoft Entra admin center](https://entra.microsoft.com/) →
   **App registrations → New registration**.
2. Supported account types: **any organizational directory + personal Microsoft
   accounts** — that is the `common` authority the app signs in against (pick
   organization-only if you only ever use a work account).
3. Add a **Redirect URI** of platform type **Single-page application**, set to your
   deploy's origin *with a trailing slash* — e.g. `https://amc.example.com/`, or
   `http://localhost:5173/` for local dev. The SPA platform type is what makes
   Microsoft issue tokens to a browser over CORS without a secret (PKCE).
4. Copy the **Application (client) ID** from the overview page.
5. In the app: **Cloud sync → OneDrive**, paste the client ID, tick "keep me
   signed in" so it is remembered (encrypted, per user), and Connect.

The app asks for `Files.ReadWrite` (your own OneDrive), `User.Read` (to show
which account is connected) and `offline_access` (the refresh token) — no admin
consent needed. Microsoft's popup does the signing in, so no password of yours
reaches this app. The refresh token keeps every later reconnect silent, the
background remote-check included.

> Microsoft's browser refresh tokens are **single-use and expire 24 h after
> issue**. Each renewal stores its replacement, so day-to-day use never sees the
> popup — but leave the app untouched for more than a day and you sign in again.

### Connecting Dropbox

Same shape as OneDrive, same five minutes: register an app, paste its App key
once. It is public — there is no app secret, no Worker secret and no redeploy.

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**
   → **Scoped access** → **Full Dropbox** (App-folder access cannot see the `.amc`
   the desktop Ant Movie Catalog wrote, which is the point of the import path).
2. On the **Permissions** tab tick `account_info.read`, `files.metadata.read`,
   `files.content.read` and `files.content.write`, then **Submit**. Do this
   *before* connecting — Dropbox bakes the scopes into the token it issues.
3. On **Settings**, add a **Redirect URI** set to your deploy's origin *with a
   trailing slash* — e.g. `https://amc.example.com/`, or `http://localhost:5173/`
   for local dev.
4. Copy the **App key** from that same page.
5. In the app: **Cloud sync → Dropbox**, paste the App key, tick "keep me signed
   in" so it is remembered (encrypted, per user), and Connect.

Dropbox's popup does the signing in, so no password of yours reaches this app.
The grant is `offline`, so a long-lived, non-rotating refresh token keeps every
later reconnect silent, the background remote-check included. The popup comes
back only if you disconnect the app in your Dropbox account settings.

> Dropbox addresses files by path, not by id: if you *rename or move* the remote
> folder a catalog was imported from, that catalog reads as "remote file gone"
> and you re-pick it. Renaming the `.amc` itself is fine to do from the app's
> path setting.

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
browser/    import/export orchestration + Mega client + path grammar
frontend/   Vue 3 app (catalogs → movie list → movie detail, dialogs)
schema.sql  D1 baseline schema      migrations/  incremental deltas
setup.sh    one-shot provision + deploy       wrangler.jsonc  Worker config
```
