import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { docker, dockerRaw } from "@/lib/docker"
import { env } from "@/lib/env"

const runId = `g02-${Date.now()}`
const container = `personal-agent-${runId}`
const volume = `${container}-home`
const directory = path.resolve("data/experiments", runId)
await mkdir(directory, { recursive: true })
const checks: Record<string, unknown>[] = []
let passed = false

async function browser<T = Record<string, unknown>>(
  route: string,
  body: unknown
): Promise<T> {
  const result = await docker(
    ["exec", "-i", container, "node", "/opt/owndesk-controller/request.mjs", route],
    { input: JSON.stringify(body), timeoutMs: 45000 }
  )
  return JSON.parse(result.stdout.toString())
}
type Observation = {
  pageId: string
  epoch: number
  observationId: string
  text: string
  elements: { ref: string; name: string }[]
}
async function observe(pageId: string, epoch: number) {
  return browser<Observation>("/observe", { pageId, epoch })
}
async function fixture() {
  await docker([
    "cp",
    "tests/fixtures/report-site.mjs",
    `${container}:/tmp/report-site.mjs`,
  ])
  await docker(["exec", "-d", container, "node", "/tmp/report-site.mjs"])
  for (let i = 0; i < 50; i++) {
    const result = await dockerRaw([
      "exec",
      container,
      "curl",
      "-fsS",
      "http://127.0.0.1:8081/health",
    ])
    if (result.exitCode === 0) return
    await delay(100)
  }
  throw new Error("Controlled site did not become ready")
}

