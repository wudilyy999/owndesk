#!/usr/bin/env bash
# Upgrade an existing OwnDesk install without rotating MASTER_KEY / VAPID / INSTALL_ID.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
MODE="${1:-}"

if [[ ! -f "$DEPLOY/.env" ]]; then
  echo "deploy/.env missing — install first (scripts/install.sh)" >&2
  exit 1
fi

node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  const t=readFileSync('$DEPLOY/.env','utf8')
  for (const k of ['MASTER_KEY','INSTALL_ID','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']) {
    if (!new RegExp('^'+k+'=.+','m').test(t)) {
      console.error('deploy/.env missing '+k+' — aborting upgrade')
      process.exit(1)
    }
  }
"

echo "Stopping entry and writers..."
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" \
  stop --timeout 60 caddy web worker || true

if [[ "$MODE" == "--build" ]]; then
  echo "Building images from source..."
  docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" build web worker
  docker build --tag owndesk-workstation:0.7.0 "$ROOT/workstation"
elif [[ -n "$MODE" ]]; then
  TAG="$MODE"
  echo "Pulling GHCR tag $TAG ..."
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    const p='$DEPLOY/.env'
    let t=readFileSync(p,'utf8')
    t=t.replace(/^PA_WEB_IMAGE=.*/m,'PA_WEB_IMAGE=ghcr.io/wudilyy999/owndesk-web:$TAG')
    t=t.replace(/^PA_WORKER_IMAGE=.*/m,'PA_WORKER_IMAGE=ghcr.io/wudilyy999/owndesk-worker:$TAG')
    writeFileSync(p,t,{mode:0o600})
  "
  docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" pull web worker || \
    docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" pull
else
  echo "Usage: $0 <ghcr-tag>|--build" >&2
  exit 1
fi

echo "Migrating..."
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" up -d postgres
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" run --rm worker npm run db:migrate
echo "Starting..."
docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" up -d --wait
echo "Upgrade finished. Check /health and re-login if needed."
