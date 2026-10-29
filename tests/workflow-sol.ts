import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// Explicit owner-authorized model switch. Existing snapshots/unknown attempts
// remain immutable. Resume reads the saved Task; a new billed attempt needs its
// own explicit single-retry authorization.
assert(
  (process.argv[2] === "--owner-approved-sol" && process.argv.length === 3) ||
    (["--resume", "--owner-approved-single-retry"].includes(process.argv[2]) &&
      process.argv.length === 4),
  "Use --owner-approved-sol, --resume DIRECTORY, or --owner-approved-single-retry DIRECTORY"
)
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const original = JSON.parse(
  await readFile(
    "data/experiments/agent_compile_89b32692f49640c5b7887bb19091d06f/admission.json",
    "utf8"
  )
)
const mainUrl = new URL(process.env.DATABASE_URL!)
const main = new pg.Client({ connectionString: mainUrl.toString() })
await main.connect()
const providerRows = (
  await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
    ["provider.openai.apiKey", "provider.openai.baseUrl", "pricing.custom"],
  ])
).rows
assert(providerRows.some((r) => r.key === "provider.openai.apiKey"))
const directory =
  process.argv[2] !== "--owner-approved-sol"
    ? path.resolve(process.argv[3])
    : path.resolve("data/experiments", original.database, `sol-${Date.now()}`)
await mkdir(directory, { recursive: true, mode: 0o700 })
const savedPath = path.join(directory, "sol-admission.json")
const saved =
  process.argv[2] !== "--owner-approved-sol"
    ? JSON.parse(await readFile(savedPath, "utf8"))
    : null