try {
  await docker(["volume", "create", "--label", "personal-agent.experiment=G02", volume])
  await docker(
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "personal-agent.experiment=G02",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--shm-size",
      "1g",
      "--env",
      "PA_WORKSPACE_TOKEN",
      "--env",
      "OWNDESK_VNC_PASSWORD",
      "--env",
      "OWNDESK_IDLE_MINUTES=0",
      "--volume",
      `${volume}:/home/agent`,
      env.WORKSTATION_IMAGE,
    ],
    {
      env: {
        PA_WORKSPACE_TOKEN: randomBytes(32).toString("hex"),
        OWNDESK_VNC_PASSWORD: randomBytes(6).toString("base64"),
      },
    }
  )
  await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
  await fixture()
  await browser("/control", { epoch: 1, mode: "agent" })
  const { pageId } = await browser<{ pageId: string }>("/open", {
    epoch: 1,
    url: "http://127.0.0.1:8081/reports",
  })
  const login = await observe(pageId, 1)
  assert.match(login.text, /Sign in to reports/)
  const username = login.elements.find((e) => e.name === "username")!
  await browser("/fill", {
    epoch: 1,
    pageId,
    observationId: login.observationId,
    ref: username.ref,
    text: "demo",
  })
  await browser("/control", { epoch: 2, mode: "human" })
  await assert.rejects(
    browser("/fill", {
      epoch: 1,
      pageId,
      observationId: login.observationId,
      ref: username.ref,
      text: "stale",
    })
  )
  // Real desktop keyboard events operate on the same page; no second browser is started.
  await docker(["exec", container, "xdotool", "key", "Tab"])
  await docker([
    "exec",
    container,
    "xdotool",
    "type",
    "--clearmodifiers",
    "--delay",
    "20",
    "demo",
  ])
  await docker(["exec", container, "xdotool", "key", "Return"])
  let loggedIn: Observation | undefined
  for (let i = 0; i < 50; i++) {
    const current = await observe(pageId, 2)
    if (current.text.includes("Signed in as demo")) {
      loggedIn = current
      break
    }
    await delay(100)
  }
  assert(loggedIn, "Desktop keyboard login must be visible to DOM observations")
  checks.push({
    check: "DOM fill + desktop keyboard login share one headed browser",
    passed: true,
  })
  await browser("/control", { epoch: 3, mode: "agent" })
  const report = await observe(pageId, 3)
  const link = report.elements.find((e) => e.name === "Week report")!
  const download = await browser<{ path: string }>("/download", {
    epoch: 3,
    pageId,
    observationId: report.observationId,
    ref: link.ref,
    actionId: "report-download-1",
  })
  await docker([
    "cp",
    `${container}:${download.path}`,
    path.join(directory, "week-report.csv"),
  ])
  assert.match(
    await readFile(path.join(directory, "week-report.csv"), "utf8"),
    /^date,site,amount\n/
  )
  const shot = await browser<{ image: string }>("/screenshot", { epoch: 3, pageId })
  await writeFile(path.join(directory, "browser.jpeg"), Buffer.from(shot.image, "base64"))
  const desktop = await docker(["exec", container, "owndesk-shot"])
  await writeFile(
    path.join(directory, "desktop.jpeg"),
    Buffer.from(desktop.stdout.toString(), "base64")
  )
  const state = await docker([
    "exec",
    container,
    "curl",
    "-fsS",
    "http://127.0.0.1:8081/state",
  ])
  assert.equal(JSON.parse(state.stdout.toString()).downloads, 1)
  checks.push({
    check: "DOM download, browser screenshot and desktop screenshot share report session",
    passed: true,
    downloads: 1,
  })

  const browserMetadata = await docker([
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    `
    import { chromium } from '/opt/owndesk-controller/node_modules/playwright-core/index.mjs';
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log(JSON.stringify({ contexts: browser.contexts().length,
      cookies: (await browser.contexts()[0].cookies()).map(({name,domain,expires}) => ({name,domain,expires})) }));
    process.exit(0);
  `,
  ])
  await writeFile(
    path.join(directory, "browser-metadata.json"),
    browserMetadata.stdout.toString()
  )
  const processes = await docker(["exec", container, "ps", "-eo", "args"])
  await writeFile(
    path.join(directory, "browser-processes.txt"),
    processes.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes("chromium"))
      .join("\n")
  )

  await docker(["restart", "--time", "20", container], { timeoutMs: 45000 })
  await docker(["exec", container, "owndesk-ready"], { timeoutMs: 45000 })
  await fixture()
  await browser("/control", { epoch: 4, mode: "agent" })
  const reopened = await browser<{ pageId: string }>("/open", {
    epoch: 4,
    url: "http://127.0.0.1:8081/reports",
  })
  const restored = await observe(reopened.pageId, 4)
  const profile = await dockerRaw([
    "exec",
    container,
    "python3",
    "-c",
    "import sqlite3,json; c=sqlite3.connect('/home/agent/.config/owndesk-browser/Default/Cookies'); print(json.dumps(c.execute('select host_key,name,expires_utc,is_persistent from cookies').fetchall()))",
  ])
  await writeFile(
    path.join(directory, "cookie-metadata.json"),
    profile.stdout.toString() + profile.stderr
  )
  assert.match(restored.text, /Signed in as demo/)
  const ports = await docker([
    "inspect",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    container,
  ])
  assert.deepEqual(JSON.parse(ports.stdout.toString()), {})
  const version = await docker(["exec", container, "chromium", "--version"])
  checks.push({
    check: "Cookie survives container restart; no workstation ports published",
    passed: true,
    browser: version.stdout.toString().trim(),
  })
  passed = true
} finally {
  const logs = await dockerRaw(["exec", container, "cat", "/tmp/owndesk/browser.log"])
  await writeFile(
    path.join(directory, "browser.log"),
    logs.stdout.toString() + logs.stderr
  )
  const containerLogs = await dockerRaw(["logs", container])
  await writeFile(
    path.join(directory, "desktop.log"),
    containerLogs.stdout.toString() + containerLogs.stderr
  )
  const removal = await dockerRaw(["rm", "--force", container])
  if (removal.exitCode !== 0)
    console.error("Experiment container cleanup failed", removal.stderr)
  const removedVolume = await dockerRaw(["volume", "rm", volume])
  if (removedVolume.exitCode !== 0)
    console.error("Experiment volume cleanup failed", removedVolume.stderr)
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed, checks, recordedAt: new Date().toISOString() }, null, 2) +
      "\n"
  )
  console.log(JSON.stringify({ passed, checks, evidence: directory }, null, 2))
}
