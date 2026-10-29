import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

// Synthetic certification mutations of retained real samples, no new GUI tasks.
process.loadEnvFile(".env")
const source = JSON.parse(await readFile("docs/evidence/workflow-repair.json", "utf8"))
assert(source.passed && /^agent_flowrepair_[a-f0-9]+$/.test(source.database))
const database = `agent_repaircert_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${source.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
const { pool, db } = await import("@/db")
const { tasks } = await import("@/db/schema")
const { eq } = await import("drizzle-orm")
const { completeWorkflowRun } = await import("@/worker/workflow-execution")
const client = await pool.connect()
const checks: string[] = []
let passed = false
try {
  await client.query("BEGIN")
  const repairedId = source.results[0].taskId
  const [repaired] = await db.select().from(tasks).where(eq(tasks.id, repairedId))
  const versionId = repaired.configSnapshot.workflowExecution!.versionId
  const samples = (
    await client.query<{ task_id: string }>(
      "SELECT task_id FROM task_workflow_runs WHERE version_id=$1 AND purpose='verify' AND completed_at IS NOT NULL ORDER BY completed_at",
      [versionId]
    )
  ).rows
  assert.equal(samples.length, 3)
  const [normal] = await db.select().from(tasks).where(eq(tasks.id, samples[1].task_id))
  await client.query(
    "UPDATE workflow_versions SET status='verifying',validated_environment=NULL WHERE id=$1",
    [versionId]
  )
  await client.query(
    "UPDATE task_workflow_runs SET checkpoint=jsonb_set(checkpoint,'{repair}','{\"status\":\"rejected\"}'::jsonb) WHERE task_id=$1",
    [samples[0].task_id]
  )
  await completeWorkflowRun(client, normal)
  assert.equal(
    (await client.query("SELECT status FROM workflow_versions WHERE id=$1", [versionId]))
      .rows[0].status,
    "verifying"
  )
  checks.push(
    "a fixed checked result whose execution required repair cannot certify the unchanged original method"
  )
  await client.query(
    "UPDATE task_workflow_runs SET checkpoint=checkpoint-'repair' WHERE task_id=$1",
    [samples[0].task_id]
  )
  await completeWorkflowRun(client, normal)
  assert.equal(
    (await client.query("SELECT status FROM workflow_versions WHERE id=$1", [versionId]))
      .rows[0].status,
    "ready"
  )
  checks.push(
    "three original complete distinct unmodified samples still certify normally"
  )
  const draftCount = (
    await client.query(
      "SELECT count(*)::int AS count FROM workflow_versions WHERE compilation_task_id=$1",
      [repaired.id]
    )
  ).rows[0].count
  await completeWorkflowRun(client, repaired)
  await completeWorkflowRun(client, repaired)
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM workflow_versions WHERE compilation_task_id=$1",
        [repaired.id]
      )
    ).rows[0].count,
    draftCount
  )
  checks.push(
    "completion replay of a checked repaired task retains one draft revision and one event"
  )
  const draftId = `${repaired.id}-workflow-revision`
  await client.query("DELETE FROM task_workflow_runs WHERE version_id=$1", [draftId])
  await client.query("DELETE FROM workflow_versions WHERE id=$1", [draftId])
  await client.query(
    "UPDATE task_actions SET status='unknown' WHERE task_id=$1 AND action_no=1",
    [repaired.id]
  )
  await completeWorkflowRun(client, repaired)
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM workflow_versions WHERE id=$1",
        [draftId]
      )
    ).rows[0].count,
    0
  )
  checks.push(
    "even a fully checked repaired result cannot generate a new draft while an action outcome is unknown"
  )
  passed = true
} finally {
  await client.query("ROLLBACK")
  client.release()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    checks,
    scope:
      "C3 synthetic certification/completion transaction mutations of retained real GUI evidence; zero additional GUI tasks or model calls",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-repair-certification.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
