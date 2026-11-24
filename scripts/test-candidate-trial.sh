#!/usr/bin/env bash
# Real built candidate, Worker, two Chromium sessions, independent PostgreSQLs.
# Run on a disposable Linux Docker host with Playwright Chromium installed.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ ! -f .env ]] || { echo 'Use a disposable checkout without deploy credentials'; exit 1; }
: "${B2_BASE_WEB_IMAGE:?Set an already built Web image}" "${B2_BASE_WORKER_IMAGE:?Set the matching Worker image}"
export NEXT_TELEMETRY_DISABLED=1
stamp=$(mktemp -d "${TMPDIR:-/tmp}/owndesk-owner-trial.XXXXXX")
echo "Trial evidence: $stamp"
exec 9>/var/tmp/owndesk-b2-trial-ports.lock
flock -n 9
for p in 17231 17232; do
  if ss -ltnH | awk '{print $4}' | grep -Eq ":$p$"; then echo "Test port $p is busy"; exit 1; fi
done
export INSTALL_ID=$(cat /proc/sys/kernel/random/uuid) APP_URL=http://127.0.0.1:17231
export WORKER_PORT=17232 WORKER_INTERNAL_URL=http://127.0.0.1:17232 WORKSTATION_IMAGE=${WORKSTATION_IMAGE:-owndesk-workstation:0.7.0}
export OWNER_EMAIL=trial-owner@fixture.test OWNER_PASSWORD=$(openssl rand -hex 24)
export BETTER_AUTH_SECRET=$(openssl rand -hex 32) MASTER_KEY=$(openssl rand -hex 32)
pw=$(openssl rand -hex 24)
box=$(docker run -d --label owndesk.test=b2-owner-trial -e POSTGRES_PASSWORD="$pw" -p 127.0.0.1::5432 postgres:16.15-alpine)
worker='' web='' tag=owndesk-web:trial-${INSTALL_ID:0:8}
cleanup() {
  if [[ -n $web ]]; then kill -TERM -- -"$web" 2>/dev/null || :; wait "$web" || :; fi
  if [[ -n $worker ]]; then kill -TERM "$worker" 2>/dev/null || :; wait "$worker" || :; fi
  docker rm -fv "$box" >/dev/null
  if docker image inspect "$tag" >/dev/null 2>&1; then docker image rm "$tag" >/dev/null; fi
}
trap cleanup EXIT
port=$(docker port "$box" 5432/tcp | cut -d: -f2)
export DATABASE_URL="postgresql://postgres:$pw@127.0.0.1:$port/postgres"
for i in {1..45}; do docker exec "$box" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
node --import tsx scripts/migrate.ts >"$stamp/migrate.log" 2>&1
node --import tsx scripts/owner.ts >"$stamp/owner.log" 2>&1
mkdir "$stamp/image"
cp tests/fixtures/candidate-trial.html "$stamp/image/"
chmod 644 "$stamp/image/candidate-trial.html"
printf 'FROM %s\nCOPY candidate-trial.html /app/public/trial-check.html\n' "$B2_BASE_WEB_IMAGE" >"$stamp/image/Dockerfile"
DOCKER_BUILDKIT=0 docker build -q --network none --label owndesk.test=b2-owner-trial -t "$tag" "$stamp/image"
export B2_IMAGE_WEB=$(docker image inspect -f '{{.Id}}' "$tag") B2_IMAGE_WORKER=$(docker image inspect -f '{{.Id}}' "$B2_BASE_WORKER_IMAGE")
export B2_IMAGE_REVISION=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$B2_BASE_WORKER_IMAGE")
export B2_TEST_PG="$box" B2_EVIDENCE="$stamp"
node --import tsx worker/main.ts >"$stamp/worker.log" 2>&1 & worker=$!
setsid node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 17231 >"$stamp/web.log" 2>&1 & web=$!
for i in {1..75}; do
  curl -sf "$WORKER_INTERNAL_URL/health" >/dev/null && curl -sf "$APP_URL/login" >/dev/null && break
  kill -0 "$worker" && kill -0 "$web" || { echo 'Test services stopped before ready'; exit 1; }; sleep 1
done
node --import tsx tests/candidate-trial.ts
