#!/usr/bin/env bash
# OwnDesk self-host installer: one machine, one owner. Secrets stay in deploy/*.env (mode 600).
set -euo pipefail

APP_URL="${1:-}"
OWNER_EMAIL="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"

usage() {
  echo "Usage: $0 https://desk.example.com owner@example.com" >&2
  exit 1
}

[[ -n "$APP_URL" && -n "$OWNER_EMAIL" ]] || usage
[[ "$APP_URL" == https://* ]] || { echo "APP_URL must be https://" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need docker
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 required" >&2; exit 1; }
need node
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 24 ]] || echo "Warning: Node 24+ recommended (found $(node -v))" >&2

if [[ -f "$DEPLOY/.env" ]]; then
  echo "deploy/.env already exists — refusing to overwrite. Use scripts/upgrade.sh to upgrade." >&2
  exit 1
fi

echo "Generating deploy/.env and owner bootstrap (secrets not printed)..."
mkdir -p "$DEPLOY"
node "$ROOT/scripts/deploy-env.mjs" "$APP_URL" "$OWNER_EMAIL" "$DEPLOY"

# Prefer published GHCR images when readable; otherwise build from this tree.
WEB_IMAGE="ghcr.io/wudilyy999/owndesk-web:latest"
WORKER_IMAGE="ghcr.io/wudilyy999/owndesk-worker:latest"
WS_IMAGE="ghcr.io/wudilyy999/owndesk-workstation:0.7.0"
use_ghcr=0
if docker pull "$WEB_IMAGE" >/dev/null 2>&1 && docker pull "$WORKER_IMAGE" >/dev/null 2>&1; then
  use_ghcr=1
  # workstation may be large; fall back to local build if pull fails
  docker pull "$WS_IMAGE" >/dev/null 2>&1 || WS_IMAGE="owndesk-workstation:0.7.0"
fi

if [[ "$use_ghcr" -eq 1 ]]; then
  echo "Using GHCR images."
  # Rewrite image names in env without printing file
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    const p='$DEPLOY/.env'
    let t=readFileSync(p,'utf8')
    t=t.replace(/^PA_WEB_IMAGE=.*/m,'PA_WEB_IMAGE=$WEB_IMAGE')
    t=t.replace(/^PA_WORKER_IMAGE=.*/m,'PA_WORKER_IMAGE=$WORKER_IMAGE')
    t=t.replace(/^PA_WORKSTATION_IMAGE=.*/m,'PA_WORKSTATION_IMAGE=$WS_IMAGE')
    writeFileSync(p,t,{mode:0o600})
  "
else
  echo "GHCR images not available; building from source (this takes a while)..."
  PA_SOURCE_REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" \
    docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" build web worker
  docker build --tag owndesk-workstation:0.7.0 "$ROOT/workstation"
fi

echo "Starting Postgres, migrating, creating the single owner..."
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" up -d postgres
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" run --rm worker npm run db:migrate
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" run --rm \
  --env-file "$DEPLOY/owner.env" worker npm run owner:create
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" up -d --wait

echo
echo "OwnDesk is up at $APP_URL"
echo "Log in with $OWNER_EMAIL — initial password is in deploy/owner.env (mode 600)."
echo "Change the password after first login. Registration stays closed (single owner)."
echo "Next: settings → model (DeepSeek or OpenAI-compatible). Tunnel? docs/cloudflare-tunnel.md"
