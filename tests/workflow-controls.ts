import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_flowcontrol_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${core.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  APP_URL: "http://127.0.0.1:17147",
  WORKER_PORT: "17148",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
let worker: ChildProcess | undefined
let workerDone = Promise.resolve()
const checks: Record<string, unknown>[] = []
const tasks: string[] = []
let passed = false
async function until<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== null) return result
    await delay(50)
  }
  throw new Error(`Timed out: ${message}`)
}
try {
  const { pool } = await import("@/db")
  const { submitTask } = await import("@/lib/tasks")
  const { requestCancellation, requestTakeover, respondToRequest } =
    await import("@/lib/task-control")
  const { closeDurableClient } = await import("@/lib/durable")
  const { docker, dockerRaw } = await import("@/lib/docker")
  try {
    const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
    const versionId = core.results[0].input.workflowExecution.versionId
    const agent = randomUUID()
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Workflow Control Lab','CUA control boundaries','',NULL,$2,now(),now())",
      [agent, randomUUID()]
    )
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
    workerDone = once(worker, "exit").then(async () => {
      await writeFile(path.join(directory, "worker.log"), output)
    })
    await until(async () => {
      assert.equal(worker!.exitCode, null, output)
      return output.includes("Worker ready") ? true : null
    }, "worker ready")
    async function submit(label: string, maxActions = 120, maxDurationSeconds = 300) {
      const input = {
        agentId: agent,
        goal: label,
        clientRequestId: randomUUID(),
        workflowExecution: {
          versionId,
          purpose: "run" as const,
          parameters: {
            parentName: `PA-C2-${label}-${Date.now()}`,
            draftName: "Draft-control",
            readyName: "Ready-control",
          },
          maxActions,
          maxDurationSeconds,
        },
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 1, maxCostMicros: 0 },
      }
      const result = await submitTask(owner, "c2-controls", input)
      tasks.push(result.taskId)
      return {
        id: result.taskId,
        root: `/home/agent/${input.workflowExecution.parameters.parentName}`,
        input,
      }
    }
    const state = async (id: string) =>
      (await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id]))
        .rows[0]
    const count = async (id: string) =>
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1",
          [id]
        )
      ).rows[0].count
    const workspace = async () =>
      (await pool.query("SELECT * FROM workstation_control WHERE agent_id=$1", [agent]))
        .rows[0]
    const pending = async (id: string) =>
      (
        await pool.query(
          "SELECT id,payload_version,payload FROM task_requests WHERE task_id=$1 AND status='pending' ORDER BY created_at",
          [id]
        )
      ).rows[0] ?? null

    const cancelled = await submit("cancel")
    await until(
      async () =>
        (
          await pool.query(
            "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='desktop_open_application' AND status='succeeded'",
            [cancelled.id]
          )
        ).rows[0] ?? null,
      "native application actually opened"
    )
    await requestCancellation(owner, cancelled.id)
    await until(
      async () => ((await state(cancelled.id)).status === "cancelled" ? true : null),
      "actual cancellation confirmed"
    )
    const quietCount = await count(cancelled.id)
    await delay(800)
    assert.equal(await count(cancelled.id), quietCount)
    const cancelledWorkspace = await workspace()
    const stopped = await dockerRaw([
      "inspect",
      "--format",
      "{{.State.Running}}",
      cancelledWorkspace.container_name,
    ])
    assert(stopped.exitCode !== 0 || stopped.stdout.toString().trim() === "false")
    checks.push({
      check:
        "real native action cancelled, workstation stopped/removed and action count stable",
      taskId: cancelled.id,
      passed: true,
    })

    const limited = await submit("limit", 1)
    const limitRequest = await until(
      async () => await pending(limited.id),
      "workflow hard action limit review"
    )
    assert.equal(await count(limited.id), 1)
    await respondToRequest(
      owner,
      limitRequest.id,
      "continue",
      limitRequest.payload_version,
      {}
    )
    const nextLimitRequest = await until(async () => {
      const request = await pending(limited.id)
      return request && request.id !== limitRequest.id ? request : null
    }, "continued limit check remains read-only")
    assert.equal(await count(limited.id), 1)
    assert.equal(nextLimitRequest.payload.purpose, "workflow_review")
    await requestCancellation(owner, limited.id)
    await until(
      async () => ((await state(limited.id)).status === "cancelled" ? true : null),
      "limited task cancelled"
    )
    checks.push({
      check:
        "one-action hard limit cannot be bypassed by zero model calls or Continue; no additional desktop input",
      taskId: limited.id,
      passed: true,
    })

    const timed = await submit("deadline", 120, 10)
    const timeRequest = await until(
      async () => await pending(timed.id),
      "actual workflow wall-time allowance"
    )
    assert.match(timeRequest.payload.reason, /allowance exhausted/)
    const timeActions = await count(timed.id)
    assert(timeActions > 1 && timeActions < 120)
    const started = (
      await pool.query("SELECT started_at FROM task_workflow_runs WHERE task_id=$1", [
        timed.id,
      ])
    ).rows[0].started_at
    assert(Date.now() - new Date(started).getTime() >= 10000)
    await delay(800)
    assert.equal(await count(timed.id), timeActions)
    await requestCancellation(owner, timed.id)
    await until(
      async () => ((await state(timed.id)).status === "cancelled" ? true : null),
      "time-limited task cancelled"
    )
    checks.push({
      check: "actual ten-second wall-time allowance stopped GUI input below action limit",
      taskId: timed.id,
      actions: timeActions,
      passed: true,
    })

    const human = await submit("handback")
    await until(
      async () =>
        (
          await pool.query(
            "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='desktop_open_application' AND status='succeeded'",
            [human.id]
          )
        ).rows[0] ?? null,
      "Thunar ready for owner takeover"
    )
    const takeover = await requestTakeover(
      human.id,
      "受控窗口移动后交还，文件修改全部继续由流程完成"
    )
    const humanWorkspace = await until(async () => {
      const row = await workspace()
      return row.mode === "human" ? row : null
    }, "human input control ready")
    const atHuman = await count(human.id)
    await delay(800)
    assert.equal(await count(human.id), atHuman)
    const windowId = (
      await docker(["exec", humanWorkspace.container_name, "xdotool", "getactivewindow"])
    ).stdout
      .toString()
      .trim()
    await docker([
      "exec",
      humanWorkspace.container_name,
      "xdotool",
      "windowmove",
      windowId,
      "123",
      "105",
    ])
    const request = (
      await pool.query("SELECT payload_version FROM task_requests WHERE id=$1", [
        takeover.requestId,
      ])
    ).rows[0]
    await respondToRequest(
      owner,
      takeover.requestId,
      "handback",
      request.payload_version,
      { note: "只移动窗口，没有修改任何文件；继续当前步骤。" }
    )
    const humanResult = await until(async () => {
      const row = await state(human.id)
      return ["completed", "needs_review", "failed"].includes(row.status) ? row : null
    }, "workflow completes after human handback")
    assert.equal(humanResult.status, "completed", JSON.stringify(humanResult))
    assert.equal(humanResult.result.directoryTree.grade, "program_checked")
    const epochs = (
      await pool.query("SELECT DISTINCT epoch FROM task_actions WHERE task_id=$1", [
        human.id,
      ])
    ).rows
    assert(epochs.length > 1)
    checks.push({
      check:
        "takeover stops automatic input; explicit handback/new epoch/window movement observed and same workflow finishes with host checks",
      taskId: human.id,
      passed: true,
    })

    const unknown = await submit("unknown")
    const changed = await until(async () => {
      const row = await workspace()
      const input = (
        await pool.query(
          "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='key_press' AND input->>'key'='enter' AND status='intent' ORDER BY action_no LIMIT 1",
          [unknown.id]
        )
      ).rows[0]
      if (!input) return null
      const exists = await dockerRaw([
        "exec",
        row.container_name,
        "test",
        "-d",
        unknown.root,
      ])
      return exists.exitCode === 0 ? { row, actionNo: input.action_no } : null
    }, "parent created by GUI Enter before its final input receipt")
    await docker(["restart", "--time", "0", changed.row.container_name], {
      timeoutMs: 45000,
    })
    const review = await until(
      async () => await pending(unknown.id),
      "lost input receipt requires review"
    )
    const unknownAction = (
      await pool.query(
        "SELECT status,kind,input FROM task_actions WHERE task_id=$1 AND action_no=$2",
        [unknown.id, changed.actionNo]
      )
    ).rows[0]
    assert.equal(unknownAction.status, "unknown")
    const uncertainCount = await count(unknown.id)
    await respondToRequest(owner, review.id, "continue", review.payload_version, {})
    const blocked = await until(async () => {
      const request = await pending(unknown.id)
      return request && request.id !== review.id ? request : null
    }, "unknown outcome stays at fixed result check")
    assert.equal(blocked.payload.purpose, "workflow_review")
    assert.equal(await count(unknown.id), uncertainCount)
    const currentRun = (
      await pool.query("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
        unknown.id,
      ])
    ).rows[0]
    assert.equal(currentRun.checkpoint.phase, "blocked")
    await requestCancellation(owner, unknown.id)
    await until(
      async () => ((await state(unknown.id)).status === "cancelled" ? true : null),
      "unknown-effect task cancelled without replay"
    )
    checks.push({
      check:
        "real GUI directory effect before controller/container restart; unknown receipt remains blocked after Continue, no input replay",
      taskId: unknown.id,
      actionNo: changed.actionNo,
      passed: true,
    })

    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=ANY($1::text[])",
          [tasks]
        )
      ).rows[0].count,
      0
    )
    assert.equal(tasks.length, 5)
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM tasks WHERE id=ANY($1::text[]) AND status='completed'",
          [tasks]
        )
      ).rows[0].count,
      1
    )
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM tasks WHERE id=ANY($1::text[]) AND status='cancelled'",
          [tasks]
        )
      ).rows[0].count,
      4
    )
    passed = true
  } finally {
    if (worker?.pid && worker.exitCode === null) process.kill(-worker.pid, "SIGTERM")
    await workerDone
    const rows = (
      await pool.query(
        "SELECT id,status,result,error FROM tasks WHERE id=ANY($1::text[]) ORDER BY created_at",
        [tasks]
      )
    ).rows
    await writeFile(path.join(directory, "tasks.json"), JSON.stringify(rows, null, 2))
    await closeDurableClient()
    await pool.end()
  }
} finally {
  const evidence = {
    passed,
    scope:
      "C2 native workflow cancellation, action limit, handback and real uncertain desktop effect; no model requests",
    database,
    directory,
    checks,
    tasks,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-execution-controls.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, tasks: tasks.length }))
