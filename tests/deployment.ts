import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import https from "node:https"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  chromium,
  type Page,
  type Locator,
  type Response as BrowserResponse,
} from "playwright"
import { DockerError } from "@/lib/docker"
import { APPLICATION_VERSION } from "@/lib/durable"
import { connectVnc } from "./helpers/vnc"
import { linuxHost, innerDocker, loadImages, stopLinuxHost } from "./helpers/linux-host"

assert(
  process.argv.length === 2 ||
    (process.argv.length === 3 && ["basic-cua", "workflow"].includes(process.argv[2])),
  "Use deployment.ts [basic-cua|workflow]"
)
const basicCua = process.argv[2] === "basic-cua"
const workflowCua = process.argv[2] === "workflow"
const expectedMigrations = JSON.parse(
  await readFile("db/migrations/meta/_journal.json", "utf8")
).entries.length
const host = await linuxHost()
const workerImage = `owndesk-worker:${APPLICATION_VERSION}`
const checks: { check: string; detail?: unknown }[] = []
let passed = false
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let page: Page | undefined
const sockets: { terminate(): void }[] = []
const fixtures = new Set<string>()
const taskResults: { taskId: string; status: string }[] = []
let runtimeMetadata: { version: string; businessMigrations: number } | undefined
let publicNetworkCreated = false
const configDir = path.join(host.directory, "deployment")
const envFile = path.join(configDir, ".env")
const ownerFile = path.join(configDir, "owner.env")
const origin = `https://localhost:${host.httpsPort}`
const fixtureKey = randomBytes(20).toString("hex")
let config!: Record<string, string>
let worker = ""
const composeArgs = [
  "compose",
  "--file",
  path.resolve("deploy/compose.yaml"),
  "--env-file",
  envFile,
]

async function until<T>(
  fn: () => Promise<T | false | undefined>,
  name: string,
  timeout = 90000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await fn()
    if (value) return value
    assert(Date.now() < deadline, `Timed out: ${name}`)
    await delay(200)
  }
}
function parseEnv(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
}
async function compose(args: string[], log: string) {
  const result = await innerDocker(
    host,
    [...composeArgs, "--project-name", `pa-${config.INSTALL_ID}`, ...args],
    { env: config, timeoutMs: 180000 }
  )
  await writeFile(
    path.join(host.directory, `${log}.log`),
    result.stdout.toString() + result.stderr
  )
  return result
}
async function guard(mode: "init" | "check") {
  return innerDocker(
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
      workerImage,
      "node",
      "scripts/network.mjs",
      mode,
    ],
    { env: config, timeoutMs: 30000 }
  )
}
async function workerCode(code: string) {
  return innerDocker(
    host,
    ["exec", worker, "node", "--import", "tsx", "--input-type=module", "-e", code],
    { timeoutMs: 120000 }
  )
}
async function inspect(name: string) {
  return JSON.parse((await innerDocker(host, ["inspect", name])).stdout.toString())[0]
}
async function fixture(
  name: string,
  network: string,
  file: string,
  ip?: string,
  extra: string[] = [],
  environment: Record<string, string> = {}
) {
  await innerDocker(
    host,
    [
      "create",
      "--name",
      name,
      "--network",
      network,
      ...(ip ? ["--ip", ip] : []),
      ...extra,
      "--entrypoint",
      "node",
      workerImage,
      `/tmp/${path.basename(file)}`,
    ],
    { env: environment }
  )
  fixtures.add(name)
  await innerDocker(host, ["cp", file, `${name}:/tmp/${path.basename(file)}`])
  await innerDocker(host, ["start", name])
}
function probeCode(address: string, port: number) {
  return `const s=require('node:net').connect(${port},${JSON.stringify(address)}); s.setTimeout(1200);s.on('connect',()=>{console.log(JSON.stringify({connected:true}));s.destroy()});s.on('timeout',()=>{console.log(JSON.stringify({connected:false,error:'TIMEOUT'}));s.destroy()});s.on('error',e=>console.log(JSON.stringify({connected:false,error:e.code})));`
}

