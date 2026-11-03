import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker, dockerRaw } from "@/lib/docker"

const image = process.env.PA_BROWSER_TEST_IMAGE ?? "owndesk-workstation:0.7.0"
const name = `pa-browser-startup-${randomUUID().slice(0, 8)}`
const directory = path.resolve("data/experiments", name)
await mkdir(directory, { recursive: true })
const checks: string[] = []
let created = false
const post = async (route: string, input: unknown) => {
  const result = await docker(
    [
      "exec",
      "-i",
      name,
      "node",
      "--input-type=module",
      "-e",
      `
let input = ''; for await (const chunk of process.stdin) input += chunk;
const response = await fetch('http://127.0.0.1:6079'+process.argv[1], {
  method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.PA_WORKSPACE_TOKEN},body:input
}); console.log(JSON.stringify({status:response.status,body:await response.json()}));
`,
      route,
    ],
    { input: JSON.stringify(input) }
  )
  return JSON.parse(result.stdout.toString())
}
const health = async () =>
  JSON.parse(
    (
      await docker(["exec", name, "curl", "-fsS", "http://127.0.0.1:6079/health"])
    ).stdout.toString()
  )
async function capture(file: string) {
  await docker(["exec", name, "scrot", `/tmp/${file}`])
  await docker(["cp", `${name}:/tmp/${file}`, path.join(directory, file)])
}
async function openAction(id: string, url: string) {
  const accepted = await post("/actions", { id, kind: "open", params: { epoch: 1, url } })
  assert.equal(accepted.status, 200)
  const deadline = Date.now() + 35000
  while (Date.now() < deadline) {
    const result = await post("/action-status", { id })
    assert.equal(result.status, 200)
    if (result.body.status === "succeeded") return result.body.result
    assert(
      !["failed", "unknown", "rejected"].includes(result.body.status),
      JSON.stringify(result.body)
    )
    await delay(100)
  }
  throw new Error(`Browser action timed out: ${id}`)
}
try {
  await docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      "--shm-size",
      "1g",
      "--cpus",
      "2",
      "--memory",
      "2048m",
      image,
    ],
    {
      env: {
        PA_WORKSPACE_TOKEN: randomUUID(),
        OWNDESK_VNC_PASSWORD: randomUUID().slice(0, 8),
      },
    }
  )
  created = true
  await docker(["exec", name, "owndesk-ready"], { timeoutMs: 45000 })
  const initial = await health()
  assert.equal(initial.mode, "idle")
  assert.equal((await post("/pages", { epoch: 0 })).body.pages.length, 0)
  assert.equal((await dockerRaw(["exec", name, "pgrep", "-x", "chromium"])).exitCode, 1)
  await capture("desktop-start.png")
  checks.push("Cold desktop starts without Chromium or an about:blank tab")

  await docker([
    "exec",
    "-d",
    name,
    "node",
    "-e",
    `require('node:http').createServer((req,res)=>res.end('<html><title>Browser startup check</title><button>Continue</button><p>'+req.url+'</p></html>')).listen(18765,'127.0.0.1')`,
  ])
  assert.equal((await post("/control", { epoch: 1, mode: "human" })).status, 200)
  const firstUrl = "http://127.0.0.1:18765/first"
  assert.equal((await post("/open", { epoch: 1, url: firstUrl })).status, 409)
  await docker(["exec", name, "browser", firstUrl])
  let listing = await post("/pages", { epoch: 1 })
  assert.equal(listing.body.pages.length, 1)
  assert.equal(listing.body.pages[0].url, firstUrl)
  assert.equal(listing.body.pages[0].title, "Browser startup check")
  await capture("browser-requested.png")
  checks.push(
    "Human browser launcher opens the target in one tab; agent /open stays fenced"
  )

  const pageId = listing.body.pages[0].pageId
  const quiet = await post("/quiesce", { epoch: 2 })
  assert.equal(quiet.status, 200)
  assert.equal(quiet.body.bootId, initial.bootId)
  assert.equal((await post("/desktop-browser", { epoch: 2, url: firstUrl })).status, 409)
  assert.equal((await post("/control", { epoch: 3, mode: "agent" })).status, 200)
  assert.equal((await post("/desktop-browser", { epoch: 3, url: firstUrl })).status, 409)
  listing = await post("/pages", { epoch: 3 })
  assert.equal(listing.body.pages[0].pageId, pageId)
  assert.equal(listing.body.pages[0].url, firstUrl)
  checks.push(
    "Warm handback preserves the original page and boot; desktop launch is rejected during agent/quiescing control"
  )

  await docker(["restart", "--time", "10", name], { timeoutMs: 45000 })
  await docker(["exec", name, "owndesk-ready"], { timeoutMs: 45000 })
  const restarted = await health()
  assert.notEqual(restarted.bootId, initial.bootId)
  assert.equal((await post("/pages", { epoch: 0 })).body.pages.length, 0)
  assert.equal((await dockerRaw(["exec", name, "pgrep", "-x", "chromium"])).exitCode, 1)
  await capture("desktop-restarted.png")
  checks.push("Cold restart returns to the desktop without reopening a blank browser")

  await docker([
    "exec",
    "-d",
    name,
    "node",
    "-e",
    `require('node:http').createServer((req,res)=>res.end('<html><title>Concurrent browser check</title><button>Continue</button><p>'+req.url+'</p></html>')).listen(18765,'127.0.0.1')`,
  ])
  assert.equal((await post("/control", { epoch: 1, mode: "agent" })).status, 200)
  const secondUrl = "http://127.0.0.1:18765/second"
  const opened = await Promise.all([
    openAction("open-first", firstUrl),
    openAction("open-second", secondUrl),
  ])
  assert.notEqual(opened[0].pageId, opened[1].pageId)
  listing = await post("/pages", { epoch: 1 })
  assert.deepEqual(listing.body.pages.map((p: { url: string }) => p.url).sort(), [
    firstUrl,
    secondUrl,
  ])
  assert.equal(
    (await post("/observe", { epoch: 1, pageId: opened[0].pageId })).status,
    200
  )
  assert.equal(
    (await post("/screenshot", { epoch: 1, pageId: opened[0].pageId })).status,
    200
  )
  checks.push(
    "Concurrent journaled browser opens share one browser and produce two separate target tabs, without a spare blank tab; DOM and screenshot remain usable"
  )

  const imageId = (
    await docker(["image", "inspect", image, "--format", "{{.Id}}"])
  ).stdout
    .toString()
    .trim()
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        passed: true,
        image,
        imageId,
        name,
        checks,
        modelRequests: 0,
        taskSubmissions: 0,
        recordedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    JSON.stringify({ passed: true, directory, checks, modelRequests: 0 }, null, 2)
  )
} catch (error) {
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify({ passed: false, name, checks, error: String(error) }, null, 2) + "\n"
  )
  throw error
} finally {
  if (created) {
    const logs = await dockerRaw(["logs", name])
    await writeFile(
      path.join(directory, "container.log"),
      logs.stdout.toString() + logs.stderr
    )
    await docker(["stop", "--time", "10", name], { timeoutMs: 30000 })
  }
}
