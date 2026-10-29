import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("deployment bootstrap keeps separate private keys and refuses overwriting an installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-deploy-env-"))
  const args = [
    "scripts/deploy-env.mjs",
    "https://localhost:19443",
    "owner@fixture.test",
    directory,
  ]
  try {
    const output = execFileSync(process.execPath, args, { encoding: "utf8" })
    const app = await readFile(path.join(directory, ".env"), "utf8")
    const owner = await readFile(path.join(directory, "owner.env"), "utf8")
    assert(!app.includes("OWNER_PASSWORD"))
    assert(!owner.includes("MASTER_KEY"))
    assert.match(app, /DESKTOP_GATEWAY_URL=wss:\/\/localhost:19443\/desktop/)
    assert.match(app, /PA_BIND_IP=127.0.0.1/)
    assert.match(app, /WORKSTATION_IDLE_MINUTES=15/)
    assert.match(app, /PA_HTTPS_PORT=19443/)
    const version = (await readFile("lib/durable.ts", "utf8")).match(
      /APPLICATION_VERSION = "([^"]+)"/
    )![1]
    const compose = await readFile("deploy/compose.yaml", "utf8")
    const workstation = JSON.parse(await readFile("package.json", "utf8")).scripts[
      "workstation:build"
    ].match(/-t (\S+)/)[1]
    for (const [key, image] of [
      ["PA_WEB_IMAGE", `owndesk-web:${version}`],
      ["PA_WORKER_IMAGE", `owndesk-worker:${version}`],
      ["PA_WORKSTATION_IMAGE", workstation],
    ]) {
      assert(app.includes(`${key}=${image}\n`), `${key} must pin the source version`)
      assert(
        compose.includes(`\u0024{${key}:-${image}}`),
        `${key} Compose default must match`
      )
    }
    for (const file of [".env", "owner.env"]) {
      assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600)
      const text = await readFile(path.join(directory, file), "utf8")
      for (const line of text.trim().split("\n")) {
        const [key, value] = line.split("=")
        if (/SECRET|MASTER_KEY|PASSWORD/.test(key)) assert(!output.includes(value))
      }
    }
    assert.throws(() => execFileSync(process.execPath, args, { stdio: "pipe" }))
    assert.equal(await readFile(path.join(directory, ".env"), "utf8"), app)
    assert.equal(await readFile(path.join(directory, "owner.env"), "utf8"), owner)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("deployment bootstrap rejects insecure or credential-bearing URLs before writing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-deploy-input-"))
  try {
    for (const url of [
      "http://localhost",
      "https://user:pass@host.test",
      "https://host.test/path",
    ]) {
      assert.throws(() =>
        execFileSync(
          process.execPath,
          ["scripts/deploy-env.mjs", url, "owner@fixture.test", directory],
          { stdio: "pipe" }
        )
      )
    }
    await assert.rejects(stat(path.join(directory, ".env")), { code: "ENOENT" })
  } finally {
    await rm(directory, { recursive: true })
  }
})