try {
  execFileSync(process.execPath, [
    "scripts/deploy-env.mjs",
    origin,
    "owner@cloud-fixture.test",
    configDir,
  ])
  config = parseEnv(await readFile(envFile, "utf8"))
  assert.equal(config.PA_WORKER_IMAGE, workerImage)
  assert.equal(config.PA_WEB_IMAGE, `owndesk-web:${APPLICATION_VERSION}`)
  await loadImages(host, [
    config.PA_WORKER_IMAGE,
    config.PA_WEB_IMAGE,
    config.PA_WORKSTATION_IMAGE,
    "postgres:16.15-alpine",
    "caddy:2.11.7-alpine",
  ])
  const existingNetworks = JSON.parse(
    (
      await innerDocker(host, [
        "network",
        "inspect",
        ...(await innerDocker(host, ["network", "ls", "--format", "{{.Name}}"])).stdout
          .toString()
          .trim()
          .split("\n"),
      ])
    ).stdout.toString()
  )
  const occupied = existingNetworks.flatMap((network: any) =>
    (network.IPAM.Config ?? []).map((entry: any) => entry.Subnet)
  )
  config.PA_GUEST_SUBNET = Array.from(
    { length: 55 },
    (_, n) => `172.30.${200 + n}.0/24`
  ).find((subnet) => !occupied.includes(subnet))!
  assert(config.PA_GUEST_SUBNET, "No unused test subnet remains")
  Object.assign(config, {
    PA_BIND_IP: "0.0.0.0",
    WORKSTATION_CPUS: "1",
    WORKSTATION_MEMORY_MB: "1536",
    PA_CONTROL_IPS: "93.184.216.9",
    ...(host.kind === "colima"
      ? {
          PA_BIND_IP: "127.0.0.1",
          PA_HTTPS_PORT: host.httpsPort,
          PA_HTTP_PORT: host.httpPort!,
        }
      : {}),
  })
  await writeFile(
    envFile,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  // The remote test daemon needs the same Caddy bind path as the local Compose client.
  const caddyFile = path.resolve("deploy/Caddyfile")
  await innerDocker(host, [
    "run",
    "--rm",
    "--network",
    "none",
    "--volume",
    `${path.dirname(caddyFile)}:/config`,
    "--entrypoint",
    "node",
    workerImage,
    "-e",
    `require('node:fs').writeFileSync('/config/Caddyfile',${JSON.stringify(await readFile(caddyFile, "utf8"))})`,
  ])
  await assert.rejects(guard("check"), DockerError)
  const network = JSON.parse((await guard("init")).stdout.toString())
  await guard("check")
  checks.push({
    check:
      "Fresh rootful Linux Docker: absent policy rejected; scoped bridge/firewall initialized and live rules verified",
    detail: network,
  })

  await compose(["up", "-d", "postgres"], "postgres-start")
  await compose(["run", "--rm", "worker", "npm", "run", "db:migrate"], "migrate")
  await compose(
    ["run", "--rm", "--env-from-file", ownerFile, "worker", "npm", "run", "owner:create"],
    "owner-init"
  )
  await assert.rejects(
    compose(
      [
        "run",
        "--rm",
        "--env-from-file",
        ownerFile,
        "worker",
        "npm",
        "run",
        "owner:create",
      ],
      "owner-repeat"
    ),
    (error: unknown) =>
      error instanceof DockerError &&
      error.stderr.includes("Owner is already initialized")
  )
  await compose(
    ["up", "-d", "--no-build", "--wait", "--wait-timeout", "120"],
    "stack-start"
  )
  worker = (await compose(["ps", "-q", "worker"], "worker-id")).stdout.toString().trim()
  runtimeMetadata = JSON.parse(
    (
      await workerCode(
        "import {pool} from './db/index.ts';const health=await(await fetch('http://127.0.0.1:6798/health')).json();console.log(JSON.stringify({version:health.version,businessMigrations:Number((await pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count)}));await pool.end();"
      )
    ).stdout.toString()
  )
  assert.equal(runtimeMetadata!.version, APPLICATION_VERSION)
  assert.equal(runtimeMetadata!.businessMigrations, expectedMigrations)
  const caddy = (await compose(["ps", "-q", "caddy"], "caddy-id")).stdout
    .toString()
    .trim()
  const caFile = path.join(host.directory, "caddy-root.crt")
  await innerDocker(host, [
    "cp",
    `${caddy}:/data/caddy/pki/authorities/local/root.crt`,
    caFile,
  ])
  const ca = await readFile(caFile)
  await until(
    () =>
      new Promise<boolean>((resolve, reject) => {
        https
          .get(`${origin}/login`, { ca }, (res) => {
            res.resume()
            if (res.statusCode === 200) resolve(true)
            else reject(new Error(`HTTPS entry returned ${res.statusCode}`))
          })
          .on("error", (error) => {
            if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false)
            else reject(error)
          })
      }),
    "host HTTPS entry with a verified certificate"
  )
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.UI_BROWSER_PATH,
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  })
  assert.equal((await context.request.get(`${origin}/api/settings`)).status(), 401)
  const owner = parseEnv(await readFile(ownerFile, "utf8"))
  assert.equal(
    (
      await context.request.post(`${origin}/api/auth/sign-in/email`, {
        headers: { Origin: origin },
        data: { email: owner.OWNER_EMAIL, password: owner.OWNER_PASSWORD },
      })
    ).status(),
    200
  )
  page = await context.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(`${origin}/settings`)
  await page.getByRole("heading", { name: "模型与 Agent", exact: true }).waitFor()
  await page.screenshot({
    path: path.join(host.directory, "settings.png"),
    fullPage: true,
  })
  for (const service of ["web", "worker", "postgres"]) {
    const id = (await compose(["ps", "-q", service], `${service}-id`)).stdout
      .toString()
      .trim()
    const container = await inspect(id)
    assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0)
    if (service !== "worker")
      assert(
        !container.Mounts.some(
          (mount: any) => mount.Destination === "/var/run/docker.sock"
        )
      )
  }
  checks.push({
    check:
      "Production Linux Compose: migrations/one-owner init, HTTPS chain validation, owner settings and private DB/Web/worker; only worker mounts Docker",
  })

  const headers = { Origin: origin }
  if (workflowCua) {
    const sharing = JSON.parse(
      await readFile("docs/evidence/workflow-sharing.json", "utf8")
    )
    assert(sharing.passed && /^agent_flowshare_[a-f0-9]+$/.test(sharing.database))
    const packPath = path.join(sharing.directory, "workflow-package.json")
    const pack = JSON.parse(await readFile(packPath, "utf8"))
    const agents = await (await context.request.get(`${origin}/api/agents`)).json()
    const agent = agents.find((row: { model: string | null }) => row.model === null)
    assert(agent)
    await page.goto(`${origin}/workflows`)
    const form = page.getByRole("form", { name: "导入流程包", exact: true })
    await form.getByLabel("选择 JSON 文件", { exact: true }).setInputFiles(packPath)
    await form.getByRole("checkbox").check()
    const importResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workflows/import") &&
        response.request().method() === "POST"
    )
    await form.getByRole("button", { name: "导入为待验证草稿", exact: true }).click()
    const imported = await importResponse
    assert.equal(imported.status(), 201, await imported.text())
    const versionId = (await imported.json()).versionId
    await form.getByRole("status").waitFor()
    const version = () =>
      context.request
        .get(`${origin}/api/workflows/${versionId}`)
        .then((response) => response.json())
    const draft = await version()
    assert.equal(draft.status, "draft")
    assert.equal(draft.sourceTaskId, null)
    assert.equal(draft.compilationTaskId, null)
    assert.equal(draft.validatedEnvironment, null)
    assert.deepEqual(draft.importedPackage, pack)
    const empty = JSON.parse(
      (
        await workerCode(
          "import {pool} from './db/index.ts';console.log(JSON.stringify({tasks:Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count),workstations:Number((await pool.query('SELECT count(*) FROM workstation_control')).rows[0].count),providers:Number((await pool.query(\"SELECT count(*) FROM settings WHERE key LIKE 'provider.%' OR key='model.default'\")).rows[0].count)}));await pool.end();"
        )
      ).stdout.toString()
    )
    assert.deepEqual(empty, { tasks: 0, workstations: 0, providers: 0 })
    checks.push({
      check:
        "Optimized production Web imports the reviewed package into an unverified source-less draft; no Task/workstation/provider configuration created",
      detail: { versionId, packageId: pack.packageId, ...empty },
    })
    const results = []
    for (let index = 0; index < 4; index++) {
      await page.reload()
      const run: Locator = page.getByRole("form", {
        name: index < 3 ? "验证流程样例" : "运行已验证流程",
        exact: true,
      })
      const parameters = {
        input1: `PA-Production-${index}-${Date.now()}`,
        input2: ["Incoming-1", "Draft with spaces", "待处理", "Fourth-draft"][index],
        input3: ["Final-1", "Ready with spaces", "已完成", "Fourth-ready"][index],
      }
      await run.getByLabel("执行工作站", { exact: true }).selectOption(agent.id)
      for (const [name, value] of Object.entries(parameters))
        await run.getByLabel(new RegExp(`（${name}）$`)).fill(value)
      assert.equal(await run.getByRole("checkbox").isChecked(), false)
      const submittedEvent: Promise<BrowserResponse> = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/tasks") && response.request().method() === "POST"
      )
      await run
        .getByRole("button", {
          name: index < 3 ? "验证这个样例" : "执行流程",
          exact: true,
        })
        .click()
      const submitted = await submittedEvent
      assert.equal(submitted.status(), 202, await submitted.text())
      const taskId = (await submitted.json()).taskId
      const recordedTask = { taskId, status: "queued" }
      taskResults.push(recordedTask)
      await page.waitForURL(`**/?task=${taskId}`)
      if (index === 3) {
        const desktop = page.getByRole("region", { name: "工作站桌面", exact: true })
        await desktop.getByRole("button", { name: "连接桌面", exact: true }).click()
        await page.waitForFunction(() => {
          const canvas = document.querySelector("canvas")
          if (!canvas || canvas.width < 640 || canvas.height < 400) return false
          const ctx = canvas.getContext("2d")!
          const colors = new Set<string>()
          for (let y = 10; y < canvas.height; y += 80)
            for (let x = 10; x < canvas.width; x += 80)
              colors.add([...ctx.getImageData(x, y, 1, 1).data].join(","))
          return colors.size >= 3
        })
        await page.screenshot({
          path: path.join(host.directory, "workflow-desktop-production.png"),
          fullPage: true,
        })
      }
      const detail = await until(
        async () => {
          const state = await (
            await context.request.get(`${origin}/api/tasks/${taskId}`)
          ).json()
          recordedTask.status = state.status
          if (
            ["failed", "cancelled", "needs_review", "waiting_user"].includes(state.status)
          )
            throw new Error(
              JSON.stringify({ taskId, status: state.status, error: state.error })
            )
          return state.status === "completed" && state
        },
        `production workflow ${index + 1} completion`,
        300000
      )
      assert.equal(detail.result.directoryTree.grade, "program_checked")
      assert.equal(detail.workflowRun.step, pack.steps.length)
      const current = await version()
      assert.equal(current.status, index < 2 ? "verifying" : "ready")
      if (index < 2) assert.equal(current.validatedEnvironment, null)
      else assert.deepEqual(current.validatedEnvironment, pack.environment)
      const actions = JSON.parse(
        (
          await workerCode(
            `import {pool} from './db/index.ts';console.log(JSON.stringify((await pool.query('SELECT action_no,kind,status FROM task_actions WHERE task_id=$1 ORDER BY action_no',[${JSON.stringify(taskId)}])).rows));await pool.end();`
          )
        ).stdout.toString()
      )
      assert.equal(actions.length, 27)
      assert(
        actions.every(
          (action: { status: string; kind: string }) =>
            action.status === "succeeded" &&
            [
              "desktop_open_application",
              "screen_capture",
              "screen_share",
              "key_press",
              "key_type",
            ].includes(action.kind)
        )
      )
      results.push({
        taskId,
        parameters,
        status: detail.status,
        result: detail.result,
        workflowRun: detail.workflowRun,
        actions,
        versionStatus: current.status,
      })
      await writeFile(
        path.join(host.directory, `workflow-task-${index + 1}.json`),
        JSON.stringify(results.at(-1), null, 2)
      )
      checks.push({
        check: `Production GUI workflow ${index + 1}: changed parameters/host directory check/27 actions, local version ${current.status}`,
        detail: { taskId, versionId },
      })
      if (index === 0)
        await page.screenshot({
          path: path.join(host.directory, "workflow-first-result.png"),
          fullPage: true,
        })
      if (index < 3) await page.goto(`${origin}/workflows`)
    }
    assert.equal(taskResults.length, 4)
    const totals = JSON.parse(
      (
        await workerCode(
          "import {pool} from './db/index.ts';console.log(JSON.stringify({tasks:Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count),actions:Number((await pool.query('SELECT count(*) FROM task_actions')).rows[0].count),modelRequests:Number((await pool.query('SELECT count(*) FROM task_model_attempts')).rows[0].count),humanRequests:Number((await pool.query('SELECT count(*) FROM task_requests')).rows[0].count)}));await pool.end();"
        )
      ).stdout.toString()
    )
    assert.deepEqual(totals, {
      tasks: 4,
      actions: 108,
      modelRequests: 0,
      humanRequests: 0,
    })
    const cookie = (await context.cookies())
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
    const ticket = await context.request.post(`${origin}/api/desktop-tickets`, {
      headers,
      data: { agentId: agent.id, mode: "watch" },
    })
    assert.equal(ticket.status(), 200)
    const watch = await connectVnc(await ticket.json(), origin, cookie, ca)
    sockets.push(watch.socket)
    const guest = `pa-${config.INSTALL_ID.slice(0, 8)}-ws-${agent.id}`
    const beforePointer = (
      await innerDocker(host, ["exec", guest, "xdotool", "getmouselocation", "--shell"])
    ).stdout.toString()
    watch.pointer(17, 29, 1)
    watch.key(0xff0d, true)
    watch.key(0xff0d, false)
    await delay(200)
    assert.equal(
      (
        await innerDocker(host, ["exec", guest, "xdotool", "getmouselocation", "--shell"])
      ).stdout.toString(),
      beforePointer
    )
    watch.socket.terminate()
    const guestMeta = await inspect(guest)
    assert.equal(guestMeta.Image, pack.environment.workstationImageId)
    assert.equal(guestMeta.Config.Labels["personal-agent.protocol"], "6")
    assert.equal(Object.keys(guestMeta.HostConfig.PortBindings ?? {}).length, 0)
    assert(
      !guestMeta.Mounts.some(
        (mount: { Destination: string }) => mount.Destination === "/var/run/docker.sock"
      )
    )
    assert(
      !guestMeta.Config.Env.some((entry: string) =>
        /^(MASTER_KEY|BETTER_AUTH_SECRET|DATABASE_URL)=/.test(entry)
      )
    )
    const webId = (await compose(["ps", "-q", "web"], "workflow-web-id")).stdout
      .toString()
      .trim()
    const webMeta = await inspect(webId)
    assert(webMeta.HostConfig.ReadonlyRootfs)
    assert.notEqual(webMeta.Config.User, "root")
    const webIp = (
      Object.values(webMeta.NetworkSettings.Networks)[0] as { IPAddress: string }
    ).IPAddress
    const positive = await workerCode(
      "console.log(JSON.stringify({reachable:(await fetch('http://web:6797/login')).ok}))"
    )
    assert(JSON.parse(positive.stdout.toString()).reachable)
    const denied = await innerDocker(host, [
      "exec",
      guest,
      "node",
      "--input-type=module",
      "-e",
      `try {await fetch('http://${webIp}:6797/login',{signal:AbortSignal.timeout(1500)});console.log(JSON.stringify({reachable:true}));} catch(error) {console.log(JSON.stringify({reachable:false,error:error.name}));}`,
    ])
    assert.equal(JSON.parse(denied.stdout.toString()).reachable, false)
    await guard("check")
    checks.push({
      check:
        "Caddy HTTPS/WSS shows actual framebuffer; readonly watch cannot move pointer; worker reaches actual Web while guest is blocked; guest6 exact image has no secrets/socket/published ports and Web is non-root/read-only",
      detail: { guestImageId: guestMeta.Image, guestProtocol: 6, ...totals },
    })
    await page.goto(`${origin}/workflows`)
    const exportForm = page.getByRole("region", { name: "导出流程包", exact: true })
    await exportForm.getByRole("button", { name: "准备脱敏流程包", exact: true }).click()
    const downloadButton = exportForm.getByRole("button", {
      name: "下载已审阅的流程包",
      exact: true,
    })
    await downloadButton.waitFor()
    assert.equal(await downloadButton.isDisabled(), true)
    await exportForm.getByRole("checkbox").check()
    const downloadEvent = page.waitForEvent("download")
    await downloadButton.click()
    await (
      await downloadEvent
    ).saveAs(path.join(host.directory, "workflow-reexported.json"))
    const reexported = JSON.parse(
      await readFile(path.join(host.directory, "workflow-reexported.json"), "utf8")
    )
    assert.deepEqual(reexported.environment, pack.environment)
    assert.notEqual(reexported.packageId, pack.packageId)
    for (const id of [versionId, ...taskResults.map((task) => task.taskId)])
      assert(!JSON.stringify(reexported).includes(id))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(host.directory, "workflow-production-mobile.png"),
      fullPage: true,
    })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await writeFile(
      path.join(host.directory, "workflow-results.json"),
      JSON.stringify(
        { versionId, agentId: agent.id, totals, results, environment: pack.environment },
        null,
        2
      )
    )
    checks.push({
      check:
        "Production owner reviewed download re-exports the locally certified method without Task/version identities; 390px UI and optimized client bundle work",
      detail: { versionId },
    })
  } else {
    const control = `pa-${config.INSTALL_ID}_control`
    await innerDocker(host, [
      "network",
      "create",
      "--subnet",
      "93.184.216.0/24",
      `${host.name}-public-fixture`,
    ])
    publicNetworkCreated = true
    await fixture(
      `${host.name}-reports`,
      `${host.name}-public-fixture`,
      "tests/fixtures/report-site.mjs",
      "93.184.216.8",
      ["--env", "FIXTURE_HOST=0.0.0.0", "--publish", "0.0.0.0::8081/tcp"]
    )
    await fixture(
      `${host.name}-model`,
      control,
      "tests/fixtures/cloud-model.mjs",
      undefined,
      ["--network-alias", "cloud-model", "--env", "FIXTURE_KEY"],
      { FIXTURE_KEY: fixtureKey }
    )
    assert.equal(
      (
        await context.request.patch(`${origin}/api/settings`, {
          headers,
          data: [
            { key: "provider.custom.apiKey", value: fixtureKey },
            { key: "provider.custom.baseUrl", value: "http://cloud-model:8080/v1" },
            { key: "model.default", value: "custom/cloud-fixture" },
          ],
        })
      ).status(),
      200
    )
    assert(
      !(await (await context.request.get(`${origin}/api/settings`)).text()).includes(
        fixtureKey
      )
    )
    const created = await context.request.post(`${origin}/api/agents`, {
      headers,
      data: {
        name: "Cloud acceptance",
        role: "Controlled deployment acceptance",
        instructions: "",
        model: "custom/cloud-fixture",
        glyph: randomUUID(),
      },
    })
    assert.equal(created.status(), 201)
    const agent = await created.json()
    const submitted = await context.request.post(`${origin}/api/tasks`, {
      headers,
      data: {
        agentId: agent.id,
        goal: "云部署受控验收：登录并下载报表。",
        clientRequestId: randomUUID(),
        completionContract: {
          requireHumanReview: false,
          artifact: {
            path: "cloud-report.csv",
            requiredColumns: ["date", "site", "amount"],
            minRows: 4,
            dateColumn: "date",
            dateFrom: "2026-10-12",
            dateTo: "2026-10-18",
          },
        },
      },
    })
    assert.equal(submitted.status(), 202)
    const { taskId } = await submitted.json()
    const reportTask = { taskId, status: "submitted" }
    taskResults.push(reportTask)
    const state = async () => {
      const result = await (
        await context.request.get(`${origin}/api/tasks/${taskId}`)
      ).json()
      if (["failed", "needs_review"].includes(result.status))
        await writeFile(
          path.join(host.directory, "task-state.json"),
          JSON.stringify(result, null, 2) + "\n"
        )
      assert(
        !["failed", "needs_review"].includes(result.status),
        JSON.stringify({ status: result.status, error: result.error })
      )
      return result
    }
    const waiting = await until(async () => {
      const detail = await state()
      return detail.control?.mode === "human" && detail
    }, "cloud manual sign-in")
    await page.goto(origin)
    await page.getByLabel("选择 Agent").selectOption(agent.id)
    await page
      .getByRole("navigation", { name: "最近对话" })
      .getByRole("button")
      .filter({ hasText: "云部署受控验收" })
      .click()
    await page.getByRole("heading", { name: "你拥有桌面控制权", exact: true }).waitFor()
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas")
      if (!canvas || canvas.width < 100) return false
      const pixel = canvas
        .getContext("2d")!
        .getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1
        ).data
      return pixel[0] > 100 && pixel[1] > 100 && pixel[2] > 100
    })
    await page.screenshot({
      path: path.join(host.directory, "cloud-watch.png"),
      fullPage: true,
    })
    await innerDocker(host, ["kill", "--signal", "KILL", worker])
    const logMarker = `pa-token.${randomBytes(20).toString("hex")}`
    assert.equal(
      (
        await context.request.get(`${origin}/desktop/recovery-probe`, {
          headers: { "Sec-WebSocket-Protocol": `binary, ${logMarker}` },
        })
      ).status(),
      502
    )
    const proxyLog = await innerDocker(host, ["logs", caddy])
    assert.match(proxyLog.stderr, /recovery-probe/)
    assert(!proxyLog.stderr.includes(logMarker), "Proxy errors exposed a desktop ticket")
    await innerDocker(host, ["start", worker])
    await until(async () => {
      const detail = await state()
      return (
        detail.control?.mode === "human" && detail.control.epoch > waiting.control.epoch
      )
    }, "worker crash recovery while human owns desktop")
    await until(
      async () => (await inspect(worker)).State.Health.Status === "healthy",
      "recovered worker HTTP and desktop gateway are actually listening"
    )
    const ticketResponse = await context.request.post(`${origin}/api/desktop-tickets`, {
      headers,
      data: { agentId: agent.id, mode: "control" },
    })
    assert.equal(ticketResponse.status(), 200)
    const cookie = (await context.cookies())
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
    await new Promise<void>((resolve, reject) => {
      const request = https.get(
        `${origin}/api/tasks/${taskId}/events`,
        { ca, headers: { Cookie: cookie } },
        (response) => {
          let sample = ""
          response.on("data", (chunk) => {
            sample += chunk
            if (/id: \d+\ndata: /.test(sample)) {
              response.destroy()
              resolve()
            }
          })
          response.on("error", reject)
        }
      )
      request.setTimeout(8000, () =>
        request.destroy(new Error("Proxy SSE did not deliver a persisted event"))
      )
      request.on("error", reject)
    })
    const watchTicket = await context.request.post(`${origin}/api/desktop-tickets`, {
      headers,
      data: { agentId: agent.id, mode: "watch" },
    })
    assert.equal(watchTicket.status(), 200)
    const watch = await connectVnc(await watchTicket.json(), origin, cookie, ca)
    sockets.push(watch.socket)
    const cloudGuest = `pa-${config.INSTALL_ID.slice(0, 8)}-ws-${agent.id}`
    const position = async () =>
      (
        await innerDocker(host, [
          "exec",
          cloudGuest,
          "xdotool",
          "getmouselocation",
          "--shell",
        ])
      ).stdout.toString()
    const beforePointer = await position()
    watch.pointer(21, 37)
    await delay(200)
    assert.equal(await position(), beforePointer)
    watch.socket.terminate()
    const vnc = await connectVnc(await ticketResponse.json(), origin, cookie, ca)
    sockets.push(vnc.socket)
    vnc.key(0xff09, true)
    vnc.key(0xff09, false)
    for (const char of "demo") {
      vnc.key(char.charCodeAt(0), true)
      vnc.key(char.charCodeAt(0), false)
    }
    vnc.key(0xff0d, true)
    vnc.key(0xff0d, false)
    await until(
      async () => {
        const result = await workerCode(
          `import {pool} from './db/index.ts';import {workspaceRow,controller} from './lib/workstation.ts';const row=await workspaceRow(${JSON.stringify(agent.id)});const pages=await controller(${JSON.stringify(agent.id)},'/pages',{epoch:row.epoch});const page=pages.pages.find(p=>p.url.startsWith('http://93.184.216.8:8081/'));const observed=await controller(${JSON.stringify(agent.id)},'/observe',{epoch:row.epoch,pageId:page.pageId});console.log(JSON.stringify({signedIn:observed.text.includes('Signed in as demo')}));await pool.end();`
        )
        return JSON.parse(result.stdout.toString()).signedIn
      },
      "actual human login visible in the shared browser",
      15000
    )
    const current = await state()
    const request = current.requests.find(
      (request: any) => request.kind === "takeover" && request.status === "pending"
    )
    assert(request)
    assert.equal(
      (
        await context.request.post(`${origin}/api/task-requests/${request.id}/respond`, {
          headers,
          data: {
            decision: "handback",
            payloadVersion: request.payloadVersion,
            response: { note: "已在受控网站登录。" },
          },
        })
      ).status(),
      202
    )
    const completed = await until(async () => {
      const detail = await state()
      return detail.status === "completed" && detail
    }, "cloud downloaded report delivered")
    reportTask.status = completed.status
    await until(async () => vnc.closed, "cloud control socket revoked")
    assert.equal(completed.artifacts.length, 1)
    const download = await context.request.get(
      `${origin}/api/artifacts/${completed.artifacts[0].id}`
    )
    assert.equal(download.status(), 200)
    const csv = await download.text()
    assert.equal(csv.trim().split("\n").length, 5)
    assert.equal(
      csv
        .trim()
        .split("\n")
        .slice(1)
        .reduce((sum, line) => sum + Number(line.split(",")[2]), 0),
      620
    )
    await writeFile(path.join(host.directory, "cloud-report.csv"), csv)
    const siteState = JSON.parse(
      (
        await innerDocker(host, [
          "exec",
          `${host.name}-reports`,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8081/state').then(r=>r.text()).then(console.log)",
        ])
      ).stdout.toString()
    )
    assert.equal(siteState.downloads, 1)
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.getByRole("heading", { name: "已完成", exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({
      path: path.join(host.directory, "cloud-mobile.png"),
      fullPage: true,
    })
    checks.push({
      check:
        "Production cloud task: CUA/DOM, visible WSS desktop, human RFB login, worker SIGKILL recovery, one download and verified CSV delivery",
      detail: { taskId, downloads: 1, amount: 620 },
    })

    const prefix = config.INSTALL_ID.slice(0, 8)
    const guest = `pa-${prefix}-ws-${agent.id}`
    if (basicCua) {
      const guestMeta = await inspect(guest)
      assert.deepEqual(guestMeta.HostConfig.Dns, [config.PA_GUEST_DNS])
      assert(guestMeta.HostConfig.CapDrop.includes("CAP_NET_RAW"))
      assert.equal(guestMeta.HostConfig.Sysctls["net.ipv6.conf.all.disable_ipv6"], "1")
      assert.equal(Object.keys(guestMeta.HostConfig.PortBindings ?? {}).length, 0)
      assert(
        !guestMeta.Mounts.some(
          (mount: any) => mount.Destination === "/var/run/docker.sock"
        )
      )
      assert(
        !guestMeta.Config.Env.some((entry: string) =>
          /^(MASTER_KEY|DATABASE_URL|BETTER_AUTH_SECRET)=/.test(entry)
        )
      )
      const web = (await compose(["ps", "-q", "web"], "basic-web-id")).stdout
        .toString()
        .trim()
      const address = (await inspect(web)).NetworkSettings.Networks[control].IPAddress
      for (const [trusted, expected] of [
        [true, true],
        [false, false],
      ] as const) {
        const command = trusted
          ? ["run", "--rm", "--network", "host", "--entrypoint", "node", workerImage]
          : ["exec", guest, "node"]
        const result = await innerDocker(host, [
          ...command,
          "-e",
          probeCode(address, 6797),
        ])
        assert.equal(JSON.parse(result.stdout.toString()).connected, expected)
      }
      checks.push({
        check:
          "Basic isolation: guest has no control secrets/socket/published ports; actual Web endpoint reachable from trusted host and blocked from guest",
      })

      const cancel = await context.request.post(`${origin}/api/tasks`, {
        headers,
        data: {
          agentId: agent.id,
          goal: "basic-cua-cancel",
          clientRequestId: randomUUID(),
        },
      })
      assert.equal(cancel.status(), 202)
      const cancellation = await cancel.json()
      const cancelTask = { taskId: cancellation.taskId, status: "submitted" }
      taskResults.push(cancelTask)
      await until(async () => {
        const result = await innerDocker(host, [
          "exec",
          guest,
          "node",
          "-e",
          "console.log(require('node:fs').existsSync('/home/agent/basic-cua-heartbeat'))",
        ])
        return result.stdout.toString().trim() === "true"
      }, "real shell heartbeat before cancellation")
      const home = guestMeta.Mounts.find(
        (mount: any) => mount.Destination === "/home/agent"
      ).Name
      assert.equal(
        (
          await context.request.post(
            `${origin}/api/tasks/${cancellation.taskId}/cancel`,
            {
              headers,
              data: {},
            }
          )
        ).status(),
        202
      )
      await until(async () => {
        const detail = await (
          await context.request.get(`${origin}/api/tasks/${cancellation.taskId}`)
        ).json()
        assert(
          !["failed", "needs_review"].includes(detail.status),
          JSON.stringify(detail)
        )
        return detail.status === "cancelled"
      }, "confirmed production cancellation")
      cancelTask.status = "cancelled"
      assert.equal(
        (await innerDocker(host, ["ps", "-aq", "--filter", `name=^${guest}$`])).stdout
          .toString()
          .trim(),
        ""
      )
      const heartbeatSize = async () =>
        (
          await innerDocker(host, [
            "run",
            "--rm",
            "--network",
            "none",
            "--volume",
            `${home}:/home/agent:ro`,
            "--entrypoint",
            "node",
            workerImage,
            "-e",
            "console.log(require('node:fs').statSync('/home/agent/basic-cua-heartbeat').size)",
          ])
        ).stdout
          .toString()
          .trim()
      const stoppedSize = await heartbeatSize()
      assert(Number(stoppedSize) > 0)
      await delay(1200)
      assert.equal(await heartbeatSize(), stoppedSize)
      checks.push({
        check:
          "Production cancellation: real shell heartbeat starts, owner cancels, guest removed and preserved home heartbeat stops",
        detail: { taskId: cancellation.taskId },
      })
      const counts = JSON.parse(
        (
          await workerCode(
            "import {pool} from './db/index.ts';console.log(JSON.stringify((await pool.query(\"SELECT status,count(*)::int AS count FROM tasks GROUP BY status\")).rows));await pool.end();"
          )
        ).stdout.toString()
      )
      assert.deepEqual(
        counts.sort((a: any, b: any) => a.status.localeCompare(b.status)),
        [
          { status: "cancelled", count: 1 },
          { status: "completed", count: 1 },
        ]
      )
    } else {
      const peerId = randomUUID()
      await workerCode(
        `import {pool} from './db/index.ts';import {ensureWorkstation} from './lib/workstation.ts';await pool.query("INSERT INTO agents(id,name,role,model,glyph,created_at,updated_at) VALUES($1,'Peer fixture','Network test','custom/cloud-fixture','test',now(),now())",[${JSON.stringify(peerId)}]);await ensureWorkstation(${JSON.stringify(peerId)});await pool.end();`
      )
      const peer = `pa-${prefix}-ws-${peerId}`
      await innerDocker(host, [
        "exec",
        "-d",
        peer,
        "node",
        "-e",
        "require('node:http').createServer((q,r)=>r.end('peer')).listen(8080,'0.0.0.0')",
      ])
      await innerDocker(host, [
        "run",
        "-d",
        "--name",
        `${host.name}-host-fixture`,
        "--network",
        "host",
        "--entrypoint",
        "node",
        workerImage,
        "-e",
        "require('node:http').createServer((q,r)=>r.end('host')).listen(8080,'0.0.0.0')",
      ])
      fixtures.add(`${host.name}-host-fixture`)
      for (const address of ["169.254.169.254", "100.100.100.200", "168.63.129.16"]) {
        await innerDocker(host, [
          "run",
          "--rm",
          "--network",
          "host",
          "--cap-add",
          "NET_ADMIN",
          "--entrypoint",
          "ip",
          workerImage,
          "addr",
          "add",
          `${address}/32`,
          "dev",
          "lo",
        ])
      }
      await innerDocker(host, [
        "run",
        "-d",
        "--name",
        `${host.name}-public-control`,
        "--network",
        `${host.name}-public-fixture`,
        "--ip",
        "93.184.216.9",
        "--entrypoint",
        "node",
        workerImage,
        "-e",
        "require('node:http').createServer((q,r)=>r.end('control')).listen(8080,'0.0.0.0')",
      ])
      fixtures.add(`${host.name}-public-control`)
      const endpoints: { name: string; address: string; port: number }[] = []
      for (const [service, port] of [
        ["postgres", 5432],
        ["worker", 6798],
        ["web", 6797],
      ] as const) {
        const id = (await compose(["ps", "-q", service], `${service}-probe-id`)).stdout
          .toString()
          .trim()
        endpoints.push({
          name: service,
          address: (await inspect(id)).NetworkSettings.Networks[control].IPAddress,
          port,
        })
      }
      endpoints.push(
        {
          name: "host-gateway",
          address: network.subnet.replace(".0/24", ".1"),
          port: 8080,
        },
        {
          name: "host-published-port-DNAT",
          address: network.subnet.replace(".0/24", ".1"),
          port: Number(
            (await inspect(`${host.name}-reports`)).NetworkSettings.Ports["8081/tcp"][0]
              .HostPort
          ),
        },
        {
          name: "peer-workstation",
          address: (await inspect(peer)).NetworkSettings.Networks[
            config.WORKSTATION_NETWORK
          ].IPAddress,
          port: 8080,
        },
        ...["169.254.169.254", "100.100.100.200", "168.63.129.16", "93.184.216.9"].map(
          (address) => ({ name: address, address, port: 8080 })
        )
      )
      const results = []
      for (const endpoint of endpoints) {
        const positive = await innerDocker(host, [
          "run",
          "--rm",
          "--network",
          "host",
          "--entrypoint",
          "node",
          workerImage,
          "-e",
          probeCode(endpoint.address, endpoint.port),
        ])
        assert.equal(
          JSON.parse(positive.stdout.toString()).connected,
          true,
          `Endpoint must actually be reachable from trusted host: ${endpoint.name}`
        )
        const blocked = JSON.parse(
          (
            await innerDocker(host, [
              "exec",
              guest,
              "node",
              "-e",
              probeCode(endpoint.address, endpoint.port),
            ])
          ).stdout.toString()
        )
        assert.equal(blocked.connected, false, `Guest reached ${endpoint.name}`)
        results.push({ endpoint, blocked })
      }
      assert.equal(
        (
          await innerDocker(host, [
            "exec",
            guest,
            "curl",
            "-fsS",
            "http://93.184.216.8:8081/health",
          ])
        ).stdout.toString(),
        "ready"
      )
      const guestMeta = await inspect(guest)
      await writeFile(
        path.join(host.directory, "network-probes.json"),
        JSON.stringify(results, null, 2) + "\n"
      )
      checks.push({
        check:
          "Actual CUA guest: public report allowed; live DB/worker/Web/host/peer/metadata/control-alias endpoints blocked with positive host controls",
        detail: results,
      })
      const publicDns = JSON.parse(
        (
          await innerDocker(
            host,
            [
              "exec",
              guest,
              "node",
              "-e",
              "require('node:dns').resolve4('example.com',(e,a)=>{if(e)throw e;console.log(JSON.stringify(a))})",
            ],
            { timeoutMs: 30000 }
          )
        ).stdout.toString()
      )
      await writeFile(
        path.join(host.directory, "public-dns.json"),
        JSON.stringify(publicDns, null, 2) + "\n"
      )
      assert(publicDns.length > 0)
      assert(
        !publicDns.some((address: string) => /^198\.(18|19)\./.test(address)),
        "Public DNS returned benchmark/fake-IP addresses; use a direct-DNS Linux host without weakening the private-range policy"
      )
      const internet = await innerDocker(host, [
        "exec",
        guest,
        "curl",
        "-fsS",
        "--connect-timeout",
        "10",
        "--max-time",
        "20",
        "https://example.com/",
      ])
      assert(internet.stdout.includes("Example Domain"))
      assert.deepEqual(guestMeta.HostConfig.Dns, [config.PA_GUEST_DNS])
      assert(guestMeta.HostConfig.CapDrop.includes("CAP_NET_RAW"))
      assert.equal(guestMeta.HostConfig.Sysctls["net.ipv6.conf.all.disable_ipv6"], "1")
      assert.equal(Object.keys(guestMeta.HostConfig.PortBindings ?? {}).length, 0)
      assert(
        !guestMeta.Mounts.some(
          (mount: any) => mount.Destination === "/var/run/docker.sock"
        )
      )
      assert(
        !guestMeta.Config.Env.some((entry: string) =>
          /^(MASTER_KEY|DATABASE_URL|BETTER_AUTH_SECRET)=/.test(entry)
        )
      )
      const counters = await innerDocker(host, [
        "run",
        "--rm",
        "--network",
        "host",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "iptables-save",
        workerImage,
        "-c",
      ])
      await writeFile(
        path.join(host.directory, "iptables-with-counters.txt"),
        counters.stdout
      )
      await assert.rejects(
        guard("init"),
        (error: unknown) =>
          error instanceof DockerError && error.stderr.includes("Drain guest containers")
      )
      await innerDocker(host, [
        "run",
        "--rm",
        "--network",
        "host",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "iptables",
        workerImage,
        "-w",
        "5",
        "-D",
        `PA-${prefix}-OUT`,
        "1",
      ])
      await assert.rejects(
        guard("check"),
        (error: unknown) =>
          error instanceof DockerError &&
          error.stderr.includes("Guest forwarding rules differ")
      )
      await assert.rejects(
        workerCode(
          `import {ensureWorkstation} from './lib/workstation.ts';await ensureWorkstation(${JSON.stringify(agent.id)});`
        ),
        DockerError
      )
      await workerCode(
        "import {stopInstallationWorkstations} from './lib/workstation.ts';import {pool} from './db/index.ts';await stopInstallationWorkstations();await pool.end();"
      )
      await guard("init")
      await guard("check")
      checks.push({
        check:
          "Guard lifecycle: refuses live-policy replacement; tampered rules fail check and production provisioning; drain and explicit reinitialize restores policy",
      })
    }
  }
  assert.deepEqual(pageErrors, [])
  assert.equal(
    (
      await context.request.post(`${origin}/api/auth/sign-out`, { headers, data: {} })
    ).status(),
    200
  )
  assert.equal((await context.request.get(`${origin}/api/settings`)).status(), 401)
  passed = true
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({
      path: path.join(host.directory, "failure.png"),
      fullPage: true,
    })
  await writeFile(path.join(host.directory, "failure.txt"), String(error))
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await browser?.close()
  for (const name of fixtures) {
    const log = await innerDocker(host, ["logs", name])
    await writeFile(
      path.join(host.directory, `${name}.log`),
      log.stdout.toString() + log.stderr
    )
    await innerDocker(host, ["rm", "--force", name])
  }
  if (publicNetworkCreated)
    await innerDocker(host, ["network", "rm", `${host.name}-public-fixture`])
  if (config) {
    const logs = await innerDocker(
      host,
      [...composeArgs, "--project-name", `pa-${config.INSTALL_ID}`, "logs", "--no-color"],
      { env: config }
    )
    await writeFile(
      path.join(host.directory, "stack.log"),
      logs.stdout.toString() + logs.stderr
    )
    await compose(["down", "--timeout", "30"], "stack-down")
  }
  const evidence = {
    passed,
    directory: host.directory,
    checks,
    recordedAt: new Date().toISOString(),
    applicationVersion: APPLICATION_VERSION,
    scope: workflowCua
      ? "CUA workflow import/revalidation/ready reuse in guarded rootful Linux production containers"
      : basicCua
        ? "single-agent production-container controlled delivery"
        : "full private deployment",
    ...(basicCua || workflowCua
      ? {
          actualTasks: taskResults.length,
          completed: taskResults.filter((task) => task.status === "completed").length,
          cancelled: taskResults.filter((task) => task.status === "cancelled").length,
          taskResults,
          taskCountGate: workflowCua ? 4 : 2,
          ordinaryPublicDnsEvaluated: false,
          fullDeploymentPassed: false,
        }
      : {}),
    runtimeMetadata,
    controlledProvider: !workflowCua,
    ...(workflowCua ? { modelRequests: 0, independentWorkflowInstallation: true } : {}),
    realModelJudgmentEvaluated: false,
    actualCloudProviderEvaluated: false,
    fullRestoreEvaluated: false,
    hostKind:
      host.kind === "colima"
        ? "dedicated rootful Linux VM with its own kernel; isolated Colima profile"
        : "isolated rootful Linux Docker-in-Docker with mutual TLS",
    mainLocalDeploymentUnchanged: true,
  }
  const json = JSON.stringify(evidence, null, 2) + "\n"
  await writeFile(path.join(host.directory, "result.json"), json)
  if (workflowCua) {
    await writeFile("docs/evidence/workflow-production-attempt.json", json)
    if (passed) await writeFile("docs/evidence/workflow-production.json", json)
  } else if (basicCua) {
    await writeFile("docs/evidence/basic-cua-production-attempt.json", json)
    if (passed) await writeFile("docs/evidence/basic-cua-production.json", json)
  } else {
    await writeFile("docs/evidence/deployment-private-attempt.json", json)
    if (passed) await writeFile("docs/evidence/deployment-private.json", json)
  }
  console.log(json)
  await stopLinuxHost(host, passed && !basicCua && !workflowCua)
}
