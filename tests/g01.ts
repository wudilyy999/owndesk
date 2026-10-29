import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

if (existsSync(".env")) process.loadEnvFile(".env")
const baseUrl = new URL(process.env.DATABASE_URL!)
const database = `agent_g01_${randomUUID().replaceAll("-", "")}`
const runDir = path.resolve("data/experiments", database)
await mkdir(runDir, { recursive: true })
const admin = new pg.Client({ connectionString: baseUrl.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
baseUrl.pathname = `/${database}`
process.env.DATABASE_URL = baseUrl.toString()
process.env.ARTIFACT_DIR = path.join(runDir, "artifacts")
process.env.WORKER_PORT = "16898"
const results: { check: string; passed: boolean; detail: unknown }[] = []
let worker: ChildProcess | undefined
let round = 0
let succeeded = false

async function run(command: string[], log: string) {
  const child = spawn(command[0], command.slice(1), { env: process.env })
  let output = ""
  child.stdout!.on("data", (data) => {
    output += data
  })
  child.stderr!.on("data", (data) => {
    output += data
  })
  const [code] = await once(child, "exit")
  await writeFile(path.join(runDir, log), output)
  assert.equal(code, 0, output)
}

async function until<T>(
  predicate: () => Promise<T | undefined | false>,
  name: string,
  timeout = 45000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${name}`)
}

async function startWorker() {
  let output = ""
  const log = path.join(runDir, `worker-${++round}.log`)
  worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: process.env,
    detached: true,
  })
  worker.stdout!.on("data", (data) => {
    output += data
  })
  worker.stderr!.on("data", (data) => {
    output += data
  })
  await until(async () => {
    if (worker!.exitCode !== null) throw new Error(output)
    return output.includes("Worker ready")
  }, "worker ready")
  worker.once("exit", () => {
    void writeFile(log, output).catch((error) =>
      console.error("Failed to save worker experiment log", error)
    )
  })
}

async function stopWorker(signal: NodeJS.Signals) {
  assert(worker?.pid)
  const stopped = once(worker, "exit")
  process.kill(-worker.pid, signal)
  await stopped
  worker = undefined
}

try {
  await run([process.execPath, "--import", "tsx", "scripts/migrate.ts"], "migration.log")
  const { pool } = await import("@/db")
  const { submitTask, getTask } = await import("@/lib/tasks")
  const {
    durableClient,
    closeDurableClient,
    TASK_QUEUE,
    TASK_WORKFLOW,
    APPLICATION_VERSION,
  } = await import("@/lib/durable")
  try {
    const agentId = randomUUID()
    await pool.query(
      "INSERT INTO agents(id,name,role,model,glyph,created_at,updated_at) VALUES($1,'G01','Experiment','fixture/durable-report','test',now(),now())",
      [agentId]
    )
    await startWorker()
    const durable = await durableClient()

    const input = {
      agentId,
      goal: "G01 same-request experiment",
      clientRequestId: "deduplicate",
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 40 },
    }
    const submissions = await Promise.all(
      Array.from({ length: 12 }, () => submitTask("test-owner", "test", input))
    )
    assert.equal(new Set(submissions.map((r) => r.taskId)).size, 1)
    assert.equal(submissions.filter((r) => !r.reused).length, 1)
    await assert.rejects(
      submitTask("test-owner", "test", { ...input, goal: "Conflicting payload" }),
      { status: 409 }
    )
    const firstId = submissions[0].taskId
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM dbos.workflow_status WHERE workflow_uuid=$1",
      [`${firstId}:1`]
    )
    assert.equal(count.rows[0].n, 1)
    results.push({
      check: "12 concurrent submissions + conflicting payload",
      passed: true,
      detail: { taskId: firstId, workflows: 1 },
    })

    const rollbackId = randomUUID()
    const tx = await pool.connect()
    try {
      await tx.query("BEGIN")
      await tx.query(
        `INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,active_segment,completion_contract,config_snapshot,budget,next_event_seq,created_at,updated_at)
        SELECT $1,owner_id,agent_id,source,'rolled-back',request_payload,goal,'queued',1,completion_contract,config_snapshot,budget,0,now(),now() FROM tasks WHERE id=$2`,
        [rollbackId, firstId]
      )
      await durable.enqueueInTransaction(
        tx,
        {
          queueName: TASK_QUEUE,
          workflowName: TASK_WORKFLOW,
          workflowID: `${rollbackId}:1`,
          queuePartitionKey: agentId,
          appVersion: APPLICATION_VERSION,
        },
        rollbackId,
        1
      )
      await tx.query("ROLLBACK")
    } finally {
      tx.release()
    }
    assert.equal(
      (await pool.query("SELECT 1 FROM tasks WHERE id=$1", [rollbackId])).rowCount,
      0
    )
    assert.equal(await durable.retrieveWorkflow(`${rollbackId}:1`).getStatus(), null)
    results.push({
      check: "Business insert and DBOS enqueue roll back together",
      passed: true,
      detail: { taskId: rollbackId },
    })

    for (const checkpoint of ["fixture-prepare", "fixture-materialize"]) {
      const taskId =
        checkpoint === "fixture-prepare"
          ? firstId
          : (
              await submitTask("test-owner", "test", {
                ...input,
                clientRequestId: checkpoint,
              })
            ).taskId
      const workflowId = `${taskId}:1`
      await until(
        async () =>
          (await durable.listWorkflowSteps(workflowId))?.some(
            (s) => s.name === checkpoint && s.completedAtEpochMs
          ),
        checkpoint
      )
      await stopWorker("SIGKILL")
      const before = (await durable.listWorkflowSteps(workflowId))!.map((s) => ({
        name: s.name,
        completed: !!s.completedAtEpochMs,
      }))
      await startWorker()
      await until(async () => {
        const task = await getTask("test-owner", taskId)
        if (task.status === "failed") throw new Error(task.error!)
        return task.status === "completed" ? task : undefined
      }, "recovered task completion")
      const task = await getTask("test-owner", taskId)
      assert.equal(task.artifacts.length, 1)
      assert.equal(task.artifacts[0].verification.grade, "program_checked")
      const calls: string[] = (
        await readFile(
          path.join(
            process.env.ARTIFACT_DIR!,
            ".experiments",
            taskId,
            "invocations.ndjson"
          ),
          "utf8"
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).step)
      assert.deepEqual(calls, ["prepare", "materialize", "verify"])
      const events = await pool.query(
        "SELECT seq FROM task_events WHERE task_id=$1 ORDER BY seq",
        [taskId]
      )
      assert.deepEqual(
        events.rows.map((e) => e.seq),
        [1, 2, 3, 4]
      )
      results.push({
        check: `SIGKILL after ${checkpoint}; resume from checkpoints`,
        passed: true,
        detail: { taskId, before, callbackInvocations: calls, artifactCount: 1 },
      })
    }
    await stopWorker("SIGTERM")
    succeeded = true
  } finally {
    if (worker) await stopWorker("SIGKILL")
    await closeDurableClient()
    await pool.end()
  }
} finally {
  await writeFile(
    path.join(runDir, "result.json"),
    JSON.stringify(
      {
        passed: succeeded,
        fixtureOnly: true,
        database,
        results,
        recordedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  )
  if (succeeded) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
  await admin.end()
  console.log(JSON.stringify({ passed: succeeded, results, evidence: runDir }, null, 2))
}
