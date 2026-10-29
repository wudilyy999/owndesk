import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { chromium, request } from "playwright"

// C5: migrate an isolated source copy; import into an empty installation with
// new owner/keys/home. No provider is configured and no cloud request is made.
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_flowshare_${randomUUID().replaceAll("-", "")}`
const sourceCopy = `agent_sharesource_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const baseUrl = new URL(process.env.DATABASE_URL!)
const sourceUrl = new URL(baseUrl)
sourceUrl.pathname = `/${sourceCopy}`
const targetUrl = new URL(baseUrl)
targetUrl.pathname = `/${database}`
const admin = new pg.Client({ connectionString: baseUrl.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${sourceCopy}" TEMPLATE "${core.database}"`)
await admin.query(`CREATE DATABASE "${database}"`)
await admin.end()
Object.assign(process.env, {
  DATABASE_URL: targetUrl.toString(),
  INSTALL_ID: randomUUID(),
  MASTER_KEY: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomUUID(),
  APP_URL: "http://127.0.0.1:17177",
  WORKER_PORT: "17178",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "workflow-sharing@example.com",
  OWNER_PASSWORD: randomUUID(),
})
const checks: Record<string, unknown>[] = []
const results: Record<string, unknown>[] = []
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
const taskIds: string[] = []
let passed = false
let versionId: string | undefined

function start(args: string[], name: string, env = process.env) {
  const child = spawn(process.execPath, args, { env, detached: true })
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
async function until<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  const end = Date.now() + 240000
  while (Date.now() < end) {
    const value = await read()
    if (value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${description}`)
}

const sourceOriginalUrl = new URL(baseUrl)
sourceOriginalUrl.pathname = `/${core.database}`
const original = new pg.Client({ connectionString: sourceOriginalUrl.toString() })
await original.connect()
const sourceVersionId = core.results[0].input.workflowExecution.versionId
const sourceBefore = (
  await original.query("SELECT * FROM workflow_versions WHERE id=$1", [sourceVersionId])
).rows[0]
const sourceTasksBefore = (
  await original.query("SELECT count(*)::int AS count FROM tasks")
).rows[0].count

try {
  for (const [name, url] of [
    ["source", sourceUrl],
    ["target", targetUrl],
  ] as const) {
    const job = start(["--import", "tsx", "scripts/migrate.ts"], `migrate-${name}`, {
      ...process.env,
      DATABASE_URL: url.toString(),
    })
    await job.done
    assert.equal(job.child.exitCode, 0, job.output())
  }
  const publicPath = path.join(directory, "workflow-package.json")
  const exported = start(
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { pool } from './db/index.ts';
    import { exportWorkflowPackage } from './lib/workflow-packages.ts';
    import { writeFile } from 'node:fs/promises';
    try {
      const owner=(await pool.query('SELECT owner_id FROM workflow_versions WHERE id=$1',[${JSON.stringify(sourceVersionId)}])).rows[0].owner_id;
      const pack=await exportWorkflowPackage(owner,${JSON.stringify(sourceVersionId)});
      await writeFile(${JSON.stringify(publicPath)},JSON.stringify(pack,null,2),{mode:0o600,flag:'wx'});
      console.log('Source ready version exported through owner service');
    } finally { await pool.end(); }
  `,
    ],
    "export-source",
    { ...process.env, DATABASE_URL: sourceUrl.toString() }
  )
  await exported.done
  assert.equal(exported.child.exitCode, 0, exported.output())
  const serialized = await readFile(publicPath, "utf8")
  const pack = JSON.parse(serialized)
  for (const privateValue of [
    sourceVersionId,
    sourceBefore.source_task_id,
    sourceBefore.compilation_task_id,
    ...sourceBefore.plan.parameters.map((p: { sourceValue: string }) => p.sourceValue),
  ])
    assert(
      !serialized.includes(privateValue),
      "Export must omit every private source identity/value"
    )
  assert.deepEqual(pack.environment, sourceBefore.validated_environment)
  const ownerJob = start(["--import", "tsx", "scripts/owner.ts"], "owner-target")
  await ownerJob.done
  assert.equal(ownerJob.child.exitCode, 0, ownerJob.output())
  const { pool } = await import("@/db")
  const { getWorkflowVersion } = await import("@/lib/workflows")
  const { importWorkflowPackage } = await import("@/lib/workflow-packages")
  const { closeDurableClient } = await import("@/lib/durable")
  const { requestCancellation } = await import("@/lib/task-control")
  try {
    const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    assert.notEqual(owner, sourceBefore.owner_id)
    const agent = (await pool.query("SELECT id FROM agents WHERE model IS NULL")).rows[0]
      .id
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM settings WHERE key LIKE 'provider.%' OR key='model.default'"
        )
      ).rows[0].count,
      0
    )
    const web = start(
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        "17177",
      ],
      "web"
    )
    await until(async () => {
      assert.equal(web.child.exitCode, null, web.output())
      return web.output().includes("Ready") ? true : null
    }, "isolated fresh Web ready")
    const api = await request.newContext({ baseURL: process.env.APP_URL })
    const anon = await request.newContext({ baseURL: process.env.APP_URL })
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.UI_BROWSER_PATH,
    })
    try {
      const requestBody = { clientRequestId: randomUUID(), reviewed: true, package: pack }
      assert.equal(
        (
          await anon.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL! },
            data: requestBody,
          })
        ).status(),
        401
      )
      assert.equal(
        (await anon.get(`/api/workflows/${sourceVersionId}/export`)).status(),
        401
      )
      assert.equal(
        (
          await api.post("/api/auth/sign-in/email", {
            headers: { Origin: process.env.APP_URL! },
            data: {
              email: process.env.OWNER_EMAIL,
              password: process.env.OWNER_PASSWORD,
            },
          })
        ).status(),
        200
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: "https://foreign.example" },
            data: requestBody,
          })
        ).status(),
        403
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL! },
            data: { ...requestBody, reviewed: false },
          })
        ).status(),
        400
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL! },
            data: { ...requestBody, package: { ...pack, status: "ready" } },
          })
        ).status(),
        400
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL!, "Content-Type": "application/json" },
            data: "{",
          })
        ).status(),
        400
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL!, "Content-Type": "text/plain" },
            data: "{}",
          })
        ).status(),
        415
      )
      assert.equal(
        (
          await api.post("/api/workflows/import", {
            headers: { Origin: process.env.APP_URL!, "Content-Type": "application/json" },
            data: " ".repeat(128 * 1024 + 1),
          })
        ).status(),
        413
      )
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM workflow_versions")).rows[0]
          .count,
        0
      )
      checks.push({
        check:
          "anonymous/auth/origin/review/strict-schema/JSON/media-type/streamed-size boundaries reject before creating versions",
        passed: true,
      })
      const context = await browser.newContext({
        storageState: await api.storageState(),
        viewport: { width: 1280, height: 960 },
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${process.env.APP_URL}/workflows`)
      const form = page.getByRole("form", { name: "导入流程包", exact: true })
      await form.getByLabel("选择 JSON 文件", { exact: true }).setInputFiles(publicPath)
      await form
        .getByLabel("我已核对参数、步骤、环境和检查合同，允许保存这个外部流程草稿。", {
          exact: true,
        })
        .check()
      const posted: Record<string, any>[] = []
      await page.route("**/api/workflows/import", async (route) => {
        if (route.request().method() !== "POST") return route.continue()
        posted.push(route.request().postDataJSON())
        if (posted.length === 1) {
          const accepted = await route.fetch()
          assert.equal(accepted.status(), 201)
          versionId = (await accepted.json()).versionId
          return route.abort("failed")
        }
        return route.continue()
      })
      await form.getByRole("button", { name: "导入为待验证草稿", exact: true }).click()
      await form.getByRole("alert").waitFor()
      assert(versionId)
      await page.reload()
      await form.locator("pre").waitFor()
      assert.equal(
        await form.getByRole("checkbox").isChecked(),
        false,
        "Restored payload requires review again"
      )
      await form.getByRole("checkbox").check()
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/workflows/import") &&
          response.request().method() === "POST"
      )
      await form.getByRole("button", { name: "导入为待验证草稿", exact: true }).click()
      assert.equal((await response).status(), 200)
      await form.getByRole("status").waitFor()
      assert.equal(posted.length, 2)
      assert.deepEqual(posted[0], posted[1])
      const imported = await getWorkflowVersion(owner, versionId!)
      assert.equal(imported.status, "draft")
      assert.equal(imported.sourceTaskId, null)
      assert.equal(imported.compilationTaskId, null)
      assert.equal(imported.validatedEnvironment, null)
      assert.equal(imported.plan!.sourceTaskId, null)
      assert.deepEqual(imported.importedPackage, pack)
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM tasks")).rows[0].count,
        0
      )
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM workstation_control"))
          .rows[0].count,
        0
      )
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM workflow_versions")).rows[0]
          .count,
        1
      )
      await assert.rejects(
        () =>
          importWorkflowPackage(owner, {
            ...posted[0],
            package: { ...pack, name: "Changed reviewed package" },
          }),
        /different package content/
      )
      const concurrent = await Promise.all(
        Array.from({ length: 3 }, () => importWorkflowPackage(owner, posted[0]))
      )
      assert(
        concurrent.every((result) => result.reused && result.versionId === versionId)
      )
      assert.equal((await api.get(`/api/workflows/${versionId}/export`)).status(), 409)
      assert.equal(
        (await api.get(`/api/workflows/${sourceVersionId}/export`)).status(),
        404
      )
      await page.getByText("导入草稿 · 待独立验证", { exact: true }).waitFor()
      assert.equal(
        await page.getByRole("link", { name: "来源任务", exact: true }).count(),
        0
      )
      await page.screenshot({
        path: path.join(directory, "import-draft-desktop.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: path.join(directory, "import-draft-mobile.png"),
        fullPage: true,
      })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      checks.push({
        check:
          "actual committed-but-lost import response reuses request/content after reload and concurrent retry; imported draft has null local sources/no readiness/no Tasks/no workstation",
        versionId,
        passed: true,
      })
      const makeInput = (index: number, purpose: "verify" | "run") => ({
        agentId: agent,
        goal: `独立安装流程样例 ${index + 1}`,
        clientRequestId: randomUUID(),
        workflowExecution: {
          versionId,
          purpose,
          parameters: {
            input1: `PA-C5-${index}-${Date.now()}`,
            input2: ["Incoming-A", "Draft with spaces", "待归档", "New-input-four"][
              index
            ],
            input3: ["Finished-A", "Ready with spaces", "已归档", "Final-four"][index],
          },
          maxActions: 120,
          maxDurationSeconds: 300,
        },
        budget: { maxSteps: 1, maxCostMicros: 0 },
      })
      assert.equal(
        (
          await api.post("/api/tasks", {
            headers: { Origin: process.env.APP_URL! },
            data: makeInput(0, "run"),
          })
        ).status(),
        409
      )
      const worker = start(["--import", "tsx", "worker/main.ts"], "worker")
      await until(async () => {
        assert.equal(worker.child.exitCode, null, worker.output())
        return worker.output().includes("Worker ready") ? true : null
      }, "new installation worker ready")
      for (let index = 0; index < 4; index++) {
        const input = makeInput(index, index < 3 ? "verify" : "run")
        const accepted = await api.post("/api/tasks", {
          headers: { Origin: process.env.APP_URL! },
          data: input,
        })
        assert.equal(accepted.status(), 202, await accepted.text())
        const id = (await accepted.json()).taskId
        taskIds.push(id)
        const state = await until(
          async () => {
            const row = (
              await pool.query(
                "SELECT status,result,error,completion_contract,config_snapshot FROM tasks WHERE id=$1",
                [id]
              )
            ).rows[0]
            return [
              "completed",
              "failed",
              "cancelled",
              "needs_review",
              "waiting_user",
            ].includes(row.status)
              ? row
              : null
          },
          `independent actual GUI task ${index + 1}`
        )
        const actions = (
          await pool.query(
            "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
            [id]
          )
        ).rows
        for (const action of actions) {
          if (action.kind === "screen_share" && action.receipt?.output?.image)
            await writeFile(
              path.join(directory, `task-${index + 1}-desktop.jpg`),
              Buffer.from(action.receipt.output.image, "base64")
            )
          if (action.receipt?.output?.image) delete action.receipt.output.image
        }
        const run = (
          await pool.query(
            "SELECT checkpoint,environment,started_at,completed_at FROM task_workflow_runs WHERE task_id=$1",
            [id]
          )
        ).rows[0]
        results.push({ taskId: id, input, state, run, actions })
        await writeFile(
          path.join(directory, `task-${index + 1}.json`),
          JSON.stringify(results.at(-1), null, 2)
        )
        assert.equal(state.status, "completed", JSON.stringify(state))
        assert.equal(state.result.directoryTree.grade, "program_checked")
        assert.equal(state.config_snapshot.model, "workflow/deterministic")
        assert.equal(run.checkpoint.step, pack.steps.length)
        assert(
          actions.every(
            (action) =>
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
        const version = await getWorkflowVersion(owner, versionId!)
        assert.equal(version.status, index < 2 ? "verifying" : "ready")
        if (index < 2) assert.equal(version.validatedEnvironment, null)
        else assert.deepEqual(version.validatedEnvironment, run.environment)
        checks.push({
          check: `new independent GUI task ${index + 1} with changed directory names/host check; status ${version.status}`,
          taskId: id,
          actions: actions.length,
          passed: true,
        })
      }
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM tasks")).rows[0].count,
        4
      )
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM task_model_attempts"))
          .rows[0].count,
        0
      )
      const workstation = (
        await pool.query(
          "SELECT container_name,boot_id FROM workstation_control WHERE agent_id=$1",
          [agent]
        )
      ).rows[0]
      assert(workstation.container_name)
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM task_requests")).rows[0]
          .count,
        0
      )
      await page.reload()
      await page.getByText("可复用", { exact: true }).waitFor()
      const exportForm = page.getByRole("region", { name: "导出流程包", exact: true })
      await exportForm
        .getByRole("button", { name: "准备脱敏流程包", exact: true })
        .click()
      const downloadButton = exportForm.getByRole("button", {
        name: "下载已审阅的流程包",
        exact: true,
      })
      await downloadButton.waitFor()
      assert.equal(await downloadButton.isDisabled(), true)
      await exportForm.getByRole("checkbox").check()
      const downloadEvent = page.waitForEvent("download")
      await downloadButton.click()
      const download = await downloadEvent
      await download.saveAs(path.join(directory, "reexported-workflow-package.json"))
      const reexported = JSON.parse(
        await readFile(path.join(directory, "reexported-workflow-package.json"), "utf8")
      )
      assert.deepEqual(
        reexported.environment,
        (await getWorkflowVersion(owner, versionId!)).validatedEnvironment
      )
      assert(!JSON.stringify(reexported).includes(versionId!))
      assert(!JSON.stringify(reexported).includes(pack.packageId))
      for (const id of taskIds) assert(!JSON.stringify(reexported).includes(id))
      await page.screenshot({
        path: path.join(directory, "ready-reexport-mobile.png"),
        fullPage: true,
      })
      await page.setViewportSize({ width: 1280, height: 960 })
      await page.screenshot({
        path: path.join(directory, "ready-reexport-desktop.png"),
        fullPage: true,
      })
      assert.deepEqual(errors, [])
      checks.push({
        check:
          "fresh owner/keys/database/home revalidated three real samples then ran ready; zero model/API/human requests; actual reviewed owner download omits local provenance again",
        workstation,
        passed: true,
      })
      await context.close()
      passed = true
    } finally {
      await browser.close()
      await api.dispose()
      await anon.dispose()
    }
  } finally {
    for (const id of taskIds) {
      const state = (
        await pool.query("SELECT owner_id,status FROM tasks WHERE id=$1", [id])
      ).rows[0]
      if (!["completed", "failed", "cancelled"].includes(state.status))
        await requestCancellation(state.owner_id, id)
    }
    for (const job of jobs)
      if (job.child.pid && job.child.exitCode === null)
        process.kill(-job.child.pid, "SIGTERM")
    await Promise.all(jobs.map((job) => job.done))
    await closeDurableClient()
    await pool.end()
  }
} finally {
  assert.deepEqual(
    (
      await original.query("SELECT * FROM workflow_versions WHERE id=$1", [
        sourceVersionId,
      ])
    ).rows[0],
    sourceBefore
  )
  assert.equal(
    (await original.query("SELECT count(*)::int AS count FROM tasks")).rows[0].count,
    sourceTasksBefore
  )
  await original.end()
  assert(originalEnv.equals(await readFile(".env")))
  const evidence = {
    passed,
    database,
    sourceCopy,
    originalSourceDatabase: core.database,
    directory,
    versionId,
    checks,
    taskIds,
    results,
    cloudRequests: 0,
    scope:
      "C5 local export/import and fresh empty installation with independent owner/keys/database/home, three real GUI revalidation samples plus ready run; same host/architecture/image, not a remote-cloud/cross-platform/community-market or real-model quality acceptance",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-sharing.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(
  JSON.stringify({ passed, directory, tasks: taskIds.length, checks: checks.length })
)
