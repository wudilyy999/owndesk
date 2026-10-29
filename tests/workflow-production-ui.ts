import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { connectVnc } from "./helpers/vnc"
import { innerDocker, stopLinuxHost } from "./helpers/linux-host"

// Resume ONLY the UI/security tail against the retained four successful Tasks.
// One additional ready-workflow Task provides a real in-flight desktop; no model.
const prior = JSON.parse(
  await readFile("docs/evidence/workflow-production-attempt.json", "utf8")
)
assert.equal(prior.completed, 4)
assert.equal(prior.actualTasks, 4)
assert.equal(prior.taskCountGate, 4)
const host = JSON.parse(await readFile(path.join(prior.directory, "host.json"), "utf8"))
const directory = path.join(prior.directory, `ui-resume-${Date.now()}`)
await mkdir(directory, { recursive: true, mode: 0o700 })
host.directory = directory
const parseEnv = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
const config = parseEnv(
  await readFile(path.join(prior.directory, "deployment/.env"), "utf8")
)
const owner = parseEnv(
  await readFile(path.join(prior.directory, "deployment/owner.env"), "utf8")
)
const origin = `https://localhost:${host.httpsPort}`
const composeArgs = [
  "compose",
  "--file",
  path.resolve("deploy/compose.yaml"),
  "--env-file",
  path.join(prior.directory, "deployment/.env"),
  "--project-name",
  `pa-${config.INSTALL_ID}`,
]
const worker = `pa-${config.INSTALL_ID}-worker-1`
const checks: string[] = []
let taskId: string | undefined
let metrics
let passed = false
let workerStarted = false
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let watch: Awaited<ReturnType<typeof connectVnc>> | undefined
async function workerCode(code: string) {
  return (
    await innerDocker(
      host,
      ["exec", worker, "node", "--import", "tsx", "--input-type=module", "-e", code],
      { timeoutMs: 120000 }
    )
  ).stdout.toString()
}
async function until<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const end = Date.now() + 120000
  while (Date.now() < end) {
    const value = await read()
    if (value !== null) return value
    await delay(150)
  }
  throw new Error(`Timed out: ${message}`)
}
try {
  const oldGuests = (
    await innerDocker(host, [
      "ps",
      "-aq",
      "--filter",
      `label=personal-agent.install=${config.INSTALL_ID}`,
    ])
  ).stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
  if (oldGuests.length) await innerDocker(host, ["rm", "--force", ...oldGuests])
  await innerDocker(
    host,
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--volume",
      "/var/run/docker.sock:/var/run/docker.sock",
      ...[
        "INSTALL_ID",
        "APP_URL",
        "WORKSTATION_NETWORK",
        "PA_GUEST_SUBNET",
        "PA_CONTROL_IPS",
      ].flatMap((name) => ["--env", name]),
      config.PA_WORKER_IMAGE,
      "node",
      "scripts/network.mjs",
      "init",
    ],
    { env: config }
  )
  const started = await innerDocker(
    host,
    [...composeArgs, "up", "-d", "--no-build", "--wait", "--wait-timeout", "120"],
    { env: config, timeoutMs: 180000 }
  )
  await writeFile(
    path.join(directory, "stack-start.log"),
    started.stdout.toString() + started.stderr
  )
  workerStarted = true
  const before = JSON.parse(
    await workerCode(
      `import {pool} from './db/index.ts';import {readBenchmarkTask} from './lib/workflow-benchmark-db.ts';const rows=(await pool.query('SELECT id,agent_id FROM tasks ORDER BY created_at')).rows;const metrics=[];for(const row of rows)metrics.push(await readBenchmarkTask(pool,row.id,'validation'));console.log(JSON.stringify({metrics,agentId:rows[0].agent_id}));await pool.end();`
    )
  )
  assert.equal(before.metrics.length, 4)
  assert(
    before.metrics.every(
      (m: { status: string; actions: unknown[]; attempts: unknown[] }) =>
        m.status === "completed" && m.actions.length === 27 && m.attempts.length === 0
    )
  )
  const agentId = before.agentId
  const versionId = prior.checks.find(
    (c: { detail?: { versionId?: string } }) => c.detail?.versionId
  ).detail.versionId
  const guest = `pa-${config.INSTALL_ID.slice(0, 8)}-ws-${agentId}`
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.UI_BROWSER_PATH,
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  })
  const headers = { Origin: origin }
  assert.equal(
    (
      await context.request.post(`${origin}/api/auth/sign-in/email`, {
        headers,
        data: { email: owner.OWNER_EMAIL, password: owner.OWNER_PASSWORD },
      })
    ).status(),
    200
  )
  const submitted = await context.request.post(`${origin}/api/tasks`, {
    headers,
    data: {
      agentId,
      goal: "生产观看定向验收：运行中的只读桌面",
      clientRequestId: randomUUID(),
      workflowExecution: {
        versionId,
        purpose: "run",
        parameters: {
          input1: `PA-UI-Production-${Date.now()}`,
          input2: "UI-draft",
          input3: "UI-ready",
        },
        maxActions: 120,
        maxDurationSeconds: 300,
      },
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 1, maxCostMicros: 0 },
    },
  })
  assert.equal(submitted.status(), 202, await submitted.text())
  taskId = (await submitted.json()).taskId
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`${origin}/?task=${taskId}`)
  const desktop = page.getByRole("region", { name: "工作站桌面", exact: true })
  await desktop.getByRole("button", { name: "连接桌面", exact: true }).click()
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas")
    if (!canvas || canvas.width < 640 || canvas.height < 400) return false
    const colors = new Set<string>()
    const ctx = canvas.getContext("2d")!
    for (let y = 10; y < canvas.height; y += 80)
      for (let x = 10; x < canvas.width; x += 80)
        colors.add([...ctx.getImageData(x, y, 1, 1).data].join(","))
    return colors.size >= 3
  })
  await page.screenshot({
    path: path.join(directory, "workflow-desktop-production.png"),
    fullPage: true,
  })
  const state = await (await context.request.get(`${origin}/api/tasks/${taskId}`)).json()
  assert(
    ["running", "waiting_user"].includes(state.status),
    "Framebuffer must be observed while the actual Task owns its control row"
  )
  checks.push(
    "Actual optimized production noVNC canvas shows a non-uniform framebuffer during a real active workflow Task over Caddy HTTPS/WSS"
  )
  const ticket = await context.request.post(`${origin}/api/desktop-tickets`, {
    headers,
    data: { agentId, mode: "watch" },
  })
  assert.equal(ticket.status(), 200)
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ")
  const ca = await readFile(path.join(prior.directory, "caddy-root.crt"))
  watch = await connectVnc(await ticket.json(), origin, cookie, ca)
  const pointer = () =>
    innerDocker(host, ["exec", guest, "xdotool", "getmouselocation", "--shell"]).then(
      (r) => r.stdout.toString()
    )
  const initial = await pointer()
  watch.pointer(17, 29, 1)
  watch.key(0xff0d, true)
  watch.key(0xff0d, false)
  await delay(200)
  assert.equal(await pointer(), initial)
  watch.socket.terminate()
  const inspect = async (name: string) =>
    JSON.parse((await innerDocker(host, ["inspect", name])).stdout.toString())[0]
  const guestMeta = await inspect(guest)
  assert.equal(guestMeta.Image, before.metrics[0].environment.workstationImageId)
  assert.equal(guestMeta.Config.Labels["personal-agent.protocol"], "6")
  assert.equal(Object.keys(guestMeta.HostConfig.PortBindings ?? {}).length, 0)
  assert(
    !guestMeta.Mounts.some(
      (m: { Destination: string }) => m.Destination === "/var/run/docker.sock"
    )
  )
  assert(
    !guestMeta.Config.Env.some((v: string) =>
      /^(MASTER_KEY|BETTER_AUTH_SECRET|DATABASE_URL)=/.test(v)
    )
  )
  const webId = (
    await innerDocker(host, [...composeArgs, "ps", "-q", "web"], { env: config })
  ).stdout
    .toString()
    .trim()
  const web = await inspect(webId)
  assert(web.HostConfig.ReadonlyRootfs)
  assert.notEqual(web.Config.User, "root")
  const webIp = (Object.values(web.NetworkSettings.Networks)[0] as { IPAddress: string })
    .IPAddress
  assert(
    JSON.parse(
      await workerCode(
        "console.log(JSON.stringify({reachable:(await fetch('http://web:6797/login')).ok}))"
      )
    ).reachable
  )
  const probe = await innerDocker(host, [
    "exec",
    guest,
    "node",
    "--input-type=module",
    "-e",
    `try{await fetch('http://${webIp}:6797/login',{signal:AbortSignal.timeout(1500)});console.log(true)}catch(e){console.log(false)}`,
  ])
  assert.equal(JSON.parse(probe.stdout.toString()), false)
  checks.push(
    "Readonly WSS pointer/key input is dropped; worker reaches the actual Web endpoint while guest is blocked; guest has exact guest6 image/no secrets/socket/ports and Web remains non-root/read-only"
  )
  const done = await until(async () => {
    const result = await (
      await context.request.get(`${origin}/api/tasks/${taskId}`)
    ).json()
    assert(
      !["failed", "cancelled", "needs_review", "waiting_user"].includes(result.status),
      JSON.stringify({ status: result.status, error: result.error })
    )
    return result.status === "completed" ? result : null
  }, "additional UI Task completion")
  assert.equal(done.result.directoryTree.grade, "program_checked")
  await page.goto(`${origin}/workflows`)
  const form = page.getByRole("region", { name: "导出流程包", exact: true })
  await form.getByRole("button", { name: "准备脱敏流程包", exact: true }).click()
  const download = form.getByRole("button", { name: "下载已审阅的流程包", exact: true })
  await download.waitFor()
  assert(await download.isDisabled())
  await form.getByRole("checkbox").check()
  const downloading = page.waitForEvent("download")
  await download.click()
  await (await downloading).saveAs(path.join(directory, "workflow-reexported.json"))
  const reexported = JSON.parse(
    await readFile(path.join(directory, "workflow-reexported.json"), "utf8")
  )
  assert.deepEqual(reexported.environment, before.metrics[0].environment)
  for (const id of [
    versionId,
    taskId,
    ...prior.taskResults.map((t: { taskId: string }) => t.taskId),
  ])
    assert(!JSON.stringify(reexported).includes(id))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(directory, "workflow-production-mobile.png"),
    fullPage: true,
  })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false
  )
  assert.deepEqual(errors, [])
  checks.push(
    "Actual reviewed owner download exports the certified method without local Task/version IDs; 390px production UI has no horizontal overflow or page error"
  )
  const after = JSON.parse(
    await workerCode(
      `import {pool} from './db/index.ts';import {readBenchmarkTask} from './lib/workflow-benchmark-db.ts';const metrics=[];for(const id of ${JSON.stringify(prior.taskResults.map((t: { taskId: string }) => t.taskId))})metrics.push(await readBenchmarkTask(pool,id,'validation'));console.log(JSON.stringify({metrics,ui:await readBenchmarkTask(pool,${JSON.stringify(taskId)},'ui'),tasks:Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count),models:Number((await pool.query('SELECT count(*) FROM task_model_attempts')).rows[0].count)}));await pool.end();`
    )
  )
  assert.deepEqual(after.metrics, before.metrics)
  assert.equal(after.tasks, 5)
  assert.equal(after.models, 0)
  assert.equal(after.ui.actions.length, 27)
  assert.equal(after.ui.requests.length, 0)
  metrics = after.ui
  checks.push(
    "Original four successful Task metrics remain unchanged; exactly one new checked27-action UI Task, total5Tasks/135actions/0model/0human requests"
  )
  passed = true
} finally {
  watch?.socket.terminate()
  await browser?.close()
  if (workerStarted) {
    if (taskId && !passed)
      await workerCode(
        `import {pool} from './db/index.ts';import {requestCancellation} from './lib/task-control.ts';const t=(await pool.query('SELECT owner_id,status FROM tasks WHERE id=$1',[${JSON.stringify(taskId)}])).rows[0];if(!['completed','cancelled','failed'].includes(t.status))await requestCancellation(t.owner_id,${JSON.stringify(taskId)});await pool.end();`
      )
    await workerCode(
      "import {pool} from './db/index.ts';import {stopInstallationWorkstations} from './lib/workstation.ts';await stopInstallationWorkstations();await pool.end();"
    )
  }
  const logs = await innerDocker(host, [...composeArgs, "logs", "--no-color"], {
    env: config,
  })
  await writeFile(
    path.join(directory, "stack.log"),
    logs.stdout.toString() + logs.stderr,
    { mode: 0o600 }
  )
  await innerDocker(host, [...composeArgs, "down", "--timeout", "30"], {
    env: config,
    timeoutMs: 120000,
  })
  const evidence = {
    passed,
    directory,
    retainedAttempt: prior.directory,
    retainedWorkflowTasks: prior.taskResults,
    retainedWorkflowTaskCountGate: 4,
    additionalUiTaskCountGate: 1,
    taskId,
    checks,
    metrics,
    scope:
      "Targeted production UI/security/export tail with original four successful Tasks unchanged and one new actual active GUI Task; no repeat of four-sample acceptance, no cloud model, not full deployment/public DNS/restore acceptance",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  await writeFile(
    "docs/evidence/workflow-production-ui-attempt.json",
    JSON.stringify(evidence, null, 2)
  )
  if (passed)
    await writeFile(
      "docs/evidence/workflow-production-ui.json",
      JSON.stringify(evidence, null, 2)
    )
  await stopLinuxHost(host, false)
}
console.log(JSON.stringify({ passed, directory, taskId }))
