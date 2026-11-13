#!/usr/bin/env bash
# Upgrade an existing OwnDesk install without rotating MASTER_KEY / VAPID / INSTALL_ID.
# The switch runs through the updater (scripts/updater.mjs): the old version is kept,
# the new one is health-checked, and any failure rolls back to the old one by itself.
#   upgrade.sh <ghcr-tag>          pull ghcr.io/wudilyy999/owndesk-{web,worker}:<tag>
#   upgrade.sh --build             build from this checkout
#   upgrade.sh --local WEB WORKER  switch to images already on this machine
#   upgrade.sh --resume            finish a switch that was cut off (converges state)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
MODE="${1:-}"

usage() {
  echo "Usage: $0 <ghcr-tag> | --build | --local WEB_IMAGE WORKER_IMAGE | --resume" >&2
  exit 1
}
[[ -n "$MODE" ]] || usage
if [[ ! -f "$DEPLOY/.env" ]]; then
  echo "deploy/.env missing — install first (scripts/install.sh)" >&2
  exit 1
fi

# Read or set one deploy/.env value without printing the file.
env_get() {
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parseEnv } from 'node:util'
    process.stdout.write(parseEnv(readFileSync(process.argv[1], 'utf8'))[process.argv[2]] ?? '')
  " "$DEPLOY/.env" "$1"
}
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'node:fs'
  const [file, deploy] = process.argv.slice(1)
  let t = readFileSync(file, 'utf8')
  for (const k of ['MASTER_KEY','INSTALL_ID','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY']) {
    if (!new RegExp('^'+k+'=.+','m').test(t)) {
      console.error('deploy/.env missing '+k+' — aborting upgrade')
      process.exit(1)
    }
  }
  // Installs from before the version base lack PA_DEPLOY_DIR; the updater needs it.
  if (!/^PA_DEPLOY_DIR=.+/m.test(t)) {
    t = t.replace(/^PA_DEPLOY_DIR=.*\n?/m, '').replace(/\n?$/, '\n') + 'PA_DEPLOY_DIR=' + deploy + '\n'
    writeFileSync(file, t, { mode: 0o600 })
  }
" "$DEPLOY/.env" "$DEPLOY"

compose() { docker compose --file "$DEPLOY/compose.yaml" --env-file "$DEPLOY/.env" "$@"; }
INSTALL_ID="$(env_get INSTALL_ID)"
WEB=""
WORKER=""
case "$MODE" in
  --build)
    REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [[ "$REVISION" != unknown ]] && [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
      REVISION="$REVISION-dirty"
    fi
    STAMP="build-$(date +%Y%m%d%H%M%S)"
    WEB="owndesk-web:$STAMP"
    WORKER="owndesk-worker:$STAMP"
    echo "Building images from source ($REVISION)..."
    # Fresh tags: never overwrite the tags the running (and kept) versions use.
    PA_WEB_IMAGE="$WEB" PA_WORKER_IMAGE="$WORKER" PA_SOURCE_REVISION="$REVISION" \
      compose build web worker
    docker build --tag "$(env_get PA_WORKSTATION_IMAGE)" "$ROOT/workstation"
    ;;
  --local)
    WEB="${2:-}"
    WORKER="${3:-}"
    [[ -n "$WEB" && -n "$WORKER" ]] || usage
    ;;
  --resume) ;;
  -*) usage ;;
  *)
    WEB="ghcr.io/wudilyy999/owndesk-web:$MODE"
    WORKER="ghcr.io/wudilyy999/owndesk-worker:$MODE"
    echo "Pulling GHCR tag $MODE ..."
    docker pull "$WEB"
    docker pull "$WORKER"
    ;;
esac

compose up --detach --wait postgres

# The updater runs from the *current* worker image so a broken new version cannot
# stop its own rollback. Installs from before the version base have no updater yet;
# for that first switch only, the new worker image provides it.
CURRENT="$(compose ps --all --quiet worker | head -n1)"
UPDATER=""
if [[ -n "$CURRENT" ]]; then
  UPDATER="$(docker inspect --format '{{.Image}}' "$CURRENT")"
else
  UPDATER="$(env_get PA_WORKER_IMAGE)"
fi
if ! docker run --rm --entrypoint test "$UPDATER" -f /app/scripts/updater.mjs 2>/dev/null; then
  [[ -n "$WORKER" ]] || { echo "No updater in the current image; nothing to resume." >&2; exit 1; }
  echo "Current image has no updater (installed before the version base); using the new one for this switch."
  UPDATER="$WORKER"
fi

ARGS=(resume --deploy "$DEPLOY")
[[ "$MODE" == --resume ]] || ARGS=(start --deploy "$DEPLOY" --action promote --web "$WEB" --worker "$WORKER")
set +e
docker run --rm \
  --name "pa-${INSTALL_ID:0:8}-updater-$(date +%s)" \
  --label "owndesk.updater=$INSTALL_ID" \
  --label owndesk.updater.role=switch \
  --network "pa-${INSTALL_ID}_control" \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$DEPLOY:$DEPLOY" \
  "$UPDATER" node scripts/updater.mjs "${ARGS[@]}"
CODE=$?
set -e
case "$CODE" in
  0)
    compose up --detach --no-deps caddy >/dev/null 2>&1 || true
    echo "Upgrade finished: the new version is healthy. It stays under health watch; the previous version is kept on the versions page."
    ;;
  2) echo "The new version failed its health checks and was rolled back automatically; the previous version is running. See the versions page for the reason." >&2 ;;
  3) echo "Another switch is in progress. If it was interrupted, run: $0 --resume" >&2 ;;
  *) echo "The switch failed and the rollback could not complete; check 'docker compose ps' and run: $0 --resume" >&2 ;;
esac
exit "$CODE"
