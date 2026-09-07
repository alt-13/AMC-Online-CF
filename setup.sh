#!/usr/bin/env bash
#
# setup.sh — one-shot bootstrap for a fresh Cloudflare account.
#
# Single-operator model: whoever runs this owns the deployment. It provisions
# the D1 database + R2 bucket, writes the D1 id into wrangler.jsonc, applies the
# schema, sets the secrets (piped via stdin — never the dashboard), and deploys.
#
# Re-runnable: existing resources are detected and skipped, so it's safe to run
# again to finish a half-done setup or ship migrations. Existing secrets are
# LEFT UNTOUCHED — a re-run never silently rotates them (rotate deliberately with
# `npx wrangler secret put <NAME>`).
#
# ROTATION CAVEAT: stored Mega credentials are encrypted with ENCRYPTION_SECRET
# (which falls back to AUTH_SECRET when unset). Rotate the secret that encrypts
# them and every saved credential becomes undecryptable — the app now surfaces
# that as a 409 asking the user to reconnect, rather than a silent 500. Setting a
# dedicated ENCRYPTION_SECRET below lets you rotate AUTH_SECRET (JWT signing) on
# its own without touching stored credentials.
#
# Usage:  ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

# Pinned to the v4 line so a future major can't silently change deploy behaviour.
WRANGLER="npx --yes wrangler@4"
DB_NAME="amc"
BUCKET_NAME="amc-posters"

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$1"; }

# --- 0. auth --------------------------------------------------------------
say "Checking Cloudflare login"
$WRANGLER whoami >/dev/null 2>&1 || $WRANGLER login

# --- 1. D1 database -------------------------------------------------------
say "D1 database ($DB_NAME)"
if grep -q 'REPLACE_WITH_d1_create_OUTPUT' wrangler.jsonc; then
  # Create (or, if it already exists remotely, read back its id).
  out="$($WRANGLER d1 create "$DB_NAME" 2>&1 || true)"
  db_id="$(printf '%s' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [ -z "$db_id" ]; then
    db_id="$($WRANGLER d1 info "$DB_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  fi
  [ -n "$db_id" ] || { echo "Could not determine database_id:"; echo "$out"; exit 1; }
  # Portable in-place edit (GNU + BSD sed).
  sed -i.bak "s/REPLACE_WITH_d1_create_OUTPUT/$db_id/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "  database_id -> $db_id"
else
  echo "  already configured in wrangler.jsonc, skipping"
fi

# --- 1b. custom domain (optional) -----------------------------------------
# The hostname is NOT in git — wrangler.jsonc ships the "routes" line commented
# out, so a fresh clone deploys to <name>.<subdomain>.workers.dev. Enter a
# hostname here and it gets uncommented in your working copy only.
say "Custom domain (optional)"
if grep -qE '^[[:space:]]*"routes"' wrangler.jsonc; then
  echo "  already configured in wrangler.jsonc, skipping"
else
  read -r -p "Custom domain, e.g. amc.example.com (Enter = use workers.dev): " domain || true
  if [ -n "${domain:-}" ]; then
    sed -i.bak "s|// \"routes\": \[{ \"pattern\": \"CUSTOM_DOMAIN\"|\"routes\": [{ \"pattern\": \"$domain\"|" wrangler.jsonc
    rm -f wrangler.jsonc.bak
    if ! grep -qE '^[[:space:]]*"routes"' wrangler.jsonc; then
      echo "Could not write the domain into wrangler.jsonc — add the routes line by hand."; exit 1
    fi
    echo "  routes -> $domain (zone must already be on this account)"
  else
    echo "  skipped — serving on <name>.<subdomain>.workers.dev"
  fi
fi

# --- 2. schema ------------------------------------------------------------
say "Applying schema.sql to remote D1"
$WRANGLER d1 execute "$DB_NAME" --remote --file=schema.sql

# --- 2b. migrations -------------------------------------------------------
# schema.sql is the BASELINE (CREATE TABLE IF NOT EXISTS). Every later schema
# change lives in migrations/*.sql and is applied with Wrangler's native D1
# migrations, which track what's been run in a d1_migrations table — so this is
# idempotent and safe to run on every deploy (see the deploy step / package.json).
say "Applying D1 migrations (remote)"
$WRANGLER d1 migrations apply "$DB_NAME" --remote

# --- 3. R2 bucket ---------------------------------------------------------
say "R2 bucket ($BUCKET_NAME)"
$WRANGLER r2 bucket create "$BUCKET_NAME" 2>/dev/null && echo "  created" \
  || echo "  already exists, skipping"

# --- 4. secrets (piped via stdin — never echoed to a file) ----------------
put_secret() {  # name  value
  printf '%s' "$2" | $WRANGLER secret put "$1" >/dev/null
  echo "  $1 set"
}

say "Secrets"
# Snapshot the secrets already set, so a re-run NEVER silently rotates one.
# Rotating AUTH_SECRET invalidates every session; rotating the key that encrypts
# stored Mega credentials makes them unreadable. Both are set only if missing.
existing_secrets="$($WRANGLER secret list 2>/dev/null || echo '[]')"
has_secret() {  # name
  printf '%s' "$existing_secrets" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$1\""
}

# AUTH_SECRET: the trust anchor. Set once; offer a strong random default.
if has_secret AUTH_SECRET; then
  echo "  AUTH_SECRET already set — leaving it untouched"
  echo "  (rotate deliberately with: npx wrangler secret put AUTH_SECRET)"
else
  gen="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  read -r -p "AUTH_SECRET (Enter = generate a random 32-byte key): " auth_secret || true
  put_secret AUTH_SECRET "${auth_secret:-$gen}"
  [ -z "${auth_secret:-}" ] && echo "  (generated — you never need to see it; it stays in Cloudflare)"
fi

# ENCRYPTION_SECRET: encrypts stored Mega credentials. Kept separate from
# AUTH_SECRET so JWT-signing can be rotated without bricking saved credentials.
# Set only the FIRST time — regenerating it would make existing credentials
# undecryptable (users then get a 409 asking to reconnect).
if has_secret ENCRYPTION_SECRET; then
  echo "  ENCRYPTION_SECRET already set — leaving it untouched"
else
  enc_gen="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  read -r -p "ENCRYPTION_SECRET (Enter = generate; leave unset to reuse AUTH_SECRET): " enc_secret || true
  if [ -n "${enc_secret:-}" ]; then
    put_secret ENCRYPTION_SECRET "$enc_secret"
  else
    read -r -p "  No value entered — generate a dedicated one now? [y/N]: " enc_yn || true
    case "${enc_yn:-}" in
      [yY]*) put_secret ENCRYPTION_SECRET "$enc_gen"
             echo "  (generated — set once; do not rotate or stored credentials become unreadable)" ;;
      *)     echo "  ENCRYPTION_SECRET skipped (credentials will be encrypted under AUTH_SECRET)" ;;
    esac
  fi
fi

# OMDb key is set per-user in-app (Settings → OMDb API key), encrypted at rest,
# so no OMDb secret is needed to deploy. An operator can still set a shared
# fallback manually if they want one for every user:
#   npx wrangler secret put OMDB_API_KEY
echo "  OMDb key: set per-user in-app (Settings) — no deploy secret needed"

# --- 5. deploy ------------------------------------------------------------
say "Building frontend + deploying worker"
npx vite build
$WRANGLER deploy

say "Done — your AMC instance is live 🎬"
