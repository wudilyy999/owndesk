#!/usr/bin/env bash
# Reproduce a local improvement that puts screenshots into the candidate's diary.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${B2_BASE_WEB_IMAGE:?Supply the built baseline web image}" "${B2_BASE_WORKER_IMAGE:?Supply the built baseline worker image}"
export INSTALL_ID=$(cat /proc/sys/kernel/random/uuid) DISPOSABLE_STACK_ONLY=1
export DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused APP_URL=http://127.0.0.1:17231
export MASTER_KEY=$(openssl rand -hex 32) BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export WORKSTATION_IMAGE=${WORKSTATION_IMAGE:-owndesk-workstation:0.7.0}
unset PA_DEPLOY_DIR
context=$(mktemp -d);tag=owndesk-worker:b2-diary-${INSTALL_ID:0:8}
probe=$(docker create --entrypoint true "$B2_BASE_WORKER_IMAGE")
cleanup(){ docker rm -v "$probe" >/dev/null 2>&1 || :; if docker image inspect "$tag" >/dev/null 2>&1; then docker image rm "$tag" >/dev/null; fi; }
trap cleanup EXIT
docker cp "$probe:/app/lib/workstation.ts" "$context/workstation.ts"
node --input-type=module - "$context/workstation.ts" <<'JS'
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';const path=process.argv[2],code=readFileSync(path,'utf8'),anchor='  return JSON.parse(result.stdout.toString()) as T';assert.equal(code.split(anchor).length,2);writeFileSync(path,code.replace(anchor,`  const resultData=JSON.parse(result.stdout.toString());
  if (route==='/screen_capture' && resultData.screenshot_status==='ok' && resultData.image){
    const id=crypto.randomUUID(),filename=id+'.jpg';const {writeFile}=await import('node:fs/promises');await writeFile('/app/data/artifacts/'+filename,Buffer.from(resultData.image,'base64'),{flag:'wx'});
    await pool.query("INSERT INTO life_activities(id,agent_id,kind,title,summary,body,image_path,created_at) VALUES ($1,$2,'diary','桌面截图','合成工作站试用','候选自动保存了截图',$3,now())",[id,agentId,filename]);resultData.diaryActivity=id;
  }
  return resultData as T`))
JS
chmod 644 "$context/workstation.ts"
printf 'FROM %s\nCOPY workstation.ts /app/lib/workstation.ts\n' "$B2_BASE_WORKER_IMAGE" >"$context/Dockerfile"
DOCKER_BUILDKIT=0 docker build --network none -q -t "$tag" "$context"
export PROOF_WORKER=$(docker image inspect -f '{{.Id}}' "$tag") PROOF_WEB=$(docker image inspect -f '{{.Id}}' "$B2_BASE_WEB_IMAGE")
export PROOF_OUT="$context/receipt.json"
node --import tsx tests/workstation-candidate.mjs
echo "Candidate diary receipt: $PROOF_OUT"
