import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { hashPassword } from "better-auth/crypto"
import { chromium, request } from "playwright"

// Owner-authorized real-model check. Review the generated draft between stages.
// Resume reuses the original tasks; unresolved attempts never receive automatic consent.
assert(
  (process.argv[2] === "--real" && process.argv.length === 3) ||
    (process.argv[2] === "--reviewed-resume" && process.argv.length === 4),
  "Use --real; inspect the saved draft, then --reviewed-resume DIRECTORY"
)
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const mainUrl = process.env.DATABASE_URL!
const main = new pg.Client({ connectionString: mainUrl })
await main.connect()
const counts = async (client: pg.Client) =>
  (
    await client.query(`SELECT
 (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM task_model_attempts) AS attempts,
 (SELECT count(*)::int FROM task_actions) AS actions,(SELECT count(*)::int FROM artifacts) AS artifacts,
 (SELECT count(*)::int FROM tasks WHERE status IN ('queued','running')) AS active`)
  ).rows[0]
const before = await counts(main)
const directory =
  process.argv[2] === "--real"
    ? path.resolve("data/experiments", `manual-live-${Date.now()}`)
    : path.resolve(process.argv[3])
await mkdir(directory, { recursive: true, mode: 0o700 })
const admission = path.join(directory, "admission.json")
type Setup = {
  database: string
  installId: string
  sourceId: string
  agentId: string
  ownerId: string
  compilationKey: string
  reuseKey: string
  compilationId?: string
  reuseId?: string
  previousReuseIds?: string[]
  targetDirectory: string
  webRoot: string
  model: string
}
let setup: Setup
const resume = process.argv[2] === "--reviewed-resume"
if (resume) setup = JSON.parse(await readFile(admission, "utf8"))
else {
  const previous = JSON.parse(await readFile("docs/evidence/manuals.json", "utf8"))
  const source = previous.inheritedSource
  assert(/^agent_manual_[a-f0-9]+$/.test(source.database))
  const database = `agent_manual_live_${randomUUID().replaceAll("-", "")}`
  await main.query(`CREATE DATABASE "${database}" TEMPLATE "${source.database}"`)
  setup = {
    database,
    installId: randomUUID(),
    sourceId: source.taskId,
    agentId: "",
    ownerId: "",
    compilationKey: randomUUID(),
    reuseKey: randomUUID(),
    targetDirectory: "/tmp",
    webRoot: path.join(previous.directory, "web-source"),
    model: "openai/gpt-6.1-sol",
  }
  await writeFile(admission, JSON.stringify(setup, null, 2))
}
assert(/^agent_manual_live_[a-f0-9]+$/.test(setup.database))
const url = new URL(mainUrl)
url.pathname = `/${setup.database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: setup.installId,
  APP_URL: "http://127.0.0.1:17247",
  WORKER_PORT: "17248",
  WORKER_HOST: "127.0.0.1",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.3",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const { pool } = await import("@/db")
const jobs: { child: ChildProcess; done: Promise<number | null> }[] = []
function start(args: string[], name: string, cwd = process.cwd()) {
  const child = spawn(process.execPath, args, { env: process.env, cwd, detached: true })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}-${Date.now()}.log`), output)
    return child.exitCode
  })
  const job = { child, done }
  jobs.push(job)
  return job
}
async function waitTask(id: string) {
  const end = Date.now() + 600000
  let lastStatus = ""
  while (Date.now() < end) {
    const row = (await pool.query("SELECT status,result FROM tasks WHERE id=$1", [id]))
      .rows[0]
    if (row.status !== lastStatus) {
      console.log(JSON.stringify({ taskId: id, status: row.status }))
      lastStatus = row.status
    }
    if (
      [
        "completed",
        "needs_review",
        "waiting_user",
        "waiting_human",
        "failed",
        "cancelled",
      ].includes(row.status)
    )
      return row
    await delay(300)
  }
  throw new Error(
    `Task ${id} exceeded live-check wait; preserve it for original-chain review`
  )
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let api: Awaited<ReturnType<typeof request.newContext>> | undefined
let result: Record<string, unknown> = {},
  failure: string | undefined
try {
  if (!resume) {
    await pool.query("DELETE FROM session")
    await pool.query("DELETE FROM workstation_control")
    await pool.query("UPDATE agents SET workstation_id=NULL")
    await pool.query(
      "DELETE FROM settings WHERE key LIKE 'provider.%' OR key LIKE 'manual.%'"
    )
    const settings = (
      await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
        ["provider.openai.apiKey", "provider.openai.baseUrl", "pricing.custom"],
      ])
    ).rows
    assert(settings.some((s) => s.key === "provider.openai.apiKey"))
    for (const item of settings)
      await pool.query(
        "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
        [item.key, item.value]
      )
    await pool.query(
      "INSERT INTO settings(key,value,updated_at) VALUES('model.default',$1,now()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()",
      [setup.model]
    )
    const source = (
      await pool.query("SELECT agent_id,owner_id,status FROM tasks WHERE id=$1", [
        setup.sourceId,
      ])
    ).rows[0]
    assert.equal(source.status, "completed")
    setup.agentId = source.agent_id
    setup.ownerId = source.owner_id
    await writeFile(admission, JSON.stringify(setup, null, 2))
  }
  // A failed/unknown original attempt can only resume through the owner review chain.
  for (const id of [setup.compilationId, setup.reuseId].filter(Boolean)) {
    const pending = (await pool.query("SELECT status FROM tasks WHERE id=$1", [id]))
      .rows[0]
    assert(
      !["needs_review", "failed", "cancelled"].includes(pending.status),
      `Original task ${id} requires review; no new request authorized here`
    )
  }
  start(["--import", "tsx", "worker/main.ts"], "worker")
  const { submitTask } = await import("@/lib/tasks")
  if (!setup.compilationId) {
    const accepted = await submitTask(setup.ownerId, "manual-live-compile", {
      agentId: setup.agentId,
      clientRequestId: setup.compilationKey,
      goal: "把已完成的文件管理器导航操作提炼为中文操作手册草稿。",
      manualCompilation: {
        sourceTaskId: setup.sourceId,
        name: "文件夹导航与位置核对",
        purpose:
          "使用 Thunar 图形文件管理器访问输入参数 directory 指定的目录，核对地址栏或当前窗口。仅浏览目录，不创建、修改或删除文件。",
        parameters: [
          { name: "directory", label: "要访问的目录", sourceValue: "/home/agent" },
        ],
        reviewed: true,
      },
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 3 },
    })
    setup.compilationId = accepted.taskId
    await writeFile(admission, JSON.stringify(setup, null, 2))
  }
  const compiled = await waitTask(setup.compilationId)
  result = { stage: "compile", status: compiled.status }
  if (compiled.status !== "completed") {
    const requests = (
      await pool.query(
        "SELECT kind,payload FROM task_requests WHERE task_id=$1 AND status='pending'",
        [setup.compilationId]
      )
    ).rows
    result.requests = requests
  } else {
    const draft = compiled.result.manualDraft
    await writeFile(path.join(directory, "draft.json"), JSON.stringify(draft, null, 2))
    assert(draft.name && draft.description && draft.body)
    if (!resume)
      result = {
        stage: "review_draft",
        status: "awaiting-test-review",
        draft: path.join(directory, "draft.json"),
      }
    else {
      const password = randomUUID()
      await pool.query(
        'UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"=\'credential\'',
        [await hashPassword(password), setup.ownerId]
      )
      const email = (
        await pool.query('SELECT email FROM "user" WHERE id=$1', [setup.ownerId])
      ).rows[0].email
      const base = process.env.APP_URL!
      start(
        [
          path.resolve("node_modules/next/dist/bin/next"),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17247",
        ],
        "web",
        setup.webRoot
      )
      const deadline = Date.now() + 30000
      while (true) {
        try {
          if ((await fetch(`${base}/login`)).ok) break
        } catch (error) {
          if ((error as Error).message !== "fetch failed") throw error
        }
        assert(Date.now() < deadline, "Isolated web failed to start")
        await delay(250)
      }
      api = await request.newContext({
        baseURL: base,
        extraHTTPHeaders: { Origin: base },
      })
      const signedIn = await api.post("/api/auth/sign-in/email", {
        data: { email, password },
      })
      assert.equal(signedIn.status(), 200)
      browser = await chromium.launch({
        headless: true,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      })
      const page = await browser.newPage({
        storageState: await api.storageState(),
        viewport: { width: 1440, height: 1100 },
      })
      const uiErrors: string[] = []
      page.on("pageerror", (error) => uiErrors.push(error.message))
      await page.goto(`${base}/manuals`)
      const current = await (await api.get("/api/manuals")).json()
      if (!current.some((manual: any) => manual.id === setup.compilationId)) {
        await page.getByLabel("操作步骤与结果检查").waitFor()
        assert.equal(await page.getByLabel("操作步骤与结果检查").inputValue(), draft.body)
        await page.getByRole("checkbox").check()
        await page.getByRole("button", { name: "保存并启用手册", exact: true }).click()
        await page.getByText("可按需参考", { exact: true }).waitFor()
      }
      await page.screenshot({
        path: path.join(directory, "live-manual-web.png"),
        fullPage: true,
      })
      assert.deepEqual(uiErrors, [])
      if (!setup.reuseId) {
        const response = await api.post("/api/tasks", {
          data: {
            agentId: setup.agentId,
            clientRequestId: setup.reuseKey,
            workstationChannel: "desktop",
            goal: `请使用 Thunar 图形文件管理器打开 ${setup.targetDirectory}，核对当前位置并保持这个目录可见。仅浏览，不创建、修改或删除文件。适用时参考已保存的操作手册。请完全通过桌面界面完成。`,
            budget: { maxSteps: 15 },
          },
        })
        assert([200, 202].includes(response.status()), await response.text())
        setup.reuseId = (await response.json()).taskId
        await writeFile(admission, JSON.stringify(setup, null, 2))
      }
      const task = await waitTask(setup.reuseId!)
      const events = (
        await pool.query(
          "SELECT type,payload FROM task_events WHERE task_id=$1 AND type='manual_loaded'",
          [setup.reuseId]
        )
      ).rows
      const actions = (
        await pool.query(
          "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
          [setup.reuseId]
        )
      ).rows
      await writeFile(
        path.join(directory, "reuse-actions.json"),
        JSON.stringify(actions, null, 2)
      )
      const lastImage = actions.findLast((action) => action.receipt?.output?.image)
        ?.receipt.output
      if (lastImage)
        await writeFile(
          path.join(directory, "live-desktop.jpg"),
          Buffer.from(lastImage.image, "base64")
        )
      const { docker } = await import("@/lib/docker")
      const workstation = (
        await pool.query(
          "SELECT container_name FROM workstation_control WHERE agent_id=$1",
          [setup.agentId]
        )
      ).rows[0]
      let window = ""
      if (task.status === "completed") {
        window = (
          await docker([
            "exec",
            workstation.container_name,
            "xdotool",
            "getactivewindow",
            "getwindowname",
          ])
        ).stdout
          .toString()
          .trim()
      }
      const checks = {
        completed: task.status === "completed",
        discoveredManual: events.some((e) => e.payload.id === setup.compilationId),
        actionsSucceeded:
          actions.length > 0 && actions.every((a) => a.status === "succeeded"),
        noShellOrBrowser: actions.every(
          (a) => !["shell", "fs_write", "browser_open"].includes(a.kind)
        ),
        targetWindow: window === `${path.posix.basename(setup.targetDirectory)} - Thunar`,
      }
      result = {
        stage: "reuse",
        status: task.status,
        passed: Object.values(checks).every(Boolean),
        checks,
        window,
        events,
        actionCount: actions.length,
        summary: task.result?.summary,
      }
      if (!result.passed) process.exitCode = 1
      if (task.status !== "completed")
        result.requests = (
          await pool.query(
            "SELECT kind,payload FROM task_requests WHERE task_id=$1 AND status='pending'",
            [setup.reuseId]
          )
        ).rows
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  await browser?.close()
  await api?.dispose()
  for (const job of jobs.filter(
    (j) => j.child.exitCode === null && j.child.signalCode === null
  ))
    job.child.kill("SIGTERM")
  await Promise.race([Promise.all(jobs.map((j) => j.done)), delay(15000)])
  for (const job of jobs.filter(
    (j) => j.child.exitCode === null && j.child.signalCode === null
  ))
    process.kill(-job.child.pid!, "SIGKILL")
  const { stopInstallationWorkstations } = await import("@/lib/workstation")
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const attempts = (
    await pool.query(
      "SELECT task_id,decision_no,attempt_no,status,cost_micros,error,usage FROM task_model_attempts WHERE task_id=ANY($1::text[]) ORDER BY id",
      [
        [setup.compilationId, ...(setup.previousReuseIds ?? []), setup.reuseId].filter(
          Boolean
        ),
      ]
    )
  ).rows
  const after = await counts(main)
  assert.deepEqual(after, before)
  assert(originalEnv.equals(await readFile(".env")))
  const report = {
    recordedAt: new Date().toISOString(),
    ...setup,
    result,
    failure,
    attempts,
    mainBefore: before,
    mainAfter: after,
    mainConfigUnchanged: true,
    mainRestarted: false,
  }
  const reportPath = path.join(directory, `result-${Date.now()}.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await writeFile("docs/evidence/manuals-live.json", JSON.stringify(report, null, 2))
  await pool.end()
  await main.end()
  console.log(
    JSON.stringify({ directory, result, attempts: attempts.length, failure, reportPath })
  )
}
