import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const updater = (args: string[]) =>
  spawnSync(process.execPath, ["scripts/updater.mjs", ...args], { encoding: "utf8" })

test("updater accepts only its fixed commands and an absolute deploy directory", async () => {
  assert.notEqual(updater(["exec", "--deploy", "/tmp"]).status, 0)
  assert.match(updater(["exec", "--deploy", "/tmp"]).stderr, /start\|watch\|resume/)
  assert.match(updater(["start", "--deploy", "relative"]).stderr, /must be absolute/)
  assert.match(updater(["start", "--deploy"]).stderr, /must be absolute/)
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-updater-"))
  try {
    await writeFile(path.join(directory, ".env"), "INSTALL_ID=not-a-uuid\n")
    assert.match(updater(["resume", "--deploy", directory]).stderr, /no INSTALL_ID/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("compose wires the version base: deploy path, version repository, build revision", async () => {
  const compose = await readFile("deploy/compose.yaml", "utf8")
  assert.match(compose, /PA_DEPLOY_DIR: \$\{PA_DEPLOY_DIR:-\}/)
  assert.match(compose, /- evolution:\/app\/data\/evolution/)
  assert.equal(
    compose.match(/SOURCE_REVISION: \$\{PA_SOURCE_REVISION:-unknown\}/g)?.length,
    2
  )
  const dockerfile = await readFile("Dockerfile", "utf8")
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$SOURCE_REVISION/)
  assert.match(dockerfile, /\/source\.tar/)
  assert.match(dockerfile, /cli-plugins\/docker-compose/)
  // The source archive must never carry deployment secrets
  const ignore = await readFile(".dockerignore", "utf8")
  for (const pattern of [
    "**/.env",
    "deploy/*.env",
    "deploy/backups",
    "**/*.dump",
    ".git",
  ])
    assert(ignore.split("\n").includes(pattern), pattern)
})

test("upgrade runs every switch through the updater from the current image", async () => {
  const script = await readFile("scripts/upgrade.sh", "utf8")
  assert.match(script, /scripts\/updater\.mjs/)
  assert.match(script, /--resume/)
  assert(
    !/stop --timeout 60 caddy web worker/.test(script),
    "no blind stop before switching"
  )
  // --build must not overwrite the tags of kept versions
  assert.match(script, /PA_WEB_IMAGE="\$WEB" PA_WORKER_IMAGE="\$WORKER"/)
})
