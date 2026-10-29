import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

assert.equal(
  process.argv[2],
  "--owner-approved-single-retry",
  "This command requires the owner's explicit single-retry consent"
)
process.loadEnvFile(".env")
const admission = JSON.parse(
  await readFile(
    "data/experiments/agent_compile_89b32692f49640c5b7887bb19091d06f/admission.json",
    "utf8"
  )
)
const taskId = admission.taskId as string
assert.equal(taskId, "5b0ad29b-a729-439b-91a0-13f34fb090fc")
const directory = path.resolve(
  "data/experiments",
  admission.database,
  `authorized-retry-${Date.now()}`
)
await mkdir(directory, { recursive: true, mode: 0o700 })
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${admission.database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: admission.installId,
  APP_URL: "http://127.0.0.1:17127",
  WORKER_PORT: "17128",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.1",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
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
      await writeFile(path.join(directory, `${name}.log`), output, { mode: 0o600 })
    }),
  }
  jobs.push(job)
  return job
}
let completed = false
let result: Record<string, unknown> = {}
const migration = start(
  ["--import", "tsx", "scripts/migrate.ts"],
  "migrate-isolated-original"
)
await migration.done
assert.equal(migration.child.exitCode, 0, migration.output())
const { pool } = await import("@/db")
const { respondToRequest } = await import("@/lib/task-control")
const { appendEventInTransaction } = await import("@/lib/task-events")
const { getWorkflowVersion } = await import("@/lib/workflows")
const { closeDurableClient } = await import("@/lib/durable")
try {
  const before = (
    await pool.query(
      "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
      [taskId]
    )
  ).rows
  assert.equal(before.length, 1)
  assert.equal(before[0].status, "unknown")
  const task = (
    await pool.query("SELECT owner_id,status,budget FROM tasks WHERE id=$1", [taskId])
  ).rows[0]
  assert.equal(task.status, "needs_review")
  const request = (
    await pool.query(
      "SELECT id,payload_version FROM task_requests WHERE task_id=$1 AND status='pending' AND payload->>'purpose'='execution_error'",
      [taskId]
    )
  ).rows[0]
  assert(request)
  // The owner's authorization is limited to one additional request. Reuse the
  // existing successful-decision budget; a valid response cannot start decision2.
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "UPDATE tasks SET budget=jsonb_set(budget,'{maxSteps}','1'::jsonb),updated_at=now() WHERE id=$1",
      [taskId]
    )
    await appendEventInTransaction(
      client,
      taskId,
      "owner-consent:c1-single-retry",
      "owner_consent",
      {
        purpose: "model_retry",
        maxAdditionalRequests: 1,
        previousBudget: task.budget,
        maxSteps: 1,
        note: "Owner explicitly accepted possible additional API fees on 2026-10-26; previous unknown attempt/cost retained.",
      }
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  const worker = start(["--import", "tsx", "worker/main.ts"], "worker")
  const readyUntil = Date.now() + 60000
  while (!worker.output().includes("Worker ready")) {
    assert.equal(worker.child.exitCode, null, worker.output())
    assert(Date.now() < readyUntil, "Original isolated worker failed to start")
    await delay(100)
  }
  await respondToRequest(task.owner_id, request.id, "continue", request.payload_version, {
    note: "允许继续，接受可能增加的 API 费用；本次追加一次请求，原未知费用保留。",
  })
  const end = Date.now() + 300000
  let state
  while (Date.now() < end) {
    const attempts = (
      await pool.query(
        "SELECT attempt_no,status FROM task_model_attempts WHERE task_id=$1 ORDER BY attempt_no",
        [taskId]
      )
    ).rows
    assert(attempts.length <= 2, "Single retry authorization exceeded")
    state = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
    ).rows[0]
    const waits = (
      await pool.query(
        "SELECT id,kind,payload,status FROM task_requests WHERE task_id=$1 AND status='pending' AND id<>$2",
        [taskId, request.id]
      )
    ).rows
    if (
      attempts.length === 2 &&
      (["completed", "failed", "cancelled"].includes(state.status) || waits.length)
    )
      break
    await delay(100)
  }
  const attempts = (
    await pool.query(
      "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
      [taskId]
    )
  ).rows
  assert.deepEqual(
    attempts[0],
    before[0],
    "Original unknown attempt must remain byte-for-byte unchanged"
  )
  const version = await getWorkflowVersion(task.owner_id, taskId)
  const requests = (
    await pool.query(
      "SELECT id,kind,status,payload,decision FROM task_requests WHERE task_id=$1 ORDER BY created_at",
      [taskId]
    )
  ).rows
  const actions = (
    await pool.query("SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1", [
      taskId,
    ])
  ).rows[0].count
  completed =
    state.status === "completed" &&
    !!version.plan &&
    attempts.length === 2 &&
    attempts[1].status === "succeeded"
  result = {
    completed,
    taskId,
    database: admission.database,
    directory,
    state,
    attempts,
    version,
    requests,
    actions,
    ownerConsent:
      "Explicit additional single request accepted 2026-10-26; source user reply preserved in task event",
    previousUnknownPreserved: true,
    scope:
      "One owner-authorized retry of the SAME original C1 compilation Task; original unknown attempt retained, no automatic second retry, no execution/ready certification claim",
  }
  assert.equal(actions, 0)
} finally {
  for (const job of jobs)
    if (job.child.pid && job.child.exitCode === null)
      process.kill(-job.child.pid, "SIGTERM")
  await Promise.all(jobs.map((job) => job.done))
  await closeDurableClient()
  await pool.end()
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  })
  await writeFile(
    "docs/evidence/workflow-compilation-authorized-retry.json",
    JSON.stringify(result, null, 2)
  )
}
console.log(JSON.stringify({ completed, taskId, directory }))
