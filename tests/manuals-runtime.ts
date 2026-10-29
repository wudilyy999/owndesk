import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { chromium, request } from "playwright"
import { hashPassword } from "better-auth/crypto"

// Isolated real desktop + production runtime + owner UI, with local fixed responses.
// Generated test credentials remain in memory. Never call a cloud model or mutate main.
process.loadEnvFile(".env")
const database = `agent_manual_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
const inherited = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], "utf8"))
  : undefined
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
const mainBefore = (
  await admin.query(`SELECT (SELECT count(*)::int FROM tasks) AS tasks,
 (SELECT count(*)::int FROM task_model_attempts) AS attempts,(SELECT count(*)::int FROM task_actions) AS actions,
 (SELECT count(*)::int FROM artifacts) AS artifacts`)
).rows[0]
if (inherited)
  assert(
    /^agent_manual_[a-f0-9]+$/.test(inherited.database) &&
      inherited.sourceId &&
      inherited.checks.length
  )
await admin.query(
  `CREATE DATABASE "${database}"${inherited ? ` TEMPLATE "${inherited.database}"` : ""}`
)
await admin.end()
const databaseUrl = new URL(process.env.DATABASE_URL!)
databaseUrl.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(),
  INSTALL_ID: randomUUID(),
  MASTER_KEY: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomUUID(),
  APP_URL: "http://127.0.0.1:17237",
  WORKER_PORT: "17238",
  WORKER_HOST: "127.0.0.1",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.3",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "manual-test@example.test",
  OWNER_PASSWORD: randomUUID(),
})
const jobs: { child: ChildProcess; done: Promise<number | null> }[] = []
function start(args: string[], name: string, cwd = process.cwd()) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, detached: true })
  let output = ""
  child.stdout!.on("data", (part) => {
    output += part
  })
  child.stderr!.on("data", (part) => {
    output += part
  })
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), output)
    return child.exitCode
  })
  const job = { child, done }
  jobs.push(job)
  return job
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const end = Date.now() + 180000
  while (Date.now() < end) {
    const result = await read()
    if (result !== undefined) return result
    await delay(150)
  }
  throw new Error(`Timed out: ${label}`)
}
const marker = `owner-edited-manual-${randomUUID()}`
const goal = "打开文件管理器，访问指定目录，并核对当前窗口"
const draftBody =
  "# 适用场景\n打开 Thunar 并访问输入的目录。\n# 输入参数\n目录：{{directory}}\n# 操作步骤\n1. 打开文件管理器并观察当前屏幕。\n2. 聚焦地址栏，输入本次目录并回车。\n3. 从新的截图核对当前位置。\n# 结果检查\n目录与本次目标一致；不沿用旧坐标或授权。"
const generatedDraft = { name: "访问文件目录", description: goal, body: draftBody }
const steps: Record<string, number> = { source: 0, compile: 0, reuse: 0 }
const errors: string[] = [],
  checks: string[] = []
const observations: { arm: string; inputId?: string; nextId?: string }[] = []
let sourceId: string | undefined,
  compileId: string | undefined,
  reuseId: string | undefined
let manualId: string | undefined, ownerId: string | undefined
let passed = false,
  failure: string | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let api: Awaited<ReturnType<typeof request.newContext>> | undefined
const model = createServer((req, res) => {
  void (async () => {
    assert.equal(req.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const toolNames = body.tools.map((tool: any) => tool.function.name)
    const system = body.messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content)
      .join("\n")
    const arm = toolNames.includes("submit_manual")
      ? "compile"
      : manualId && system.includes(manualId)
        ? "reuse"
        : "source"
    const step = steps[arm]++
    const previous = body.messages.filter((m: any) => m.role === "tool").at(-1)
    const decoded = previous ? JSON.parse(previous.content) : undefined
    const output = Array.isArray(decoded)
      ? JSON.parse(
          decoded.find((part: any) => part.type === "text" && part.text.startsWith("{"))
            .text
        )
      : decoded
    let tool: string, args: Record<string, unknown>
    if (arm === "compile") {
      assert.deepEqual(toolNames, ["submit_manual"])
      assert(!system.includes("private-source-goal") && !system.includes("sourceValue"))
      assert(system.includes('"parameter":"directory"'))
      assert.equal(step, 0)
      tool = "submit_manual"
      args = generatedDraft
    } else if (arm === "reuse" && step === 0) {
      assert(!system.includes(marker), "catalog must not eagerly load the body")
      tool = "load_manual"
      args = { id: manualId }
      const { setManualEnabled } = await import("@/lib/manuals")
      await setManualEnabled(ownerId!, manualId!, false)
    } else if (arm === "reuse" && step === 1) {
      assert(system.includes(marker), "loaded manual must be pinned in system context")
      assert.equal(output.referenceOnly, true)
      tool = "ask_user"
      args = { question: "确认继续访问主目录，以验证 worker 恢复。" }
    } else {
      const desktopStep = arm === "reuse" ? step - 2 : step
      if (arm === "reuse")
        assert(system.includes(marker), "manual must survive process recovery")
      if (desktopStep === 0) {
        tool = "desktop_open_application"
        args = { application: "Thunar" }
      } else if (desktopStep === 1 || desktopStep === 3) {
        assert(output.observationId)
        tool = "key_press"
        args = {
          observationId: output.observationId,
          key: desktopStep === 1 ? "l" : "enter",
          modifiers: desktopStep === 1 ? ["ctrl"] : [],
        }
      } else if (desktopStep === 2) {
        tool = "key_type"
        args = { observationId: output.observationId, text: "/home/agent" }
      } else {
        assert.equal(desktopStep, 4)
        assert.match(output.window.wmClass, /Thunar/)
        tool = "complete_task"
        args = { summary: "已通过当前桌面访问主目录并核对新画面。", files: [] }
      }
      observations.push({
        arm,
        inputId: typeof args.observationId === "string" ? args.observationId : undefined,
        nextId: output?.observationId,
      })
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `manual-${arm}-${step}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "manual-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `manual-call-${arm}-${step}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      })
    )
  })().catch((error) => {
    errors.push(String(error))
    res.writeHead(500).end(JSON.stringify({ error: String(error) }))
  })
})
model.listen(0, "127.0.0.1")
await once(model, "listening")
try {
  assert.equal(await start(["--import", "tsx", "scripts/migrate.ts"], "migrate").done, 0)
  const { pool } = await import("@/db")
  if (inherited) {
    // Continue the UI tail from a successful source without rerunning its GUI actions.
    // The original installation, source receipts and stopped home remain unchanged.
    await pool.query("DELETE FROM session")
    await pool.query("DELETE FROM workstation_control")
    await pool.query("UPDATE agents SET workstation_id=NULL")
    await pool.query("UPDATE account SET password=$1 WHERE \"providerId\"='credential'", [
      await hashPassword(process.env.OWNER_PASSWORD!),
    ])
  } else
    assert.equal(await start(["--import", "tsx", "scripts/owner.ts"], "owner").done, 0)
  const { setSetting } = await import("@/lib/config")
  await setSetting("provider.custom.apiKey", "local-fixed-responses-no-cloud")
  await setSetting(
    "provider.custom.baseUrl",
    `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`
  )
  await setSetting("model.default", "custom/manual-fixture")
  const { submitTask } = await import("@/lib/tasks")
  const agentId = (await pool.query("SELECT id FROM agents WHERE model IS NULL LIMIT 1"))
    .rows[0].id
  ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  let worker = start(["--import", "tsx", "worker/main.ts"], "worker-1")
  const waitTask = async (id: string) =>
    until(async () => {
      const row = (
        await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])
      ).rows[0]
      if (["failed", "needs_review"].includes(row.status))
        throw new Error(JSON.stringify(row))
      return row.status === "completed" ? row : undefined
    }, `task completion ${id}`)
  sourceId = inherited
    ? inherited.sourceId
    : (
        await submitTask(ownerId!, "manual-runtime-source", {
          agentId,
          goal: "private-source-goal: open file manager and visit home",
          clientRequestId: randomUUID(),
          workstationChannel: "desktop",
          completionContract: { requireHumanReview: false },
          budget: { maxSteps: 40 },
        })
      ).taskId
  assert(sourceId)
  await waitTask(sourceId)
  checks.push(
    "Real source Task: Thunar launch and three fresh-observation keyboard actions; completed without cloud requests"
  )

  // Separate Next checkout/output keeps the existing main .next and services untouched.
  const webRoot = path.join(directory, "web-source")
  await mkdir(webRoot)
  for (const name of [
    "app",
    "components",
    "lib",
    "db",
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "next-env.d.ts",
    "postcss.config.mjs",
  ])
    await cp(path.resolve(name), path.join(webRoot, name), { recursive: true })
  await symlink(path.resolve("node_modules"), path.join(webRoot, "node_modules"), "dir")
  start(
    [
      path.resolve("node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      "17237",
    ],
    "web",
    webRoot
  )
  const base = process.env.APP_URL!
  await until(async () => {
    try {
      return (await fetch(`${base}/login`)).ok ? true : undefined
    } catch (error) {
      if ((error as Error).message === "fetch failed") return undefined
      throw error
    }
  }, "isolated web readiness")
  api = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } })
  assert.equal((await api.get("/api/manuals")).status(), 401)
  const login = await api.post("/api/auth/sign-in/email", {
    data: { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD },
  })
  assert.equal(login.status(), 200, await login.text())
  assert.equal(
    (
      await api.patch("/api/manuals", {
        headers: { Origin: "https://foreign.test" },
        data: {},
      })
    ).status(),
    403
  )
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.UI_BROWSER_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })
  const context = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1440, height: 1100 },
  })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/manuals?source=${sourceId}`)
  await page.getByLabel("手册名称", { exact: true }).fill("访问文件目录")
  await page.getByLabel("要保留的做法").fill(goal)
  await page.getByRole("button", { name: "添加输入", exact: true }).click()
  await page.getByLabel("1 name", { exact: true }).fill("directory")
  await page.getByLabel("1 label", { exact: true }).fill("目录")
  await page.getByLabel("1 sourceValue", { exact: true }).fill("/home/agent")
  await page.getByRole("button", { name: "预览生成依据", exact: true }).click()
  await page.getByText("将发送给模型的依据", { exact: true }).waitFor()
  assert.equal(steps.compile, 0)
  await page.getByLabel("我已审阅上述内容，允许请求模型生成草稿。").check()
  await page.getByRole("button", { name: "生成手册草稿", exact: true }).click()
  await page.waitForURL(/\?task=/)
  compileId = new URL(page.url()).searchParams.get("task")!
  const compiled = await waitTask(compileId)
  assert.deepEqual(compiled.result.manualDraft, generatedDraft)
  assert.equal((await api.get("/api/manuals")).status(), 200)
  assert.deepEqual(await (await api.get("/api/manuals")).json(), [])
  assert.equal(
    (
      await api.post("/api/manuals", {
        data: { draftTaskId: compileId, reviewed: false, draft: generatedDraft },
      })
    ).status(),
    400
  )
  await page.goto(`${base}/manuals`)
  await page.getByLabel("操作步骤与结果检查").fill(`${draftBody}\n\n${marker}`)
  await page
    .getByLabel(
      "我已审阅并移除秘密和过期坐标，允许 Agent 在相关新任务中按需参考。原任务成功不代表手册已验证。"
    )
    .check()
  await page.getByRole("button", { name: "保存并启用手册", exact: true }).click()
  await page.getByText("可按需参考", { exact: true }).waitFor()
  const saved = await (await api.get("/api/manuals")).json()
  assert.equal(saved.length, 1)
  manualId = saved[0].id
  assert(saved[0].body.includes(marker))
  const duplicate = await api.post("/api/manuals", {
    data: {
      draftTaskId: compileId,
      reviewed: true,
      draft: { ...generatedDraft, body: saved[0].body },
    },
  })
  assert.equal(duplicate.status(), 200)
  assert.equal(
    (
      await api.post("/api/manuals", {
        data: { draftTaskId: compileId, reviewed: true, draft: generatedDraft },
      })
    ).status(),
    409
  )
  assert.equal(
    (
      await api.post("/api/tasks", {
        data: {
          agentId,
          goal: "invalid manual selection",
          manualId: sourceId,
          clientRequestId: randomUUID(),
        },
      })
    ).status(),
    409
  )
  checks.push(
    "Actual owner UI: preview before any model call, generate one draft, edit, review, save; anonymous/cross-origin/unreviewed requests rejected and save is idempotent"
  )
  const downloading = page.waitForEvent("download")
  await page.getByRole("button", { name: "下载 SKILL.md", exact: true }).click()
  const downloaded = await downloading
  const exported = await readFile((await downloaded.path())!, "utf8")
  assert(
    exported.includes(marker) &&
      !exported.includes(sourceId) &&
      !exported.includes(manualId!)
  )
  await page.screenshot({
    path: path.join(directory, "manual-library.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )
  await page.screenshot({
    path: path.join(directory, "manual-library-mobile.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByText("用这份手册开始新任务", { exact: true }).click()
  await page
    .getByLabel("本次目标和输入")
    .fill("按已选手册访问 /home/agent，核对当前文件管理器。")
  await page.getByRole("button", { name: "开始新任务", exact: true }).click()
  await page.waitForURL(/\?task=/)
  reuseId = new URL(page.url()).searchParams.get("task")!
  const pending = await until(
    async () =>
      (
        await pool.query(
          "SELECT id,payload_version FROM task_requests WHERE task_id=$1 AND status='pending' AND payload->>'purpose'='question'",
          [reuseId]
        )
      ).rows[0],
    "manual replay checkpoint"
  )
  worker.child.kill("SIGTERM")
  assert.equal(await worker.done, 0)
  worker = start(["--import", "tsx", "worker/main.ts"], "worker-2")
  const answered = await api.post(`/api/task-requests/${pending.id}/respond`, {
    data: {
      decision: "approve",
      response: { note: "继续" },
      payloadVersion: pending.payload_version,
    },
  })
  assert.equal(answered.status(), 202, await answered.text())
  await waitTask(reuseId!)
  const { manualSnapshot } = await import("@/lib/manuals")
  assert.deepEqual(await manualSnapshot(ownerId!), [])
  assert.equal(
    (
      await api.post("/api/tasks", {
        data: {
          agentId,
          goal: "disabled manual",
          manualId,
          clientRequestId: randomUUID(),
        },
      })
    ).status(),
    409
  )
  const events = (
    await pool.query(
      "SELECT payload FROM task_events WHERE task_id=$1 AND type='manual_loaded'",
      [reuseId]
    )
  ).rows
  assert.equal(events.length, 1)
  const actions = (
    await pool.query(
      "SELECT task_id,kind,status,input,receipt FROM task_actions WHERE task_id=ANY($1::text[]) ORDER BY task_id,action_no",
      [[sourceId, compileId, reuseId]]
    )
  ).rows
  assert.equal(actions.filter((a) => a.task_id === compileId).length, 0)
  assert.equal(actions.filter((a) => a.task_id === sourceId).length, 4)
  assert(actions.filter((a) => a.task_id === reuseId).length >= 4)
  assert(actions.every((a) => a.status === "succeeded"))
  const sourceObservations = new Set(
    actions
      .filter((a) => a.task_id === sourceId)
      .map((a) => a.receipt.output.observationId)
  )
  assert(
    actions
      .filter((a) => a.task_id === reuseId && a.input.observationId)
      .every((a) => !sourceObservations.has(a.input.observationId))
  )
  checks.push(
    "New Task discovers/loads the saved edited manual, preserves it across a real worker restart, uses new screenshot IDs; disable affects future admission only and one durable load event survives replay"
  )
  assert.deepEqual(errors, [])
  passed = true
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { sourceId, compileId, reuseId, steps, checks, actions, observations },
      null,
      2
    )
  )
} catch (error) {
  failure = (error as Error).stack
  throw error
} finally {
  await browser?.close()
  await api?.dispose()
  for (const job of jobs.filter(
    (j) => j.child.exitCode === null && j.child.signalCode === null
  ))
    job.child.kill("SIGTERM")
  await Promise.race([Promise.all(jobs.map((job) => job.done)), delay(15000)])
  for (const job of jobs.filter(
    (j) => j.child.exitCode === null && j.child.signalCode === null
  ))
    process.kill(-job.child.pid!, "SIGKILL")
  await new Promise<void>((resolve) => model.close(() => resolve()))
  const { stopInstallationWorkstations } = await import("@/lib/workstation")
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const { pool } = await import("@/db")
  await pool.end()
  const report = {
    passed,
    database,
    directory,
    sourceId,
    compileId,
    reuseId,
    steps,
    checks,
    cloudModelRequests: 0,
    errors,
    failure,
    mainBefore,
    inheritedSource: inherited
      ? {
          database: inherited.database,
          taskId: inherited.sourceId,
          report: process.argv[2],
        }
      : undefined,
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2))
  await writeFile("docs/evidence/manuals.json", JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed, directory, steps, checks, failure }))
}
