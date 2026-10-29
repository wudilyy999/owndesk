import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// Focused C3 in-flight model/control boundaries. All responses are local fixtures.
process.loadEnvFile(".env")
const source = JSON.parse(await readFile("docs/evidence/workflow-repair.json", "utf8"))
assert(source.passed && /^agent_flowrepair_[a-f0-9]+$/.test(source.database))
const database = `agent_repaircontrol_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${source.database}"`)
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
const pendingResponses: { send: () => void; context: Record<string, any> }[] = []
let providerFailure: string | null = null
const fixture = createServer((req, res) => {
  void (async () => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.tools.length, 1)
    assert.equal(body.tools[0].function.name, "submit_workflow_repair")
    const context = JSON.parse(
      body.messages.at(-1).content.find((part: any) => part.type === "text").text
    )
    const candidate = {
      reason: "Dismiss the extra modal and preserve the location shortcut",
      steps: [
        {
          id: "control-dismiss",
          label: "关闭意外弹窗",
          evidence: [],
          operation: "key_press",
          key: "escape",
          modifiers: [],
          when: { application: "Thunar", title: [{ literal: "Create New Folder" }] },
        },
        context.failedStep,
      ],
    }
    pendingResponses.push({
      context,
      send: () =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: randomUUID(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "workflow-repair-fixture",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "control-repair",
                      type: "function",
                      function: {
                        name: "submit_workflow_repair",
                        arguments: JSON.stringify(candidate),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
          })
        ),
    })
  })().catch((error) => {
    providerFailure = error.message
    res.writeHead(500).end("Controlled provider failed")
  })
})
fixture.listen(0, "127.0.0.1")
await once(fixture, "listening")
const address = fixture.address()
assert(address && typeof address !== "string")
const { pool } = await import("@/db")
const { submitTask } = await import("@/lib/tasks")
const { requestCancellation, requestTakeover, respondToRequest } =
  await import("@/lib/task-control")
const { closeDurableClient } = await import("@/lib/durable")
const { docker } = await import("@/lib/docker")
const { setSettings } = await import("@/lib/config")
const latch = await pool.connect()
const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
const agent = randomUUID()
const versionId = source.results[0].run.version_id
const taskIds: string[] = []
const checks: Record<string, unknown>[] = []
let passed = false
let output = ""
await setSettings([
  { key: "provider.custom.baseUrl", value: `http://127.0.0.1:${address.port}/v1` },
])
await pool.query(
  "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Repair Control Desktop','In-flight control boundaries','','custom/workflow-repair-fixture',$2,now(),now())",
  [agent, randomUUID()]
)
// The copied core test trigger has no locks in this new database. Only this
// native-action boundary is deliberately held while inserting the extra modal.
await pool.query(
  "DROP TRIGGER c3_hold_boundary ON task_events; DROP FUNCTION c3_hold_boundary()"
)
await pool.query(
  `CREATE FUNCTION repair_control_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='workflow_step' AND NEW.payload->>'nextStep'='4' AND NEW.payload->>'capture'='false' THEN PERFORM pg_advisory_xact_lock(20261026,311); END IF; RETURN NEW; END $$; CREATE TRIGGER repair_control_hold BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION repair_control_hold();`
)
const worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
  env: process.env,
  detached: true,
})
worker.stdout!.on("data", (chunk) => {
  output += chunk
})
worker.stderr!.on("data", (chunk) => {
  output += chunk
})
const workerDone = once(worker, "exit").then(async () => {
  await writeFile(path.join(directory, "worker.log"), output)
})
async function until<T>(read: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, output)
    assert.equal(providerFailure, null)
    const value = await read()
    if (value !== null) return value
    await delay(80)
  }
  throw new Error(`Timed out: ${description}`)
}
const state = async (id: string) =>
  (await pool.query("SELECT status FROM tasks WHERE id=$1", [id])).rows[0]
const count = async (id: string) =>
  (
    await pool.query("SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1", [
      id,
    ])
  ).rows[0].count
const pending = async (id: string) =>
  (
    await pool.query(
      "SELECT id,payload_version,payload FROM task_requests WHERE task_id=$1 AND status='pending' ORDER BY created_at",
      [id]
    )
  ).rows[0] ?? null
const workspace = async () =>
  (await pool.query("SELECT * FROM workstation_control WHERE agent_id=$1", [agent]))
    .rows[0]
