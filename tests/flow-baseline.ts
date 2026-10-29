import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile, appendFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// This command spends the owner's already-authorized model API budget.
// Keep its isolated database and all failures for compilation and cost accounting.
process.loadEnvFile(".env")
const model = process.env.PA_C0_MODEL ?? "custom/gemini-3.8-flash-high"
const coordinateMode = process.env.PA_C0_COORDINATE_MODE ?? "normalized_1000"
assert(["pixels", "normalized_1000"].includes(coordinateMode))
const provider = model.split("/")[0]
const database = `agent_flow_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const mainUrl = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: mainUrl.toString() })
await admin.connect()
const settings = (
  await admin.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
    [`provider.${provider}.apiKey`, `provider.${provider}.baseUrl`, "pricing.custom"],
  ])
).rows
assert(
  settings.some((row) => row.key === `provider.${provider}.baseUrl`),
  "Configure this project's provider before running a real-model baseline"
)
await admin.query(`CREATE DATABASE "${database}"`)
const isolatedUrl = new URL(mainUrl)
isolatedUrl.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: isolatedUrl.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17117",
  WORKER_PORT: "17118",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.1",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "flow@fixture.test",
  OWNER_PASSWORD: randomUUID(),
})
await admin.end()
let worker: ReturnType<typeof spawn> | undefined
let workerLog = Promise.resolve()
let passed = false
let taskId: string | undefined
let failure: string | undefined
let summary: Record<string, unknown> = {}

async function command(file: string) {
  const child = spawn(process.execPath, ["--import", "tsx", file], { env: process.env })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  const [code] = await once(child, "exit")
  await writeFile(path.join(directory, `${path.basename(file)}.log`), output)
  assert.equal(code, 0, `Command failed; see ${directory}/${path.basename(file)}.log`)
}

try {
  await command("scripts/migrate.ts")
  await command("scripts/owner.ts")
  const { pool } = await import("@/db")
  const { submitTask } = await import("@/lib/tasks")
  const { closeDurableClient } = await import("@/lib/durable")
  try {
    // Reuse this installation's encrypted provider records without exposing or rewriting its key.
    for (const row of settings)
      await pool.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())", [
        row.key,
        row.value,
      ])
    await pool.query(
      "INSERT INTO settings(key,value,updated_at) VALUES('agent.maxSteps','80',now())"
    )
    const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    const agent = (
      await pool.query(
        "UPDATE agents SET model=$1 WHERE name='OwnDesk Assistant' RETURNING id",
        [model]
      )
    ).rows[0].id
    worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
      env: process.env,
      detached: true,
    })
    let output = ""
    worker.stdout!.on("data", (chunk) => {
      output += chunk
    })
    worker.stderr!.on("data", (chunk) => {
      output += chunk
    })
    workerLog = once(worker, "exit").then(async () => {
      await writeFile(path.join(directory, "worker.log"), output)
    })
    for (let i = 0; !output.includes("Worker ready"); i++) {
      assert(worker.exitCode === null && i < 300, "Isolated worker failed to start")
      await delay(100)
    }
    const root = `/home/agent/Flow-C0-${Date.now()}`
    const result = await submitTask(owner, "c0-real-gui", {
      agentId: agent,
      desktopCoordinateMode: coordinateMode as "pixels" | "normalized_1000",
      clientRequestId: randomUUID(),
      goal: `Using the native desktop file manager, create the directory ${root}. Inside it create a folder named Draft, then rename Draft to Ready. All file modifications must use GUI actions. Use only screen_capture, screen_share, pointer_* and key_* for workstation operations; shell, fs_* and browser_* are outside this task's allowed channel. Show the final desktop and complete the task.`,
      completionContract: {
        requireHumanReview: false,
        directoryTree: { root, directories: ["Ready"], absent: ["Draft"] },
      },
      budget: { maxSteps: 80 },
    })
    taskId = result.taskId
    await writeFile(
      path.join(directory, "admission.json"),
      JSON.stringify(
        {
          database,
          taskId,
          agent,
          model,
          root,
          startedAt: new Date().toISOString(),
          supervisorHints: 0,
          operatorDesktopInputs: 0,
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ directory, taskId, model }))
    let state: any
    for (let i = 0; i < 1800; i++) {
      state = (
        await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
      ).rows[0]
      const requests = (
        await pool.query(
          "SELECT id,kind,payload FROM task_requests WHERE task_id=$1 AND status='pending'",
          [taskId]
        )
      ).rows
      const calls = (
        await pool.query(
          "SELECT count(*)::int AS n FROM task_model_attempts WHERE task_id=$1",
          [taskId]
        )
      ).rows[0].n
      if (i % 20 === 0)
        console.log(JSON.stringify({ status: state.status, modelAttempts: calls }))
      if (["completed", "failed", "cancelled"].includes(state.status)) break
      if (requests.length) {
        await writeFile(
          path.join(directory, "pending-requests.json"),
          JSON.stringify(requests, null, 2)
        )
        throw new Error(
          "Real model task requires review; no automatic reply, paid retry or supervisory hint was supplied"
        )
      }
      assert(worker.exitCode === null, "Isolated worker exited during the real task")
      await delay(1000)
    }
    const actions = (
      await pool.query(
        "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
        [taskId]
      )
    ).rows
    for (const action of actions) {
      if (action.receipt?.output?.image) {
        await writeFile(
          path.join(directory, `action-${action.action_no}-${action.kind}.jpg`),
          Buffer.from(action.receipt.output.image, "base64")
        )
        delete action.receipt.output.image
      }
    }
    const attempts = (
      await pool.query(
        "SELECT decision_no,attempt_no,status,cost_micros,model,error FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
        [taskId]
      )
    ).rows
    summary = {
      database,
      taskId,
      agent,
      model,
      root,
      status: state.status,
      result: state.result,
      error: state.error,
      actualActions: actions.length,
      attempts,
      actions,
      supervisorHints: 0,
      operatorDesktopInputs: 0,
    }
    assert.equal(state.status, "completed", state.error)
    assert.equal(state.result.directoryTree.grade, "program_checked")
    assert(
      actions.length > 0 &&
        actions.every((action) => /^(screen_|pointer_|key_)/.test(action.kind)),
      "GUI-only channel must be proved by all real actions"
    )
    assert(
      attempts.length > 0 && attempts.every((attempt) => attempt.status === "succeeded"),
      "Unknown requests remain unresolved and prevent acceptance"
    )
    passed = true
  } finally {
    if (taskId && !passed) {
      const state = (
        await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
      ).rows[0]
      const attempts = (
        await pool.query(
          "SELECT decision_no,attempt_no,status,cost_micros,model,error FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
          [taskId]
        )
      ).rows
      const actions = (
        await pool.query(
          "SELECT action_no,kind,status FROM task_actions WHERE task_id=$1 ORDER BY action_no",
          [taskId]
        )
      ).rows
      summary = { ...summary, database, taskId, model, state, attempts, actions }
    }
    if (worker?.pid && worker.exitCode === null) {
      process.kill(-worker.pid, "SIGTERM")
      await workerLog
    }
    await closeDurableClient()
    await pool.end()
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  const evidence = {
    passed,
    scope:
      "C0 unassisted real-model Thunar baseline; not workflow compilation or cross-input reuse",
    directory,
    failure,
    ...summary,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/flow-c0-baseline.json",
      JSON.stringify(evidence, null, 2)
    )
  await appendFile(path.join(directory, "closed.txt"), new Date().toISOString())
}
console.log(JSON.stringify({ passed, directory, taskId }))
