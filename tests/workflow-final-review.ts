import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// One real GUI Task with a deliberately unsatisfied imported completion contract.
// It must wait for review at the terminal checkpoint, without repeating inputs.
process.loadEnvFile(".env")
const sharing = JSON.parse(await readFile("docs/evidence/workflow-sharing.json", "utf8"))
assert(sharing.passed && /^agent_flowshare_[a-f0-9]+$/.test(sharing.database))
const database = `agent_finalreview_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true, mode: 0o700 })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${sharing.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17187",
  WORKER_PORT: "17188",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const { pool } = await import("@/db")
const { submitTask } = await import("@/lib/tasks")
const { importWorkflowPackage } = await import("@/lib/workflow-packages")
const { requestCancellation, respondToRequest } = await import("@/lib/task-control")
const { closeDurableClient } = await import("@/lib/durable")
const { readBenchmarkTask } = await import("@/lib/workflow-benchmark-db")
const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
const agent = randomUUID()
let taskId: string | undefined
let passed = false
const checks: string[] = []
let metrics
let output = ""
let worker: ReturnType<typeof spawn> | undefined
let workerDone = Promise.resolve()
async function until<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== null) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${message}`)
}
try {
  await pool.query(
    "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Final Check Lab','Terminal checkpoint review','',NULL,$2,now(),now())",
    [agent, randomUUID()]
  )
  const pack = JSON.parse(
    await readFile(path.join(sharing.directory, "workflow-package.json"), "utf8")
  )
  ;[pack.completion.directories, pack.completion.absent] = [
    pack.completion.absent,
    pack.completion.directories,
  ]
  const imported = await importWorkflowPackage(owner, {
    clientRequestId: randomUUID(),
    reviewed: true,
    package: pack,
  })
  worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: process.env,
    detached: true,
  })
  worker.stdout!.on("data", (chunk) => (output += chunk))
  worker.stderr!.on("data", (chunk) => (output += chunk))
  workerDone = once(worker, "exit").then(async () => {
    await writeFile(path.join(directory, "worker.log"), output, { mode: 0o600 })
  })
  await until(async () => {
    assert.equal(worker!.exitCode, null, output)
    return output.includes("Worker ready") ? true : null
  }, "worker ready")
  taskId = (
    await submitTask(owner, "final-check-regression", {
      agentId: agent,
      goal: "验证最终检查失败后停止并等待复核",
      clientRequestId: randomUUID(),
      workflowExecution: {
        versionId: imported.versionId,
        purpose: "verify",
        parameters: {
          input1: `PA-Final-Review-${Date.now()}`,
          input2: "Required-but-renamed",
          input3: "Actual-final-folder",
        },
        maxActions: 120,
        maxDurationSeconds: 300,
      },
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 1, maxCostMicros: 0 },
    })
  ).taskId
  const pending = async () =>
    (
      await pool.query(
        "SELECT id,payload,payload_version FROM task_requests WHERE task_id=$1 AND status='pending'",
        [taskId]
      )
    ).rows[0] ?? null
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM task_actions WHERE task_id=$1) AS actions,(SELECT count(*)::int FROM task_events WHERE task_id=$1 AND type='workflow_step') AS checkpoints,(SELECT count(*)::int FROM task_model_attempts WHERE task_id=$1) AS models",
        [taskId]
      )
    ).rows[0]
  const first = await until(pending, "one terminal completion review")
  assert.equal(first.payload.purpose, "workflow_review")
  assert.equal(first.payload.workflowStep, pack.steps.length)
  assert.equal(first.payload.nextStep, "Fixed completion check")
  assert.match(first.payload.reason, /Required directory is missing/)
  const stopped = await counts()
  assert.deepEqual(stopped, { actions: 27, checkpoints: 29, models: 0 })
  await delay(1000)
  assert.deepEqual(await counts(), stopped)
  assert.equal((await pending()).id, first.id)
  checks.push(
    "Failed final host check creates one stable review after 27 real GUI actions; no completion loop or model request"
  )
  await respondToRequest(owner, first.id, "continue", first.payload_version, {})
  const second = await until(async () => {
    const request = await pending()
    return request && request.id !== first.id ? request : null
  }, "continued final check remains unsatisfied")
  assert.equal(second.payload.purpose, "workflow_review")
  assert.equal(second.payload.nextStep, "Fixed completion check")
  await delay(1000)
  assert.deepEqual(await counts(), stopped)
  const version = (
    await pool.query(
      "SELECT status,validated_environment FROM workflow_versions WHERE id=$1",
      [imported.versionId]
    )
  ).rows[0]
  assert.deepEqual(version, { status: "verifying", validated_environment: null })
  checks.push(
    "Explicit Continue only rechecks; unchanged failed contract stays unverified and no desktop input repeats"
  )
  await requestCancellation(owner, taskId)
  await until(
    async () =>
      (await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0]
        .status === "cancelled"
        ? true
        : null,
    "cancel terminal review"
  )
  metrics = await readBenchmarkTask(pool, taskId, "control")
  assert.equal(metrics.status, "cancelled")
  assert.equal(metrics.actions.length, 27)
  assert.equal(metrics.attempts.length, 0)
  checks.push(
    "Original cancellation terminates the waiting Task; metrics retain all real actions and review waits"
  )
  passed = true
} finally {
  if (taskId && !passed) {
    await requestCancellation(owner, taskId)
    await until(
      async () =>
        (await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])).rows[0]
          .status === "cancelled"
          ? true
          : null,
      "failed test cancellation confirmed"
    )
  }
  if (worker?.pid && worker.exitCode === null) process.kill(-worker.pid, "SIGTERM")
  await workerDone
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    installId: process.env.INSTALL_ID,
    taskId,
    checks,
    metrics,
    scope:
      "One real GUI Task with deliberately unsatisfied imported contract; terminal review/continue/cancel regression, no cloud calls or certification success",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-final-review.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, taskId, directory }))
