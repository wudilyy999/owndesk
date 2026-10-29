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

process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_flowui_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${core.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17157",
  WORKER_PORT: "17158",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
let passed = false
let taskId: string | undefined
const checks: Record<string, unknown>[] = []
function start(args: string[], name: string) {
  const child = spawn(process.execPath, args, { env: process.env, detached: true })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  const job = {
    child,
    output: () => output,
    done: once(child, "exit").then(async () => {
      await writeFile(path.join(directory, `${name}.log`), output)
    }),
  }
  jobs.push(job)
  return job
}
async function until<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${message}`)
}
try {
  const { pool } = await import("@/db")
  try {
    const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    const email = (await pool.query('SELECT email FROM "user" WHERE id=$1', [owner]))
      .rows[0].email
    const password = randomUUID()
    await pool.query(
      'UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"=\'credential\'',
      [await hashPassword(password), owner]
    )
    await pool.query("DELETE FROM session")
    const agent = randomUUID()
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Web Workflow Desktop','Actual Web-submitted native workflow','',NULL,$2,now(),now())",
      [agent, randomUUID()]
    )
    const versionId = core.results[0].input.workflowExecution.versionId
    const rootName = `PA-C2-Web-${Date.now()}`
    const worker = start(["--import", "tsx", "worker/main.ts"], "worker")
    const web = start(
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        "17157",
      ],
      "web"
    )
    await until(async () => {
      assert.equal(worker.child.exitCode, null, worker.output())
      assert.equal(web.child.exitCode, null, web.output())
      return worker.output().includes("Worker ready") && web.output().includes("Ready")
        ? true
        : null
    }, "isolated worker and web ready")
    const api = await request.newContext({ baseURL: process.env.APP_URL })
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.UI_BROWSER_PATH,
    })
    try {
      assert.equal((await api.get("/api/workflows")).status(), 401)
      assert.equal(
        (
          await api.post("/api/auth/sign-in/email", {
            headers: { Origin: process.env.APP_URL! },
            data: { email, password },
          })
        ).status(),
        200
      )
      const context = await browser.newContext({
        storageState: await api.storageState(),
        viewport: { width: 1280, height: 960 },
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${process.env.APP_URL}/workflows`)
      await page.getByRole("button", { name: "执行流程", exact: true }).waitFor()
      const form = page.getByRole("form", { name: "运行已验证流程", exact: true })
      await form.getByLabel("执行工作站", { exact: true }).selectOption(agent)
      await form.getByLabel("父目录名（parentName）", { exact: true }).fill(rootName)
      await form.getByLabel("初始目录名（draftName）", { exact: true }).fill("Web-Draft")
      await form.getByLabel("最终目录名（readyName）", { exact: true }).fill("Web-Ready")
      await page.screenshot({
        path: path.join(directory, "workflow-run-desktop.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: path.join(directory, "workflow-run-mobile.png"),
        fullPage: true,
      })
      await page.waitForLoadState("networkidle")
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        ),
        false
      )
      const posted: Record<string, any>[] = []
      await page.route("**/api/tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue()
        posted.push(route.request().postDataJSON())
        if (posted.length === 1) return route.abort("failed")
        return route.continue()
      })
      await form.getByRole("button", { name: "执行流程", exact: true }).click()
      await form.getByRole("alert").waitFor()
      await page.reload()
      await until(
        async () =>
          (await form
            .getByLabel("父目录名（parentName）", { exact: true })
            .inputValue()) === rootName
            ? true
            : null,
        "restored pending workflow parameters"
      )
      assert.equal(
        await form.getByLabel("执行工作站", { exact: true }).inputValue(),
        agent
      )
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/tasks") && response.request().method() === "POST"
      )
      await form.getByRole("button", { name: "执行流程", exact: true }).click()
      const accepted = await response
      assert.equal(accepted.status(), 202)
      taskId = (await accepted.json()).taskId
      await page.waitForURL(`**/?task=${taskId}`)
      assert.equal(posted.length, 2)
      assert.equal(posted[0].clientRequestId, posted[1].clientRequestId)
      assert.deepEqual(posted[0].workflowExecution, posted[1].workflowExecution)
      checks.push({
        check:
          "ready-version form, desktop/390px layout, pending parameters and request key survive response loss/reload; second POST truly accepted",
        taskId,
        passed: true,
      })
      const state = await until(async () => {
        const row = (
          await pool.query(
            "SELECT status,result,error,completion_contract FROM tasks WHERE id=$1",
            [taskId]
          )
        ).rows[0]
        return ["completed", "needs_review", "failed"].includes(row.status) ? row : null
      }, "actual Web workflow completion")
      await page.getByRole("article", { name: "交付结果", exact: true }).waitFor()
      assert.equal(
        await page.getByRole("article", { name: "交付结果", exact: true }).innerText(),
        `流程已执行并通过固定目录检查：/home/agent/${rootName}`
      )
      await page.screenshot({
        path: path.join(directory, "workflow-completed-mobile.png"),
        fullPage: true,
      })
      assert.equal(state.status, "completed", JSON.stringify(state))
      assert.equal(state.result.directoryTree.grade, "program_checked")
      assert.equal(
        state.completion_contract.directoryTree.root,
        `/home/agent/${rootName}`
      )
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=$1",
            [taskId]
          )
        ).rows[0].count,
        0
      )
      const detail = await (await api.get(`/api/tasks/${taskId}`)).json()
      assert.equal(detail.workflowRun.versionId, versionId)
      assert.equal(detail.workflowRun.step, detail.workflowRun.totalSteps)
      assert.deepEqual(errors, [])
      checks.push({
        check:
          "real Web-admitted task performed GUI actions, fixed version/contract result passed, zero model calls and completed step progress visible",
        taskId,
        passed: true,
      })
      await context.close()
      passed = true
    } finally {
      await browser.close()
      await api.dispose()
    }
  } finally {
    for (const job of jobs)
      if (job.child.pid && job.child.exitCode === null)
        process.kill(-job.child.pid, "SIGTERM")
    await Promise.all(jobs.map((job) => job.done))
    await pool.end()
  }
} finally {
  const evidence = {
    passed,
    scope:
      "C2 owner Web ready-version execution and actual native GUI task; no cloud compilation or overall product comparison",
    database,
    directory,
    taskId,
    checks,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-execution-ui.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, taskId }))
