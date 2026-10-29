import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// Native desktop acceptance with a controlled C1 candidate. This performs real
// new GUI actions and fixed host checks; it makes no model/API requests.
process.loadEnvFile(".env")
const candidate = JSON.parse(
  await readFile("docs/evidence/workflow-compilation-controlled.json", "utf8")
)
assert(candidate.passed && candidate.controlledProvider)
const sourceDatabase = path.basename(candidate.directory)
assert(/^agent_compile_[a-f0-9]+$/.test(sourceDatabase))
const database = `agent_flowrun_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${sourceDatabase}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17137",
  WORKER_PORT: "17138",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const checks: Record<string, unknown>[] = []
const results: Record<string, unknown>[] = []
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
let worker: (typeof jobs)[number] | undefined
let passed = false

function start(args: string[], name: string) {
  const child = spawn(process.execPath, args, { detached: true, env: process.env })
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
  jobs.push(job)
  return job
}
async function until<T>(
  read: () => Promise<T | null>,
  description: string,
  ms = 180000
): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const result = await read()
    if (result !== null) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${description}`)
}
async function startWorker() {
  worker = start(["--import", "tsx", "worker/main.ts"], `worker-${jobs.length}`)
  await until(async () => {
    assert.equal(worker!.child.exitCode, null, worker!.output())
    return worker!.output().includes("Worker ready") ? true : null
  }, "isolated worker ready")
}

