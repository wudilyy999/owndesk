import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { chromium, request } from "playwright"
import { hashPassword } from "better-auth/crypto"
import { createServer, type Server } from "node:http"
import type { WorkflowCandidate, WorkflowStep, WorkflowText } from "@/lib/workflow-schema"

// Paid real-model acceptance, explicitly authorized by the owner. Unknown outcomes
// stop this run; the test never grants consent or retries a missing model receipt.
process.loadEnvFile(".env")
const controlled = process.argv[2] === "fixture"
assert(
  process.argv[2] === undefined || controlled,
  "Use fixture for unpaid controlled-provider checks"
)
const baseline = JSON.parse(await readFile("docs/evidence/flow-c0-baseline.json", "utf8"))
assert(baseline.passed && baseline.status === "completed")
assert(/^agent_flow_[a-f0-9]+$/.test(baseline.database))
const database = `agent_compile_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${baseline.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
const install = randomUUID()
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: install,
  APP_URL: "http://127.0.0.1:17127",
  WORKER_PORT: "17128",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.1",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const processes: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
const checks: Record<string, unknown>[] = []
let passed = false,
  taskId: string | undefined
let summary: Record<string, unknown> = {}
let fixture: Server | undefined
let fixtureRequests = 0
let fixtureFailure: string | undefined

function start(args: string[], name: string) {
  const child = spawn(process.execPath, args, { env: process.env, detached: true })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), output)
  })
  const job = { child, done, output: () => output }
  processes.push(job)
  return job
}

try {
  const migration = start(["--import", "tsx", "scripts/migrate.ts"], "migrate")
  await migration.done
  assert.equal(migration.child.exitCode, 0)
  const { pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  try {
    const { submitTask } = await import("@/lib/tasks")
    const { freezeWorkflowCompilation, getWorkflowVersion, requireReadyWorkflow } =
      await import("@/lib/workflows")
    const { bindWorkflowContract, validateWorkflowCandidate } =
      await import("@/lib/workflow-schema")
    const { decryptSecret } = await import("@/lib/secrets")
    const source = (
      await pool.query("SELECT * FROM tasks WHERE id=$1", [baseline.taskId])
    ).rows[0]
    const originalSource = JSON.stringify(source)
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"
        )
      ).rows[0].count,
      JSON.parse(await readFile("db/migrations/meta/_journal.json", "utf8")).entries
        .length
    )
    assert.equal(
      (await pool.query("SELECT to_regclass('workflow_versions') IS NOT NULL AS present"))
        .rows[0].present,
      true
    )
    const agent = randomUUID()
    const model = controlled ? "custom/workflow-fixture" : baseline.model
    if (controlled) {
      const text = (literal: string): WorkflowText => [{ literal }]
      const parameter = (name: string): WorkflowText => [{ parameter: name }]
      const home = text("agent - Thunar")
      const parent: WorkflowText = [{ parameter: "parentName" }, { literal: " - Thunar" }]
      const create = text("Create New Folder")
      const rename: WorkflowText = [
        { literal: 'Rename "' },
        { parameter: "draftName" },
        { literal: '"' },
      ]
      const steps: WorkflowStep[] = []
      const press = (
        title: WorkflowText,
        key: "l" | "n" | "enter" | "f2",
        modifiers: ("ctrl" | "shift")[] = []
      ) =>
        steps.push({
          id: `step-${steps.length}`,
          label: `按键 ${key}`,
          evidence: [],
          operation: "key_press",
          when: { application: "Thunar", title },
          key,
          modifiers,
        })
      const type = (title: WorkflowText, content: WorkflowText) =>
        steps.push({
          id: `step-${steps.length}`,
          label: "填写目录名或路径",
          evidence: [],
          operation: "key_type",
          when: { application: "Thunar", title },
          text: content,
        })
      steps.push({
        id: "open",
        label: "打开 Thunar",
        evidence: [],
        operation: "open_application",
        application: "Thunar",
      })
      press(home, "n", ["ctrl", "shift"])
      type(create, parameter("parentName"))
      press(create, "enter")
      press(home, "l", ["ctrl"])
      type(home, [{ literal: "/home/agent/" }, { parameter: "parentName" }])
      press(home, "enter")
      press(parent, "n", ["ctrl", "shift"])
      type(create, parameter("draftName"))
      press(create, "enter")
      press(parent, "f2")
      type(rename, parameter("readyName"))
      press(rename, "enter")
      steps.push({
        id: "final-window",
        label: "核对当前目录窗口",
        evidence: [],
        operation: "assert",
        window: { application: "Thunar", title: parent },
      })
      steps.push({
        id: "share",
        label: "展示最后桌面",
        evidence: [],
        operation: "observe",
        share: true,
      })
      const candidate: WorkflowCandidate = {
        description: "受控提供者生成的参数化 Thunar 计划，用于执行链与界面检查",
        steps,
      }
      fixture = createServer((req, res) => {
        void (async () => {
          let raw = ""
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw)
          assert.equal(body.tools.length, 1)
          assert.equal(body.tools[0].function.name, "submit_workflow")
          const messages = JSON.stringify(body.messages)
          for (const old of [
            "private-source-container",
            "private standing order",
            "data:image",
          ])
            assert(!messages.includes(old), `Unexpected source data: ${old}`)
          fixtureRequests++
          assert.equal(
            fixtureRequests,
            1,
            "The controlled candidate must be accepted in one request"
          )
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              id: "workflow-fixture",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "workflow-fixture",
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "compile-fixture",
                        type: "function",
                        function: {
                          name: "submit_workflow",
                          arguments: JSON.stringify(candidate),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            })
          )
        })().catch((error) => {
          fixtureFailure = error.message
          res.writeHead(500).end("Controlled workflow provider failed")
        })
      })
      fixture.listen(0, "127.0.0.1")
      await once(fixture, "listening")
      const address = fixture.address()
      assert(address && typeof address !== "string")
      const { setSettings } = await import("@/lib/config")
      await setSettings([
        { key: "provider.custom.apiKey", value: `local-workflow-${randomUUID()}` },
        { key: "provider.custom.baseUrl", value: `http://127.0.0.1:${address.port}/v1` },
      ])
    }
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Workflow Compiler','Compile a checked GUI trace','',$2,$3,now(),now())",
      [agent, model, randomUUID()]
    )
    const input = {
      agentId: agent,
      goal: "提炼 Thunar 创建与重命名流程",
      clientRequestId: randomUUID(),
      workflowCompilation: {
        sourceTaskId: source.id,
        name: "Thunar 创建并重命名目录",
        parameters: [
          {
            name: "parentName",
            label: "父目录名",
            sourceValue: baseline.root.split("/").at(-1)!,
          },
          { name: "draftName", label: "初始目录名", sourceValue: "Draft" },
          { name: "readyName", label: "最终目录名", sourceValue: "Ready" },
        ],
      },
      completionContract: source.completion_contract,
      budget: { maxSteps: 4 },
    }
    await assert.rejects(
      () =>
        freezeWorkflowCompilation(
          "different-owner",
          input.workflowCompilation,
          input.completionContract
        ),
      /Source task not found/
    )
    await assert.rejects(
      () =>
        freezeWorkflowCompilation(source.owner_id, input.workflowCompilation, {
          requireHumanReview: false,
        }),
      /unchanged source completion contract/
    )
    await assert.rejects(
      () =>
        submitTask(source.owner_id, "c1-real-compile", {
          ...input,
          workflowCompilation: {
            ...input.workflowCompilation,
            parameters: [
              ...input.workflowCompilation.parameters,
              input.workflowCompilation.parameters[0],
            ],
          },
        }),
      /must be unique/
    )
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM workflow_versions")).rows[0]
        .count,
      0
    )
    const admitted = await submitTask(source.owner_id, "c1-real-compile", input)
    taskId = admitted.taskId
    const duplicate = await submitTask(source.owner_id, "c1-real-compile", input)
    assert(duplicate.reused && duplicate.taskId === taskId)
    await assert.rejects(
      () =>
        submitTask(source.owner_id, "c1-real-compile", { ...input, goal: "different" }),
      /different task parameters/
    )
    await assert.rejects(
      () => requireReadyWorkflow(source.owner_id, taskId!),
      /not passed independent/
    )
    await assert.rejects(
      () => getWorkflowVersion("different-owner", taskId!),
      /not found/
    )
    const frozen = (
      await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [taskId])
    ).rows[0].config_snapshot.workflowCompilation
    for (const field of [
      "observationId",
      "bootId",
      "epoch",
      "pageId",
      '"ref":',
      '"x":',
      '"image":',
    ])
      assert(!JSON.stringify(frozen.trace).includes(field))
    checks.push({
      check:
        "source ownership, immutable contract, parameter declarations, request deduplication and unverified-ready gate",
      passed: true,
    })
    checks.push({
      check:
        "Current migrations applied only to the new isolated clone; source Task retained byte-for-byte",
      passed: true,
    })
    await writeFile(
      path.join(directory, "admission.json"),
      JSON.stringify(
        {
          database,
          taskId,
          sourceTaskId: source.id,
          model,
          controlledProvider: controlled,
          installId: install,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    )
    const worker = start(["--import", "tsx", "worker/main.ts"], "worker")
    for (let i = 0; !worker.output().includes("Worker ready"); i++) {
      assert(
        worker.child.exitCode === null && i < 300,
        "Isolated worker did not become ready"
      )
      await delay(100)
    }
    let state
    for (let i = 0; i < 900; i++) {
      state = (
        await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
      ).rows[0]
      if (
        ["completed", "failed", "cancelled", "needs_review", "waiting_user"].includes(
          state.status
        )
      )
        break
      await delay(1000)
    }
    const version = await getWorkflowVersion(source.owner_id, taskId)
    const attempts = (
      await pool.query(
        "SELECT decision_no,attempt_no,status,cost_micros,model,error FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
        [taskId]
      )
    ).rows
    summary = {
      database,
      taskId,
      sourceTaskId: source.id,
      state,
      attempts,
      version,
      model,
      controlledProvider: controlled,
      fixtureRequests: controlled ? fixtureRequests : undefined,
      fixtureFailure,
    }
    assert.equal(state.status, "completed", JSON.stringify(state))
    assert.equal(fixtureFailure, undefined)
    assert(
      attempts.length > 0 && attempts.every((attempt) => attempt.status === "succeeded"),
      "Unknown outcomes require owner consent; no test retry"
    )
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1",
          [taskId]
        )
      ).rows[0].count,
      0
    )
    assert.equal(version.status, "verifying")
    assert.equal(version.plan!.sourceTaskId, source.id)
    validateWorkflowCandidate(
      { description: version.plan!.description, steps: version.plan!.steps },
      frozen
    )
    const bound = bindWorkflowContract(version.plan!.completion, {
      parentName: "C1-不同目录",
      draftName: "待处理",
      readyName: "已完成",
    })
    assert.deepEqual(bound, {
      root: "/home/agent/C1-不同目录",
      directories: ["已完成"],
      absent: ["待处理"],
    })
    assert.equal(
      JSON.stringify(
        (await pool.query("SELECT * FROM tasks WHERE id=$1", [source.id])).rows[0]
      ),
      originalSource
    )
    await assert.rejects(
      () => requireReadyWorkflow(source.owner_id, taskId!),
      /not passed independent/
    )
    checks.push({
      check: `${controlled ? "controlled provider" : "real model"} compiled sanitized source through original Task/DBOS/model ledger; candidate persisted, no workstation actions, distinct billing`,
      requests: attempts.length,
      passed: true,
    })
    checks.push({
      check:
        "all three parameters bound to independent names; version remains unavailable as ready",
      passed: true,
    })

    // Web read/form evidence uses the same isolated DB; production .next output stays untouched.
    const password = randomUUID()
    await pool.query(
      'UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"=\'credential\'',
      [await hashPassword(password), source.owner_id]
    )
    await pool.query("DELETE FROM session")
    const email = (
      await pool.query('SELECT email FROM "user" WHERE id=$1', [source.owner_id])
    ).rows[0].email
    const web = start(
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "17127",
      ],
      "web"
    )
    const api = await request.newContext({ baseURL: process.env.APP_URL })
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.UI_BROWSER_PATH,
    })
    try {
      for (let i = 0; !web.output().includes("Ready"); i++) {
        assert(
          web.child.exitCode === null && i < 300,
          "Isolated web did not become ready"
        )
        await delay(100)
      }
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
      assert.equal((await api.get(`/api/workflows/${taskId}`)).status(), 200)
      assert.equal((await api.get("/api/workflows/nonexistent")).status(), 404)
      const context = await browser.newContext({
        storageState: await api.storageState(),
        viewport: { width: 1280, height: 960 },
      })
      const page = await context.newPage()
      await page.goto(`${process.env.APP_URL}/workflows`)
      await page.getByText("候选 · 待验证", { exact: true }).waitFor()
      await page.screenshot({
        path: path.join(directory, "workflows-desktop.png"),
        fullPage: true,
      })
      await page.goto(`${process.env.APP_URL}/workflows?source=${source.id}`)
      await page.getByRole("button", { name: "生成流程候选" }).waitFor()
      await page.getByRole("textbox", { name: "父目录名参数名" }).fill("projectFolder")
      await page.getByLabel("流程名称", { exact: true }).fill("自定义流程名称")
      await page.screenshot({
        path: path.join(directory, "compilation-form-desktop.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: path.join(directory, "compilation-form-mobile.png"),
        fullPage: true,
      })
      await page.waitForLoadState("networkidle")
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        ),
        false
      )
      const formRequests: Record<string, any>[] = []
      await page.route("**/api/tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue()
        formRequests.push(route.request().postDataJSON())
        if (formRequests.length === 1) return route.abort("failed")
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ taskId, reused: true }),
        })
      })
      await page.getByRole("button", { name: "生成流程候选" }).click()
      await page.getByRole("alert").waitFor()
      await page.reload()
      await page.getByRole("textbox", { name: "父目录名参数名" }).waitFor()
      assert.equal(
        await page.getByRole("textbox", { name: "父目录名参数名" }).inputValue(),
        "projectFolder"
      )
      assert.equal(
        await page.getByLabel("流程名称", { exact: true }).inputValue(),
        "自定义流程名称"
      )
      await page.getByRole("button", { name: "生成流程候选" }).click()
      await page.waitForURL(`**/?task=${taskId}`)
      assert.equal(formRequests.length, 2)
      assert.equal(formRequests[0].clientRequestId, formRequests[1].clientRequestId)
      assert.deepEqual(formRequests[1].completionContract, source.completion_contract)
      assert.deepEqual(
        formRequests[1].workflowCompilation.parameters,
        input.workflowCompilation.parameters.map((p, index) =>
          index === 0 ? { ...p, name: "projectFolder" } : p
        )
      )
      checks.push({
        check:
          "authenticated workflow API, source form, readable candidate, desktop/390px layout and intercepted form response-loss/reload deduplication",
        passed: true,
      })
      await context.close()
    } finally {
      await browser.close()
      await api.dispose()
    }
    const key = decryptSecret(
      (
        await pool.query("SELECT value FROM settings WHERE key=$1", [
          `provider.${model.split("/")[0]}.apiKey`,
        ])
      ).rows[0].value
    )
    assert(!JSON.stringify(summary).includes(key))
    for (const process of processes)
      assert(
        !process.output().includes(key),
        "No plaintext API key in migration/worker/web logs"
      )
    checks.push({
      check: "plaintext provider key absent from result and process logs",
      passed: true,
    })
    passed = true
  } finally {
    for (const process of processes)
      if (process.child.pid && process.child.exitCode === null)
        globalThis.process.kill(-process.child.pid, "SIGTERM")
    await Promise.all(processes.map((process) => process.done))
    await closeDurableClient()
    await pool.end()
    if (fixture)
      await new Promise<void>((resolve, reject) =>
        fixture!.close((error) => (error ? reject(error) : resolve()))
      )
  }
} finally {
  const evidence = {
    passed,
    scope: `C1/T19 ${controlled ? "controlled-provider" : "real-model"} candidate compilation, not C2 execution, ready certification or OwnDesk comparison`,
    directory,
    checks,
    ...summary,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      controlled
        ? "docs/evidence/workflow-compilation-controlled.json"
        : "docs/evidence/workflow-compilation.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, taskId }))
