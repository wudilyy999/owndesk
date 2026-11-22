#!/usr/bin/env bash
# Exercise the first-install entry point on a disposable Docker daemon, using already-built
# application images. Usage: bash tests/install-bootstrap.sh WEB_IMAGE WORKER_IMAGE DESKTOP_IMAGE
set -euo pipefail
[[ $# == 3 ]] || { echo 'Supply local web, worker and workstation image references' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
for ref in "$@" postgres:16.15-alpine caddy:2.11.7-alpine docker:29.7.2-dind; do docker image inspect "$ref" >/dev/null; done
h=$(docker run -d --privileged --memory 3g --cpus 2 --add-host ghcr.io:127.0.0.1 \
  -e DOCKER_TLS_CERTDIR=/certs -e DOCKER_IPTABLES_LEGACY= docker:29.7.2-dind --storage-driver=overlay2)
trap 'docker rm -fv "$h" >/dev/null' EXIT
d(){ docker exec -i "$h" docker "$@"; }
for _ in {1..60}; do d info >/dev/null 2>&1 && break; sleep 1; done
docker save "$@" postgres:16.15-alpine caddy:2.11.7-alpine | d load
lab=/srv/fresh-install
docker exec "$h" mkdir -p "$lab/workstation"
tar -C "$root" -cf - .dockerignore scripts/install.sh scripts/deploy-env.mjs scripts/vapid-keys.mjs deploy/compose.yaml deploy/Caddyfile | docker exec -i "$h" tar xf - -C "$lab"
# Reuse production binaries in the two native Compose build targets; no replacement of docker,
# the installer, the network guard, DB migrations or account creation.
d tag "$1" fixture-base:web; d tag "$2" fixture-base:worker; d tag "$3" fixture-base:desktop
printf 'FROM fixture-base:web AS web\nFROM fixture-base:worker AS worker\n' | docker exec -i "$h" tee "$lab/Dockerfile" >/dev/null
printf 'FROM fixture-base:desktop\n' | docker exec -i "$h" tee "$lab/workstation/Dockerfile" >/dev/null
d run -d --name installer --entrypoint sleep -v /var/run/docker.sock:/var/run/docker.sock -v "$lab:$lab" "$2" infinity >/dev/null
op(){ d exec -i installer "$@"; }
install(){ op bash "$lab/scripts/install.sh" https://localhost:8443 owner@install.test; }
install
id=$(op node --env-file="$lab/deploy/.env" -p 'process.env.INSTALL_ID'); prefix=pa-$id
for role in postgres web worker; do [[ $(d inspect -f '{{.State.Health.Status}}' "$prefix-$role-1") == healthy ]]; done
[[ $(d exec "$prefix-postgres-1" psql -XqAt -U agent -d personal_agent -c 'select count(*) from owners') == 1 ]]
d exec "$prefix-worker-1" node -e 'require("node:assert/strict").equal(process.env.OWNER_PASSWORD, undefined)'
d exec "$prefix-caddy-1" wget -q --no-check-certificate -O /dev/null https://localhost/login
op node -e 'const fs=require("fs"),x=require("util").parseEnv(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({email:x.OWNER_EMAIL,password:x.OWNER_PASSWORD}))' "$lab/deploy/owner.env" | d exec -i "$prefix-web-1" node --input-type=module -e 'import assert from "node:assert/strict";let body="";for await(const b of process.stdin)body+=b;const r=await fetch("http://127.0.0.1:6797/api/auth/sign-in/email",{method:"POST",headers:{Origin:process.env.APP_URL,"Content-Type":"application/json"},body});assert.equal(r.status,200);assert(r.headers.getSetCookie().length>0)'
keep(){ op sh -c 'cd /srv/fresh-install/deploy && sha512sum .env owner.env'; }
before=$(keep); [[ $(op stat -c %a "$lab/deploy/.env" "$lab/deploy/owner.env") == $'600\n600' ]]
if install; then echo 'Repeated installation unexpectedly succeeded' >&2; exit 1; fi
[[ $(keep) == "$before" ]]; echo 'PASS: network init/check, healthy services and TLS, one authenticated owner, existing keys retained'
