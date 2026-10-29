import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// Transaction-only imported-origin/repair compatibility checks. Every mutation
// rolls back; these are not new GUI Tasks or real model repair evidence.
process.loadEnvFile(".env")
const sharing = JSON.parse(await readFile("docs/evidence/workflow-sharing.json", "utf8"))
assert(sharing.passed && /^agent_flowshare_[a-f0-9]+$/.test(sharing.database))
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${sharing.database}`
Object.assign(process.env, { DATABASE_URL: url.toString() })
const { pool, db } = await import("@/db")
const { tasks } = await import("@/db/schema")
const { eq } = await import("drizzle-orm")
const { freezeWorkflowExecution } = await import("@/lib/workflows")
const { completeWorkflowRun } = await import("@/worker/workflow-execution")
const checks: string[] = []
let passed = false
try {
  const source = (
    await pool.query("SELECT * FROM workflow_versions WHERE id=$1", [sharing.versionId])
  ).rows[0]
  const owner = source.owner_id
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, sharing.taskIds.at(-1)))
  const before = (
    await pool.query("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0].checkpoint
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SAVEPOINT no_origin")
    await assert.rejects(
      () =>
        client.query(
          "INSERT INTO workflow_versions(id,workflow_id,revision,owner_id,name,status,created_at,updated_at) VALUES($1,$2,1,$3,'Invalid origin','draft',now(),now())",
          [randomUUID(), randomUUID(), owner]
        ),
      (error: { code?: string; constraint?: string }) =>
        error.code === "23514" && error.constraint === "workflow_versions_origin_check"
    )
    await client.query("ROLLBACK TO SAVEPOINT no_origin")
    checks.push(
      "SQL origin constraint rejects source-less records without an imported package"
    )
    const step = 1
    const repair = {
      status: "accepted",
      decisionNo: 1,
      step,
      cursor: 1,
      observationActionNo: 1,
      epoch: 1,
      bootId: before.bootId,
      failure: "Synthetic provenance transaction",
      steps: [task.configSnapshot.workflowExecution!.plan.steps[step]],
    }
    await client.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
      task.id,
      JSON.stringify({ ...before, repair }),
    ])
    await completeWorkflowRun(client, task)
    const draftId = `${task.id}-workflow-revision`
    const draft = (
      await client.query("SELECT * FROM workflow_versions WHERE id=$1", [draftId])
    ).rows[0]
    assert.equal(draft.status, "draft")
    assert.equal(draft.source_task_id, null)
    assert.equal(draft.compilation_task_id, task.id)
    assert.equal(draft.import_request_id, null)
    assert.equal(draft.validated_environment, null)
    assert.deepEqual(draft.imported_package, source.imported_package)
    assert.equal(draft.plan.sourceTaskId, null)
    assert.deepEqual(draft.plan.repairOrigin, {
      versionId: sharing.versionId,
      taskId: task.id,
      step,
    })
    const execution = await freezeWorkflowExecution(client, owner, {
      versionId: draftId,
      purpose: "verify",
      parameters: Object.fromEntries(
        source.plan.parameters.map((parameter: { name: string }, index: number) => [
          parameter.name,
          `Provenance-${index}`,
        ])
      ),
      maxActions: 120,
      maxDurationSeconds: 300,
    })
    assert.equal(execution.execution.validatedEnvironment, null)
    assert.equal(
      (await client.query("SELECT status FROM workflow_versions WHERE id=$1", [draftId]))
        .rows[0].status,
      "verifying"
    )
    assert.deepEqual(
      (
        await client.query("SELECT * FROM workflow_versions WHERE id=$1", [
          sharing.versionId,
        ])
      ).rows[0],
      source
    )
    checks.push(
      "Repaired imported version preserves external provenance, references the local repair Task, starts unverified and can explicitly enter independent verification"
    )
  } finally {
    await client.query("ROLLBACK")
    client.release()
  }
  assert.deepEqual(
    (
      await pool.query("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
        task.id,
      ])
    ).rows[0].checkpoint,
    before
  )
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM workflow_versions")).rows[0]
      .count,
    1
  )
  checks.push(
    "All synthetic changes rolled back; original ready version, checkpoints and four real Tasks remain unchanged"
  )
  passed = true
} finally {
  await pool.end()
  const evidence = {
    passed,
    database: sharing.database,
    checks,
    scope:
      "Synthetic rollback-only SQL provenance and imported repair persistence compatibility; no new Task, GUI action, model call or real repair quality claim",
  }
  await writeFile(
    path.join(sharing.directory, "provenance.json"),
    JSON.stringify(evidence, null, 2)
  )
  if (passed)
    await writeFile(
      "docs/evidence/workflow-sharing-provenance.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, checks: checks.length }))
