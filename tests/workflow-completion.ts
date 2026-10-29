import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_flowcert_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${core.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
const { pool, db } = await import("@/db")
const { tasks } = await import("@/db/schema")
const { eq } = await import("drizzle-orm")
const { completeWorkflowRun, authorizeWorkflowDispatch } =
  await import("@/worker/workflow-execution")
const client = await pool.connect()
let passed = false
const checks: string[] = []
try {
  await client.query("BEGIN")
  const [task] = await db.select().from(tasks).where(eq(tasks.id, core.results[0].taskId))
  const execution = task.configSnapshot.workflowExecution!
  assert(
    "rejected" in
      (await authorizeWorkflowDispatch(
        {
          ...task,
          configSnapshot: {
            ...task.configSnapshot,
            workflowExecution: { ...execution, maxDurationSeconds: 10 },
          },
        },
        1
      )),
    "A cached old decision cannot dispatch after its original wall-time deadline"
  )
  assert(
    "rejected" in
      (await authorizeWorkflowDispatch(
        {
          ...task,
          configSnapshot: {
            ...task.configSnapshot,
            workflowExecution: {
              ...execution,
              maxDurationSeconds: Number.MAX_SAFE_INTEGER,
            },
          },
        },
        execution.maxActions + 1
      )),
    "The dispatch boundary enforces the frozen action allowance"
  )
  checks.push(
    "Original executeAction dispatch authorizer rejects expired cached decisions and over-limit inputs before sending"
  )
  const original = (
    await client.query("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0].checkpoint
  await client.query(
    "UPDATE workflow_versions SET status='verifying',validated_environment=NULL WHERE id=$1",
    [execution.versionId]
  )
  await client.query(
    "UPDATE task_workflow_runs SET checkpoint=jsonb_set(checkpoint,'{step}','0'::jsonb) WHERE task_id=$1",
    [task.id]
  )
  await completeWorkflowRun(client, task)
  assert.equal(
    (
      await client.query("SELECT status FROM workflow_versions WHERE id=$1", [
        execution.versionId,
      ])
    ).rows[0].status,
    "verifying"
  )
  checks.push(
    "Completing an early/manual result check does not count as a full execution sample or throw during completion"
  )
  await client.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
    task.id,
    JSON.stringify(original),
  ])
  await client.query(
    "UPDATE task_actions SET status='unknown' WHERE task_id=$1 AND action_no=1",
    [task.id]
  )
  await completeWorkflowRun(client, task)
  assert.equal(
    (
      await client.query("SELECT status FROM workflow_versions WHERE id=$1", [
        execution.versionId,
      ])
    ).rows[0].status,
    "verifying"
  )
  checks.push(
    "A fixed result with an unresolved action receipt does not certify the version"
  )
  await client.query(
    "UPDATE task_actions SET status='succeeded' WHERE task_id=$1 AND action_no=1",
    [task.id]
  )
  await completeWorkflowRun(client, task)
  assert.equal(
    (
      await client.query("SELECT status FROM workflow_versions WHERE id=$1", [
        execution.versionId,
      ])
    ).rows[0].status,
    "ready"
  )
  checks.push(
    "Three distinct complete checked traces on the same actual image certify the immutable version"
  )
  passed = true
} finally {
  await client.query("ROLLBACK")
  client.release()
  await pool.end()
  const evidence = {
    passed,
    scope:
      "C2 certification transaction checks using synthetic checkpoint/receipt mutations of retained real samples; not new GUI tasks",
    database,
    directory,
    checks,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-execution-certification.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