try {
  const migration = start(["--import", "tsx", "scripts/migrate.ts"], "migrate")
  await migration.done
  assert.equal(migration.child.exitCode, 0)
  const { pool } = await import("@/db")
  const { submitTask } = await import("@/lib/tasks")
  const { getWorkflowVersion } = await import("@/lib/workflows")
  const { closeDurableClient } = await import("@/lib/durable")
  try {
    const source = (
      await pool.query("SELECT * FROM tasks WHERE id=$1", [candidate.taskId])
    ).rows[0]
    const versionId = candidate.version.id
    const agent = randomUUID()
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Workflow Runner','Deterministic native desktop execution','',NULL,$2,now(),now())",
      [agent, randomUUID()]
    )
    // Prove a ready method runs without a configured provider, even at a zero model budget.
    await pool.query(
      "DELETE FROM settings WHERE key LIKE 'provider.%' OR key='model.default'"
    )
    const makeInput = (index: number, purpose: "verify" | "run") => ({
      agentId: agent,
      goal: `CUA流程新任务 ${index}`,
      clientRequestId: randomUUID(),
      workflowExecution: {
        versionId,
        purpose,
        parameters: {
          parentName: `PA-C2-${index}-${Date.now()}`,
          draftName: ["Incoming-A", "Work in progress", "待处理", "Input-four"][index],
          readyName: ["Finished-A", "Ready with spaces", "已完成", "Final-four"][index],
        },
        maxActions: 120,
        maxDurationSeconds: 300,
      },
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 1, maxCostMicros: 0 },
    })
    await assert.rejects(
      () => submitTask(source.owner_id, "c2-verify", makeInput(0, "run")),
      /not passed independent/
    )
    await assert.rejects(
      () => submitTask("different-owner", "c2-verify", makeInput(0, "verify")),
      /not found/
    )
    const foreign = makeInput(0, "verify")
    await assert.rejects(
      () =>
        submitTask(source.owner_id, "c2-verify", {
          ...foreign,
          workflowExecution: {
            ...foreign.workflowExecution,
            parameters: { ...foreign.workflowExecution.parameters, extra: "x" },
          },
        }),
      /exactly the declared/
    )
    checks.push({
      check: "candidate run/owner/parameter boundaries and immutable completion contract",
      passed: true,
    })
    await startWorker()
    for (let index = 0; index < 4; index++) {
      if (index === 1)
        await pool.query(`
        CREATE FUNCTION c2_hold_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.type='workflow_step' AND NEW.payload->>'nextStep'='3' THEN PERFORM pg_sleep(60); END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER c2_hold_checkpoint BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION c2_hold_checkpoint();`)
      const input = makeInput(index, index < 3 ? "verify" : "run")
      const admission = await submitTask(source.owner_id, "c2-verify", input)
      assert((await submitTask(source.owner_id, "c2-verify", input)).reused)
      await writeFile(
        path.join(directory, `admission-${index}.json`),
        JSON.stringify(
          { taskId: admission.taskId, input, installId: process.env.INSTALL_ID },
          null,
          2
        )
      )
      if (index === 1) {
        const held = await until(
          async () =>
            (
              await pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep' AND pid<>pg_backend_pid()"
              )
            ).rows[0] ?? null,
          "actual input receipt before workflow checkpoint"
        )
        const typed = (
          await pool.query(
            "SELECT status FROM task_actions WHERE task_id=$1 AND kind='key_type'",
            [admission.taskId]
          )
        ).rows
        assert.equal(typed.length, 1)
        assert.equal(typed[0].status, "succeeded")
        process.kill(-worker!.child.pid!, "SIGKILL")
        await worker!.done
        await pool.query("SELECT pg_terminate_backend($1)", [held.pid])
        await pool.query(
          "DROP TRIGGER c2_hold_checkpoint ON task_events; DROP FUNCTION c2_hold_checkpoint()"
        )
        await startWorker()
        checks.push({
          check:
            "SIGKILL after real key_type receipt and before workflow checkpoint; original input identity recovered",
          taskId: admission.taskId,
          passed: true,
        })
      }
      const state = await until(
        async () => {
          const row = (
            await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [
              admission.taskId,
            ])
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
        `workflow task ${index} terminal or human request`,
        360000
      )
      const actions = (
        await pool.query(
          "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
          [admission.taskId]
        )
      ).rows
      for (const action of actions)
        if (action.receipt?.output?.image) {
          if (action.kind === "screen_share")
            await writeFile(
              path.join(directory, `task-${index}-final.jpg`),
              Buffer.from(action.receipt.output.image, "base64")
            )
          delete action.receipt.output.image
        }
      const run = (
        await pool.query(
          "SELECT checkpoint,environment,started_at,completed_at FROM task_workflow_runs WHERE task_id=$1",
          [admission.taskId]
        )
      ).rows[0]
      const requests = (
        await pool.query(
          "SELECT kind,status,payload FROM task_requests WHERE task_id=$1",
          [admission.taskId]
        )
      ).rows
      results.push({ taskId: admission.taskId, input, state, run, actions, requests })
      await writeFile(
        path.join(directory, `task-${index}.json`),
        JSON.stringify(results.at(-1), null, 2)
      )
      assert.equal(state.status, "completed", JSON.stringify({ state, requests }))
      assert.equal(state.result.directoryTree.grade, "program_checked")
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=$1",
            [admission.taskId]
          )
        ).rows[0].count,
        0
      )
      assert(
        actions.every((action) =>
          [
            "desktop_open_application",
            "screen_capture",
            "screen_share",
            "key_press",
            "key_type",
          ].includes(action.kind)
        )
      )
      assert.equal(
        actions.filter(
          (action) =>
            action.kind === "key_type" &&
            action.input.text === input.workflowExecution.parameters.parentName
        ).length,
        1,
        "Known parent typing must never repeat after checkpoint interruption"
      )
      const version = await getWorkflowVersion(source.owner_id, versionId)
      assert.equal(version.status, index < 2 ? "verifying" : "ready")
      checks.push({
        check: `new GUI-only task ${index + 1}: changed names/path and independent host directory check`,
        taskId: admission.taskId,
        actions: actions.length,
        purpose: input.workflowExecution.purpose,
        passed: true,
      })
    }
    const version = await getWorkflowVersion(source.owner_id, versionId)
    assert(
      version.validatedEnvironment &&
        version.validatedEnvironment.workstationImageId !==
          version.environment!.workstationImageId
    )
    checks.push({
      check:
        "three distinct checked samples certified the exact execution image separately from the historical source image; fourth task ran ready version",
      passed: true,
    })
    passed = true
  } finally {
    if (worker?.child.pid && worker.child.exitCode === null)
      process.kill(-worker.child.pid, "SIGTERM")
    await Promise.all(jobs.map((job) => job.done))
    await closeDurableClient()
    await pool.end()
  }
} finally {
  const evidence = {
    passed,
    scope:
      "C2 real native desktop execution of a controlled C1 candidate; no cloud compilation, general GUI reliability, control-boundary acceptance or OwnDesk comparison claim",
    database,
    directory,
    checks,
    results,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-execution-core.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, tasks: results.length }))
