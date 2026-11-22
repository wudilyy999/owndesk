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

if [[ -e "$DEPLOY/.env" || -e "$DEPLOY/owner.env" ]]; then
  echo "Deployment or owner configuration already exists — refusing to overwrite. Use scripts/upgrade.sh to upgrade." >&2
  exit 1
fi

echo "Generating deploy/.env and owner bootstrap (secrets not printed)..."
mkdir -p "$DEPLOY"
node "$ROOT/scripts/deploy-env.mjs" "$APP_URL" "$OWNER_EMAIL" "$DEPLOY"

# Prefer published GHCR images when readable; otherwise build from this tree.
WEB_IMAGE="ghcr.io/wudilyy999/owndesk-web:latest"
WORKER_IMAGE="ghcr.io/wudilyy999/owndesk-worker:latest"
WS_IMAGE="ghcr.io/wudilyy999/owndesk-workstation:0.7.0"
compose() { docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" "$@"; }
if docker pull "$WEB_IMAGE" >/dev/null 2>&1 && docker pull "$WORKER_IMAGE" >/dev/null 2>&1; then
  echo "Using GHCR images."
  if ! docker pull "$WS_IMAGE" >/dev/null 2>&1; then
    WS_IMAGE="owndesk-workstation:0.7.0"
    docker build --tag "$WS_IMAGE" "$ROOT/workstation"
  fi
  node --input-type=module - "$DEPLOY/.env" "$WEB_IMAGE" "$WORKER_IMAGE" "$WS_IMAGE" <<'JS'
import { readFileSync, writeFileSync } from "node:fs"
const [file, ...images] = process.argv.slice(2)
let config = readFileSync(file, "utf8")
for (const [i, key] of ["PA_WEB_IMAGE", "PA_WORKER_IMAGE", "PA_WORKSTATION_IMAGE"].entries()) {
  config = config.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${images[i]}`)
}
writeFileSync(file, config, { mode: 0o600 })
JS
else
  echo "GHCR images not available; building from source (this takes a while)..."
  PA_SOURCE_REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" compose build web worker
  docker build --tag owndesk-workstation:0.7.0 "$ROOT/workstation"
fi

# Use the same Worker image and network settings as this installation, before any services start.
guard_image="$(node --env-file="$DEPLOY/.env" -p 'process.env.PA_WORKER_IMAGE')"
for mode in init check; do
  docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --env-file <(grep -E '^(INSTALL_ID|APP_URL|WORKSTATION_NETWORK|PA_GUEST_SUBNET|PA_CONTROL_IPS)=' "$DEPLOY/.env") \
    "$guard_image" node scripts/network.mjs "$mode"
done

echo "Starting Postgres, migrating, creating the single owner..."
compose up -d --wait postgres
compose run --rm worker npm run db:migrate
compose run --rm --env-from-file "$DEPLOY/owner.env" worker npm run owner:create
compose up -d --wait

echo
echo "OwnDesk is up at $APP_URL"
echo "Log in with $OWNER_EMAIL — initial password is in deploy/owner.env (mode 600)."
echo "Change the password after first login. Registration stays closed (single owner)."
echo "Next: settings → model (DeepSeek or OpenAI-compatible). Tunnel? docs/cloudflare-tunnel.md"