async function submit(label: string, seconds = 300) {
  await latch.query("SELECT pg_advisory_lock(20261026,311)")
  const input = {
    agentId: agent,
    goal: `C3 control ${label}`,
    clientRequestId: randomUUID(),
    workflowExecution: {
      versionId,
      purpose: "run" as const,
      parameters: {
        parentName: `PA-C3-control-${label}-${Date.now()}`,
        draftName: "Draft",
        readyName: "Ready",
      },
      allowRepair: true,
      maxActions: 120,
      maxDurationSeconds: seconds,
    },
    completionContract: { requireHumanReview: false },
    budget: { maxSteps: 1 },
  }
  const admission = await submitTask(owner, "c3-controls", input)
  taskIds.push(admission.taskId)
  await writeFile(
    path.join(directory, `${label}-admission.json`),
    JSON.stringify({ ...admission, input, installId: process.env.INSTALL_ID }, null, 2)
  )
  await until(
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=20261026 AND objid=311"
        )
      ).rowCount
        ? true
        : null,
    "native parent-created boundary"
  )
  await docker([
    "exec",
    (await workspace()).container_name,
    "xdotool",
    "key",
    "ctrl+shift+n",
  ])
  await latch.query("SELECT pg_advisory_unlock(20261026,311)")
  await until(
    async () => (pendingResponses.length === taskIds.length ? true : null),
    "actual in-flight model request"
  )
  return admission.taskId
}
async function cancel(id: string) {
  await requestCancellation(owner, id)
  await until(
    async () => ((await state(id)).status === "cancelled" ? true : null),
    "actual cancellation"
  )
}
try {
  await until(async () => (output.includes("Worker ready") ? true : null), "worker ready")
  const human = await submit("handback")
  const beforeHuman = await count(human)
  const takeover = await requestTakeover(
    human,
    "受控测试：模型修订请求期间接管，再显式交还"
  )
  await until(
    async () => ((await workspace()).mode === "human" ? true : null),
    "human controls desktop during pending model"
  )
  pendingResponses[0].send()
  await until(
    async () =>
      (
        await pool.query("SELECT status FROM task_model_decisions WHERE task_id=$1", [
          human,
        ])
      ).rows[0]?.status === "succeeded"
        ? true
        : null,
    "late response saved under old control"
  )
  assert.equal(await count(human), beforeHuman)
  const handback = (
    await pool.query("SELECT payload_version FROM task_requests WHERE id=$1", [
      takeover.requestId,
    ])
  ).rows[0]
  await respondToRequest(
    owner,
    takeover.requestId,
    "handback",
    handback.payload_version,
    { note: "显式交还；旧修订候选应停止，由人复核。" }
  )
  const review = await until(
    async () => await pending(human),
    "old response rejected after handback"
  )
  assert.match(review.payload.reason, /Control|boot|old candidate/)
  assert.equal(pendingResponses.length, 1)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1 AND kind='key_press' AND input->>'key'='escape'",
        [human]
      )
    ).rows[0].count,
    0
  )
  await cancel(human)
  checks.push({
    check:
      "real takeover while model pending, late response and explicit handback discard old candidate without a second request or patch input",
    taskId: human,
    passed: true,
  })

  const timed = await submit("deadline", 60)
  const beforeDeadline = await count(timed)
  await until(
    async () =>
      Number(
        (
          await pool.query(
            "SELECT extract(epoch from clock_timestamp()-started_at) AS elapsed FROM task_workflow_runs WHERE task_id=$1",
            [timed]
          )
        ).rows[0].elapsed
      ) >= 61
        ? true
        : null,
    "frozen deadline expires while model request is in flight"
  )
  pendingResponses[1].send()
  const timedReview = await until(
    async () => await pending(timed),
    "late candidate cannot dispatch after deadline"
  )
  assert.match(timedReview.payload.reason, /allowance exhausted/)
  assert.equal(await count(timed), beforeDeadline)
  await cancel(timed)
  checks.push({
    check:
      "real wall-time deadline expires during model call; saved candidate never dispatches any additional GUI action",
    taskId: timed,
    passed: true,
  })

  const cancelled = await submit("cancel")
  const beforeCancel = await count(cancelled)
  await cancel(cancelled)
  pendingResponses[2].send()
  await delay(500)
  assert.equal(await count(cancelled), beforeCancel)
  assert.equal(
    (
      await pool.query("SELECT status FROM task_model_attempts WHERE task_id=$1", [
        cancelled,
      ])
    ).rows[0].status,
    "unknown"
  )
  checks.push({
    check:
      "cancellation aborts an actual pending repair call, stops desktop input and preserves the unknown attempt instead of replaying",
    taskId: cancelled,
    passed: true,
  })
  assert.equal(pendingResponses.length, 3)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM workflow_versions WHERE compilation_task_id=ANY($1::text[])",
        [taskIds]
      )
    ).rows[0].count,
    0
  )
  passed = true
} finally {
  await latch.query("SELECT pg_advisory_unlock_all()")
  latch.release()
  for (const id of taskIds)
    if (!["completed", "cancelled", "failed"].includes((await state(id)).status))
      await cancel(id)
  if (worker.pid && worker.exitCode === null) process.kill(-worker.pid, "SIGTERM")
  await workerDone
  fixture.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve()))
  )
  const results = []
  for (const id of taskIds)
    results.push({
      taskId: id,
      state: await state(id),
      run: (await pool.query("SELECT * FROM task_workflow_runs WHERE task_id=$1", [id]))
        .rows[0],
      attempts: (
        await pool.query(
          "SELECT decision_no,status,cost_micros,error FROM task_model_attempts WHERE task_id=$1",
          [id]
        )
      ).rows,
      requests: (
        await pool.query(
          "SELECT kind,status,payload,decision FROM task_requests WHERE task_id=$1",
          [id]
        )
      ).rows,
      actions: (
        await pool.query(
          "SELECT action_no,kind,input,status FROM task_actions WHERE task_id=$1 ORDER BY action_no",
          [id]
        )
      ).rows,
    })
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    checks,
    results,
    controlledProvider: true,
    cloudRequests: 0,
    scope:
      "C3 real in-flight model/control boundaries with local fixed responses; no model judgment or cloud quality claim",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-repair-controls.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(JSON.stringify({ passed, directory, checks: checks.length }))