const url = new URL(mainUrl)
url.pathname = `/${original.database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: original.installId,
  APP_URL: "http://127.0.0.1:17127",
  WORKER_PORT: "17128",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const { pool } = await import("@/db")
const { submitTask } = await import("@/lib/tasks")
const { requestCancellation, respondToRequest } = await import("@/lib/task-control")
const { appendEvent, appendEventInTransaction } = await import("@/lib/task-events")
const { getWorkflowVersion } = await import("@/lib/workflows")
const { readBenchmarkTask } = await import("@/lib/workflow-benchmark-db")
const { closeDurableClient } = await import("@/lib/durable")
const { stopInstallationWorkstations } = await import("@/lib/workstation")
const oldAttempts = (
  await pool.query(
    "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY attempt_no",
    [original.taskId]
  )
).rows
assert.equal(oldAttempts.length, 2)
assert(oldAttempts.every((a) => a.status === "unknown"))
const source = (
  await pool.query("SELECT * FROM tasks WHERE id=$1", [original.sourceTaskId])
).rows[0]
assert.equal(source.status, "completed")
const old = (
  await pool.query("SELECT request_payload FROM tasks WHERE id=$1", [original.taskId])
).rows[0]
let worker: ReturnType<typeof spawn> | undefined
let workerDone = Promise.resolve()
let output = ""
let taskId: string | undefined = saved?.taskId
const agentId: string = saved?.agentId ?? randomUUID()
const runs: { taskId: string; input: unknown; metrics?: unknown; state?: unknown }[] = []
let passed = false
let result: Record<string, unknown> = {}
let beforeRetry: Record<string, unknown>[] | undefined
async function until<T>(
  read: () => Promise<T | null>,
  message: string,
  ms = 300000
): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read()
    if (value !== null) return value
    if (worker)
      assert.equal(worker.exitCode, null, "Isolated worker exited; see worker log")
    await delay(150)
  }
  throw new Error(`Timed out: ${message}`)
}
const state = async (id: string) =>
  (await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])).rows[0]
const settled = (id: string) =>
  until(async () => {
    const row = await state(id)
    return ["completed", "failed", "cancelled", "needs_review", "waiting_user"].includes(
      row.status
    )
      ? row
      : null
  }, "Task completes or waits for owner")
try {
  if (!saved) {
    assert.equal(
      (
        await pool.query(
          "SELECT id FROM tasks WHERE source='c1-sol-switch' AND status NOT IN ('completed','cancelled','failed')"
        )
      ).rowCount,
      0,
      "Review the existing Sol Task; a fresh compilation must not bypass an unknown request"
    )
    await writeFile(
      path.join(directory, "before-sol.dump"),
      execFileSync(
        "docker",
        [
          "exec",
          "personal-agent-postgres-dev",
          "pg_dump",
          "-U",
          decodeURIComponent(mainUrl.username),
          "-Fc",
          "-d",
          original.database,
        ],
        { maxBuffer: 100000000 }
      ),
      { mode: 0o600 }
    )
    // Same project's existing encrypted settings; no plaintext key leaves storage.
    for (const row of providerRows)
      await pool.query(
        "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
        [row.key, row.value]
      )
    await appendEvent(original.taskId, "owner-consent:sol-switch", "owner_consent", {
      message: "你改用6.1sol完成任务",
      model: "openai/gpt-6.1-sol",
      preserveUnknownAttempts: 2,
      strategy:
        "Cancel the frozen Gemini Task; compile the same checked source in a separately frozen Sol Task",
    })
    await requestCancellation(source.owner_id, original.taskId)
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Sol Workflow','Compile and verify the checked Thunar workflow','','openai/gpt-6.1-sol',$2,now(),now())",
      [agentId, randomUUID()]
    )
  }
  worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: process.env,
    detached: true,
  })
  worker.stdout!.on("data", (chunk) => {
    output += chunk
  })
  worker.stderr!.on("data", (chunk) => {
    output += chunk
  })
  workerDone = once(worker, "exit").then(async () => {
    await writeFile(path.join(directory, `worker-${Date.now()}.log`), output, {
      mode: 0o600,
    })
  })
  await until(
    async () => (output.includes("Worker ready") ? true : null),
    "worker ready",
    60000
  )
  await until(
    async () => ((await state(original.taskId)).status === "cancelled" ? true : null),
    "original Gemini Task cancellation",
    60000
  )
  if (!saved) {
    const input = {
      ...old.request_payload,
      agentId,
      clientRequestId: randomUUID(),
      goal: "使用 GPT-6.1-Sol 提炼同一条已检查的 Thunar 轨迹",
      budget: { maxSteps: 3 },
    }
    taskId = (await submitTask(source.owner_id, "c1-sol-switch", input)).taskId
    await appendEvent(taskId, "model-switch-origin", "model_switch", {
      fromTaskId: original.taskId,
      sourceTaskId: source.id,
      fromModel: original.model,
      toModel: "openai/gpt-6.1-sol",
      ownerInstruction: "你改用6.1sol完成任务",
    })
    await writeFile(
      savedPath,
      JSON.stringify(
        {
          database: original.database,
          directory,
          taskId,
          agentId,
          installId: original.installId,
          input,
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  }
  assert(taskId)
  if (process.argv[2] === "--owner-approved-single-retry") {
    assert.equal((await state(taskId)).status, "needs_review")
    beforeRetry = (
      await pool.query(
        "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
        [taskId]
      )
    ).rows
    const request = (
      await pool.query(
        "SELECT id,payload_version,payload FROM task_requests WHERE task_id=$1 AND status='pending' AND payload->>'purpose'='execution_error'",
        [taskId]
      )
    ).rows[0]
    assert(request)
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND key='owner-consent:sol-single-retry'",
          [taskId]
        )
      ).rows[0].n,
      0,
      "This single-retry consent has already been used; resume without resending"
    )
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "UPDATE tasks SET budget=jsonb_set(budget,'{maxSteps}',$2::jsonb),updated_at=now() WHERE id=$1",
        [taskId, JSON.stringify(request.payload.decisionNo)]
      )
      await appendEventInTransaction(
        client,
        taskId,
        "owner-consent:sol-single-retry",
        "owner_consent",
        {
          message: "允许追加一次，接受可能增加的 API 费用",
          maxAdditionalRequests: 1,
          decisionNo: request.payload.decisionNo,
          preserveUnknownAttempts: true,
        }
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    await respondToRequest(
      source.owner_id,
      request.id,
      "continue",
      request.payload_version,
      {
        note: "允许追加一次，接受可能增加的 API 费用；原未知请求与费用保留。",
      }
    )
    await until(
      async () => {
        const attempts = (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_model_attempts WHERE task_id=$1",
            [taskId]
          )
        ).rows[0].n
        return attempts > beforeRetry!.length ? true : null
      },
      "single authorized model attempt starts",
      60000
    )
  }
  const compiled = await settled(taskId)
  const version = await getWorkflowVersion(source.owner_id, taskId)
  const compilationMetrics = await readBenchmarkTask(pool, taskId, "compilation")
  result = {
    database: original.database,
    directory,
    taskId,
    sourceTaskId: source.id,
    model: "openai/gpt-6.1-sol",
    controlledProvider: false,
    state: compiled,
    version,
    compilationMetrics,
    priorGeminiTaskId: original.taskId,
    oldUnknownPreserved: true,
  }
  await writeFile(
    path.join(directory, "compilation.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 }
  )
  assert.equal(
    compiled.status,
    "completed",
    JSON.stringify({ taskId, status: compiled.status, error: compiled.error })
  )
  assert(version.plan)
  assert.equal(compilationMetrics.model, "openai/gpt-6.1-sol")
  assert.equal(compilationMetrics.actions.length, 0)
  assert(
    compilationMetrics.attempts.length > 0 &&
      compilationMetrics.attempts.at(-1)!.status === "succeeded"
  )
  await writeFile(
    "docs/evidence/workflow-compilation-sol.json",
    JSON.stringify(
      {
        ...result,
        passed: true,
        scope:
          "Real Sol compilation from the same checked source, preserved Gemini unknown attempts; execution validation recorded separately",
      },
      null,
      2
    )
  )
  for (let index = 0; index < 4; index++) {
    const runPath = path.join(directory, `run-${index}-admission.json`)
    const input = existsSync(runPath)
      ? JSON.parse(await readFile(runPath, "utf8")).input
      : {
          agentId,
          goal: `真实Sol候选新参数验收 ${index + 1}`,
          clientRequestId: randomUUID(),
          workflowExecution: {
            versionId: taskId,
            purpose: index < 3 ? ("verify" as const) : ("run" as const),
            parameters: {
              parentName: `PA-Sol-${index}-${path.basename(directory)}`,
              draftName: ["Incoming-Sol", "Work in progress", "待处理", "Fourth-draft"][
                index
              ],
              readyName: ["Finished-Sol", "Ready with spaces", "已完成", "Fourth-ready"][
                index
              ],
            },
            maxActions: 160,
            maxDurationSeconds: 300,
          },
          completionContract: { requireHumanReview: false },
          budget: { maxSteps: 1, maxCostMicros: 0 },
        }
    // Stable source keys reuse original accepted Tasks after an interrupted test.
    await writeFile(runPath, JSON.stringify({ input }, null, 2), { mode: 0o600 })
    const admitted = await submitTask(source.owner_id, "c2-sol-verify", input)
    const run = { taskId: admitted.taskId, input } as (typeof runs)[number]
    runs.push(run)
    await writeFile(runPath, JSON.stringify(run, null, 2), { mode: 0o600 })
    run.state = await settled(run.taskId)
    run.metrics = await readBenchmarkTask(
      pool,
      run.taskId,
      index < 3 ? "validation" : "execution"
    )
    const current = await getWorkflowVersion(source.owner_id, taskId)
    await writeFile(
      path.join(directory, `run-${index}-result.json`),
      JSON.stringify({ run, versionStatus: current.status }, null, 2),
      { mode: 0o600 }
    )
    assert.equal(
      (run.state as { status: string }).status,
      "completed",
      JSON.stringify(run.state)
    )
    const metrics = run.metrics as Awaited<ReturnType<typeof readBenchmarkTask>>
    assert.equal(metrics.grade, "program_checked")
    assert.equal(metrics.attempts.length, 0)
    assert.equal(metrics.requests.length, 0)
    assert(
      metrics.actions.every(
        (a) =>
          a.status === "succeeded" &&
          [
            "desktop_open_application",
            "screen_capture",
            "screen_share",
            "key_press",
            "key_type",
          ].includes(a.kind)
      )
    )
    assert(
      index < 2
        ? ["verifying", "ready"].includes(current.status)
        : current.status === "ready"
    )
    const screenshot = (
      await pool.query(
        "SELECT receipt->'output'->>'image' AS image FROM task_actions WHERE task_id=$1 AND receipt->'output'->>'image' IS NOT NULL ORDER BY action_no DESC LIMIT 1",
        [run.taskId]
      )
    ).rows[0]
    assert(screenshot)
    await writeFile(
      path.join(directory, `run-${index}-final.jpg`),
      Buffer.from(screenshot.image, "base64"),
      { mode: 0o600 }
    )
  }
  result = {
    ...result,
    runs,
    finalVersion: await getWorkflowVersion(source.owner_id, taskId),
  }
  passed = true
} catch (error) {
  result = {
    ...result,
    taskId,
    directory,
    error: error instanceof Error ? error.message : String(error),
  }
  throw error
} finally {
  if (beforeRetry) {
    const attempts = (
      await pool.query(
        "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY decision_no,attempt_no",
        [taskId]
      )
    ).rows
    assert.deepEqual(attempts.slice(0, beforeRetry.length), beforeRetry)
    assert.equal(attempts.length, beforeRetry.length + 1)
  }
  assert.deepEqual(
    (
      await pool.query(
        "SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY attempt_no",
        [original.taskId]
      )
    ).rows,
    oldAttempts
  )
  assert.deepEqual(
    (await pool.query("SELECT * FROM tasks WHERE id=$1", [source.id])).rows[0],
    source
  )
  assert(originalEnv.equals(await readFile(".env")))
  assert.deepEqual(
    (
      await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
        ["provider.openai.apiKey", "provider.openai.baseUrl", "pricing.custom"],
      ])
    ).rows,
    providerRows
  )
  if (worker?.pid && worker.exitCode === null) {
    for (const run of runs)
      if (
        !["completed", "cancelled", "failed"].includes((await state(run.taskId)).status)
      ) {
        await requestCancellation(source.owner_id, run.taskId)
        await until(
          async () => ((await state(run.taskId)).status === "cancelled" ? true : null),
          "failed verification cancellation",
          60000
        )
      }
    await stopInstallationWorkstations()
    process.kill(-worker.pid, "SIGTERM")
  }
  await workerDone
  await closeDurableClient()
  await pool.end()
  await main.end()
  const evidence = {
    ...result,
    passed,
    runs,
    scope:
      "Target: owner-authorized Sol compilation, three native GUI parameter verification Tasks and one ready reuse. Actual state/runs and passed determine achieved scope; old Gemini attempts/source/main preserved, not full C4 or cloud/OwnDesk comparison",
  }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 }
  )
  await writeFile(
    "docs/evidence/workflow-sol-attempt.json",
    JSON.stringify(evidence, null, 2)
  )
  if (passed)
    await writeFile("docs/evidence/workflow-sol.json", JSON.stringify(evidence, null, 2))
}
console.log(JSON.stringify({ passed, taskId, directory, tasks: runs.length + 1 }))
