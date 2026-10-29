import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { hashPassword } from "better-auth/crypto"
import { chromium, request } from "playwright"

// Owner UI/admission only: no worker, desktops or cloud requests are started.
process.loadEnvFile(".env")
const repair = JSON.parse(await readFile("docs/evidence/workflow-repair.json", "utf8"))
assert(repair.passed && /^agent_flowrepair_[a-f0-9]+$/.test(repair.database))
const database = `agent_repairui_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${repair.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17177",
})
const { pool } = await import("@/db")
const { closeDurableClient } = await import("@/lib/durable")
let passed = false
const checks: string[] = []
let output = ""
let submittedTaskId: string | undefined
const web = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    "17177",
  ],
  { env: process.env, detached: true }
)
web.stdout!.on("data", (chunk) => {
  output += chunk
})
web.stderr!.on("data", (chunk) => {
  output += chunk
})
const webDone = once(web, "exit").then(async () => {
  await writeFile(path.join(directory, "web.log"), output)
})
async function until<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    assert.equal(web.exitCode, null, output)
    const value = await read()
    if (value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${message}`)
}
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
  const success = repair.results[0]
  const draftId = success.run.checkpoint.repair.draftVersionId
  // Restore draft presentation in this isolated clone only; the source already
  // has one independent sample, which remains insufficient for certification.
  await pool.query("UPDATE workflow_versions SET status='draft' WHERE id=$1", [draftId])
  const agent = (
    await pool.query("SELECT agent_id FROM tasks WHERE id=$1", [success.taskId])
  ).rows[0].agent_id
  await until(async () => (output.includes("Ready") ? true : null), "isolated Web ready")
  const api = await request.newContext({ baseURL: process.env.APP_URL })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.UI_BROWSER_PATH,
  })
  try {
    assert.equal((await api.get(`/api/workflows/${draftId}`)).status(), 401)
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
    const article = page
      .getByRole("article")
      .filter({ has: page.getByRole("link", { name: "修订与费用", exact: true }) })
    await article.getByText("修订草稿 · 待独立验证", { exact: true }).waitFor()
    const form = article.getByRole("form", { name: "验证流程样例", exact: true })
    await form.getByLabel("执行工作站", { exact: true }).selectOption(agent)
    const root = `PA-C3-Web-${Date.now()}`
    await form.getByLabel("父目录名（parentName）", { exact: true }).fill(root)
    await form.getByLabel("初始目录名（draftName）", { exact: true }).fill("UI Draft")
    await form.getByLabel("最终目录名（readyName）", { exact: true }).fill("UI Ready")
    const checkbox = form.getByRole("checkbox")
    assert.equal(await checkbox.isChecked(), false)
    await checkbox.check()
    await page.screenshot({
      path: path.join(directory, "repair-draft-desktop.png"),
      fullPage: true,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: path.join(directory, "repair-draft-mobile.png"),
      fullPage: true,
    })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    const posted: Record<string, any>[] = []
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      posted.push(route.request().postDataJSON())
      return posted.length === 1 ? route.abort("failed") : route.continue()
    })
    await form.getByRole("button", { name: "验证这个样例", exact: true }).click()
    await form.getByRole("alert").waitFor()
    await page.reload()
    await until(
      async () =>
        (await form
          .getByLabel("父目录名（parentName）", { exact: true })
          .inputValue()) === root
          ? true
          : null,
      "restored repair selection and parameters"
    )
    assert.equal(await checkbox.isChecked(), true)
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/tasks") && response.request().method() === "POST"
    )
    await form.getByRole("button", { name: "验证这个样例", exact: true }).click()
    const accepted = await response
    assert.equal(accepted.status(), 202)
    submittedTaskId = (await accepted.json()).taskId
    assert.deepEqual(posted[0], posted[1])
    const task = (
      await pool.query("SELECT config_snapshot,budget,status FROM tasks WHERE id=$1", [
        submittedTaskId,
      ])
    ).rows[0]
    assert.equal(task.config_snapshot.workflowExecution.allowRepair, true)
    assert.equal(task.config_snapshot.model, "custom/workflow-repair-fixture")
    assert.equal(task.budget.maxSteps, 1)
    assert.equal(task.budget.maxCostMicros, undefined)
    assert.equal(task.status, "queued")
    checks.push(
      "repair draft is owner-visible with explicit model-cost opt-in; checkbox/parameters/request key survive response loss and reload; original Task admission freezes selected model and one-decision budget"
    )
    await api.post(`/api/tasks/${submittedTaskId}/cancel`, {
      headers: { Origin: process.env.APP_URL! },
    })
    assert.equal(
      (await pool.query("SELECT status FROM tasks WHERE id=$1", [submittedTaskId]))
        .rows[0].status,
      "cancelled"
    )
    await page.goto(`${process.env.APP_URL}/?task=${success.taskId}`)
    await page
      .getByText("修订草稿已保存，独立验证通过后才能启用；原版本保持不变。", {
        exact: true,
      })
      .waitFor()
    await page.screenshot({
      path: path.join(directory, "repair-result-mobile.png"),
      fullPage: true,
    })
    const detail = await (await api.get(`/api/tasks/${success.taskId}`)).json()
    assert.equal(detail.workflowRun.repairStatus, "accepted")
    assert.equal(detail.workflowRun.draftVersionId, draftId)
    assert.deepEqual(errors, [])
    checks.push(
      "completed real GUI task shows repair state/new draft without claiming zero model calls; desktop/390px pages render without client errors"
    )
    await context.close()
    passed = true
  } finally {
    await browser.close()
    await api.dispose()
  }
} finally {
  if (web.pid && web.exitCode === null) process.kill(-web.pid, "SIGTERM")
  await webDone
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    submittedTaskId,
    checks,
    scope:
      "C3 owner UI/admission against isolated cloned evidence; no worker or additional GUI/model execution",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-repair-ui.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
