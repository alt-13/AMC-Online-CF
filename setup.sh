#!/usr/bin/env bash
#
# setup.sh — one-shot bootstrap for a fresh Cloudflare account.
#
# Single-operator model: whoever runs this owns the deployment. It provisions
# the D1 database + R2 bucket, writes the D1 id into wrangler.jsonc, applies the
# schema, sets the secrets (piped via stdin — never the dashboard), and deploys.
#
# Re-runnable: existing resources are detected and skipped, so it's safe to run
# again to rotate a secret or finish a half-done setup.
#
# Usage:  cd cf && ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER="npx --yes wrangler"
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

# --- 2. schema ------------------------------------------------------------
say "Applying schema.sql to remote D1"
$WRANGLER d1 execute "$DB_NAME" --remote --file=schema.sql

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
# AUTH_SECRET: the trust anchor. Offer a strong random default.
gen="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
read -r -p "AUTH_SECRET (Enter = generate a random 32-byte key): " auth_secret || true
put_secret AUTH_SECRET "${auth_secret:-$gen}"
[ -z "${auth_secret:-}" ] && echo "  (generated — you never need to see it; it stays in Cloudflare)"

# OMDB_API_KEY: optional. Blank Enter skips it.
read -r -p "OMDB_API_KEY (optional, Enter to skip — free key at omdbapi.com): " omdb_key || true
[ -n "${omdb_key:-}" ] && put_secret OMDB_API_KEY "$omdb_key" || echo "  OMDB_API_KEY skipped (movie lookup disabled)"

# --- 5. deploy ------------------------------------------------------------
say "Building frontend + deploying worker"
npx vite build
$WRANGLER deploy

say "Done — your AMC instance is live 🎬"
