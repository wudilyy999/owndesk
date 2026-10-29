import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// Real GUI perturbations, original runtime/ledger, controlled local responses only.
// The provider supplies a fixed candidate; this does not evaluate model judgment.
process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const database = `agent_flowrepair_${randomUUID().replaceAll("-", "")}`
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
  APP_URL: "http://127.0.0.1:17167",
  WORKER_PORT: "17168",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
let worker: (typeof jobs)[number] | undefined
let passed = false
let mode = "success"
let providerFailure: string | null = null
const providerRequests: Record<string, any>[] = []
const checks: Record<string, unknown>[] = []
const taskIds: string[] = []
const results: Record<string, any>[] = []
const fixture = createServer((req, res) => {
  void (async () => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.tools.length, 1)
    assert.equal(body.tools[0].function.name, "submit_workflow_repair")
    assert.equal(body.tool_choice, "required")
    const serialized = JSON.stringify(body.messages)
    assert(!serialized.includes("private repair standing order"))
    assert(!serialized.includes("private repair memory"))
    const parts = body.messages.at(-1).content
    assert(
      parts.some(
        (part: any) =>
          part.type === "image_url" && part.image_url.url.startsWith("data:image/")
      )
    )
    const context = JSON.parse(parts.find((part: any) => part.type === "text").text)
    assert.equal(context.failedStep.operation, "key_press")
    assert.equal(context.failedStep.key, "l")
    assert.equal(context.current.window.title, "Create New Folder")
    assert(
      context.confirmedEffects.some(
        (effect: any) => effect.input.text === context.values.parentName
      )
    )
    providerRequests.push({ mode, context, receivedAt: new Date().toISOString() })
    if (mode === "lost-response") {
      req.socket.destroy()
      return
    }
    const prefix =
      mode === "invalid"
        ? {
            id: "repair-restart",
            label: "重启整个流程",
            evidence: [],
            operation: "open_application",
            application: "Thunar",
          }
        : {
            id: "repair-dismiss-dialog",
            label: "关闭意外的新建目录弹窗",
            evidence: [],
            operation: "key_press",
            key: "escape",
            modifiers: [],
            when: {
              application: "Thunar",
              title: [{ literal: context.current.window.title }],
            },
          }
    const candidate = {
      reason:
        "A controlled extra folder dialog blocks the undispatched location shortcut; dismiss only that dialog and preserve the shortcut.",
      steps: [prefix, context.failedStep],
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `repair-${providerRequests.length}`,
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
                  id: "repair-candidate",
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
    )
  })().catch((error) => {
    providerFailure = error.message
    res.writeHead(500).end("Controlled repair provider rejected the request")
  })
})
fixture.listen(0, "127.0.0.1")
await once(fixture, "listening")
const address = fixture.address()
assert(address && typeof address !== "string")
const { pool } = await import("@/db")
const { submitTask, getTask } = await import("@/lib/tasks")
const { getWorkflowVersion } = await import("@/lib/workflows")
const { requestCancellation, respondToRequest } = await import("@/lib/task-control")
const { closeDurableClient } = await import("@/lib/durable")
const { docker, dockerRaw } = await import("@/lib/docker")
const latch = await pool.connect()
async function until<T>(
  read: () => Promise<T | null>,
  description: string,
  ms = 300000
): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    assert.equal(providerFailure, null)
    if (worker) assert.equal(worker.child.exitCode, null, worker.output())
    const result = await read()
    if (result !== null) return result
    await delay(70)
  }
  throw new Error(`Timed out: ${description}`)
}
async function startWorker() {
  const child = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: process.env,
    detached: true,
  })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  worker = {
    child,
    output: () => output,
    done: once(child, "exit").then(async () => {
      await writeFile(path.join(directory, `worker-${jobs.length}.log`), output)
    }),
  }
  jobs.push(worker)
  await until(
    async () => (worker!.output().includes("Worker ready") ? true : null),
    "isolated worker ready"
  )
}
const lock = (key: number) =>
  latch.query("SELECT pg_advisory_lock(20261026,$1::integer)", [key])
const unlock = (key: number) =>
  latch.query("SELECT pg_advisory_unlock(20261026,$1::integer)", [key])
const held = (key: number) =>
  until(
    async () =>
      (
        await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=20261026 AND objid=$1",
          [key]
        )
      ).rows[0] ?? null,
    `actual workflow boundary ${key}`
  )
const state = async (id: string) =>
  (await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])).rows[0]
const pending = async (id: string) =>
  (
    await pool.query(
      "SELECT id,payload_version,payload FROM task_requests WHERE task_id=$1 AND status='pending' ORDER BY created_at",
      [id]
    )
  ).rows[0] ?? null
const actionCount = async (id: string) =>
  (
    await pool.query("SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1", [
      id,
    ])
  ).rows[0].count
let owner: string
let agent: string
let versionId: string
async function submit(
  label: string,
  options: {
    versionId?: string
    verify?: boolean
    allowRepair?: boolean
    zeroBudget?: boolean
  } = {}
) {
  const input = {
    agentId: agent,
    goal: `C3 ${label}`,
    clientRequestId: randomUUID(),
    workflowExecution: {
      versionId: options.versionId ?? versionId,
      purpose: options.verify ? ("verify" as const) : ("run" as const),
      parameters: {
        parentName: `PA-C3-${label}-${Date.now()}`,
        draftName: "Draft repair",
        readyName: "Ready repair",
      },
      allowRepair: options.allowRepair !== false,
      maxActions: 120,
      maxDurationSeconds: 300,
    },
    completionContract: { requireHumanReview: false },
    budget:
      options.zeroBudget || options.allowRepair === false
        ? { maxSteps: 1, maxCostMicros: 0 }
        : { maxSteps: 1 },
  }
  const result = await submitTask(owner, "c3-controlled", input)
  taskIds.push(result.taskId)
  await writeFile(
    path.join(directory, `admission-${label}.json`),
    JSON.stringify(
      { taskId: result.taskId, input, installId: process.env.INSTALL_ID },
      null,
      2
    )
  )
  return {
    id: result.taskId,
    input,
    root: `/home/agent/${input.workflowExecution.parameters.parentName}`,
  }
}
async function perturb() {
  await held(302)
  const row = (
    await pool.query("SELECT container_name FROM workstation_control WHERE agent_id=$1", [
      agent,
    ])
  ).rows[0]
  await docker(["exec", row.container_name, "xdotool", "key", "ctrl+shift+n"])
  const title = (
    await docker([
      "exec",
      row.container_name,
      "xdotool",
      "getactivewindow",
      "getwindowname",
    ])
  ).stdout
    .toString()
    .trim()
  assert.equal(title, "Create New Folder")
  await unlock(302)
}
async function waitOutcome(id: string) {
  return until(async () => {
    const row = await state(id)
    return ["completed", "cancelled", "failed", "needs_review", "waiting_user"].includes(
      row.status
    )
      ? row
      : null
  }, `task outcome ${id}`)
}
async function cancel(id: string) {
  await requestCancellation(owner, id)
  await until(
    async () => ((await state(id)).status === "cancelled" ? true : null),
    "actual task cancellation"
  )
}
try {
  const { setSettings } = await import("@/lib/config")
  const { setCustomPrice } = await import("@/lib/spend")
  owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  agent = randomUUID()
  versionId = core.results[0].input.workflowExecution.versionId
  await setSettings([
    { key: "provider.custom.apiKey", value: `local-repair-${randomUUID()}` },
    { key: "provider.custom.baseUrl", value: `http://127.0.0.1:${address.port}/v1` },
  ])
  await setCustomPrice("custom/workflow-repair-fixture", { input: 0, output: 0 })
  await pool.query(
    "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Repair Desktop Lab','Local controlled CUA repair','private repair standing order','custom/workflow-repair-fixture',$2,now(),now())",
    [agent, randomUUID()]
  )
  await pool.query(
    "INSERT INTO memories(id,agent_id,content,created_at) VALUES($1,$2,'private repair memory',now())",
    [randomUUID(), agent]
  )
  const original = await getWorkflowVersion(owner, versionId)
  assert.equal(original.status, "ready")
  await pool.query(`CREATE FUNCTION c3_hold_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='workflow_step' AND NEW.payload->>'capture'='false' THEN
      IF NEW.payload->>'nextStep'='4' THEN PERFORM pg_advisory_xact_lock(20261026,302); END IF;
      IF NEW.payload->>'nextStep'='7' THEN PERFORM pg_advisory_xact_lock(20261026,304); END IF;
    END IF;
    IF NEW.type='workflow_repair' AND NEW.payload->>'phase'='accepted' THEN PERFORM pg_advisory_xact_lock(20261026,303); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER c3_hold_boundary BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION c3_hold_boundary();`)
  await startWorker()

  // 1. Real modal drift after a confirmed parent creation, with worker death after
  // the saved model response and before variant commit. No repeated API/input.
  await lock(302)
  await lock(303)
  const success = await submit("recovery")
  await perturb()
  const beforeCommit = await held(303)
  assert.equal(providerRequests.length, 1)
  assert.equal(
    (
      await pool.query("SELECT status FROM task_model_decisions WHERE task_id=$1", [
        success.id,
      ])
    ).rows[0].status,
    "succeeded"
  )
  const stopped = worker!
  process.kill(-stopped.child.pid!, "SIGKILL")
  await stopped.done
  worker = undefined
  await pool.query("SELECT pg_terminate_backend($1)", [beforeCommit.pid])
  await unlock(303)
  await startWorker()
  const completed = await waitOutcome(success.id)
  assert.equal(
    completed.status,
    "completed",
    JSON.stringify({ completed, request: await pending(success.id) })
  )
  assert.equal(completed.result.directoryTree.grade, "program_checked")
  assert.equal(providerRequests.length, 1)
  const repairedRun = (
    await pool.query("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
      success.id,
    ])
  ).rows[0].checkpoint
  assert.equal(repairedRun.repair.status, "accepted")
  assert.equal(repairedRun.repair.cursor, 2)
  const draftId = repairedRun.repair.draftVersionId
  const draft = await getWorkflowVersion(owner, draftId)
  assert.equal(draft.status, "draft")
  assert.equal(draft.validatedEnvironment, null)
  assert.equal(draft.revision, original.revision + 1)
  assert.deepEqual(draft.plan!.completion, original.plan!.completion)
  assert.deepEqual(draft.plan!.repairOrigin, { versionId, taskId: success.id, step: 4 })
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1 AND kind='key_type' AND input->>'text'=$2",
        [success.id, success.input.workflowExecution.parameters.parentName]
      )
    ).rows[0].count,
    1
  )
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1 AND kind='key_press' AND input->>'key'='escape'",
        [success.id]
      )
    ).rows[0].count,
    1
  )
  const projection = await getTask(owner, success.id)
  assert.equal(projection.workflowRun!.draftVersionId, draftId)
  await assert.rejects(
    () =>
      submitTask(owner, "c3-denied", {
        ...success.input,
        clientRequestId: randomUUID(),
        workflowExecution: { ...success.input.workflowExecution, versionId: draftId },
      }),
    /not passed independent/
  )
  checks.push({
    check:
      "real popup repair survives response-before-variant SIGKILL with one API request, one parent typing and one dismissal; fixed result passes, new draft only",
    taskId: success.id,
    draftId,
    passed: true,
  })

  // 2. A second drift in the same run must stop instead of another model request.
  await lock(302)
  await lock(304)
  const exhausted = await submit("second-drift")
  await perturb()
  await held(304)
  const station = (
    await pool.query("SELECT container_name FROM workstation_control WHERE agent_id=$1", [
      agent,
    ])
  ).rows[0]
  await docker(["exec", station.container_name, "xdotool", "key", "ctrl+shift+n"])
  await unlock(304)
  await until(async () => await pending(exhausted.id), "second drift review")
  assert.equal(providerRequests.length, 2)
  const beforeContinue = await actionCount(exhausted.id)
  const secondReview = await pending(exhausted.id)
  await respondToRequest(
    owner,
    secondReview.id,
    "continue",
    secondReview.payload_version,
    {}
  )
  await until(async () => {
    const row = await pending(exhausted.id)
    return row && row.id !== secondReview.id ? row : null
  }, "second drift remains blocked")
  assert.equal(providerRequests.length, 2)
  assert.equal(await actionCount(exhausted.id), beforeContinue)
  await cancel(exhausted.id)
  checks.push({
    check: "second GUI drift and Continue cannot request another repair or resend input",
    taskId: exhausted.id,
    passed: true,
  })

  // 3. An out-of-scope candidate is retained as rejection, never executed.
  mode = "invalid"
  await lock(302)
  const invalid = await submit("invalid-candidate")
  await perturb()
  const invalidReview = await until(
    async () => await pending(invalid.id),
    "invalid candidate review"
  )
  assert.match(invalidReview.payload.reason, /prefixes/)
  assert.equal(providerRequests.length, 3)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1 AND kind='desktop_open_application'",
        [invalid.id]
      )
    ).rows[0].count,
    1
  )
  await cancel(invalid.id)
  checks.push({
    check:
      "candidate cannot restart/replay the workflow; strict rejection keeps the frozen contract and one-request bound",
    taskId: invalid.id,
    passed: true,
  })

  // 4. An explicit zero task-cost budget denies the model before dispatch.
  mode = "success"
  await lock(302)
  const capped = await submit("zero-budget", { zeroBudget: true })
  await perturb()
  const cappedReview = await until(
    async () => await pending(capped.id),
    "repair budget gate"
  )
  assert.match(cappedReview.payload.reason, /allowance/)
  assert.equal(providerRequests.length, 3)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=$1",
        [capped.id]
      )
    ).rows[0].count,
    0
  )
  await cancel(capped.id)
  checks.push({
    check: "repair honors task cost/model limits before creating an API attempt",
    taskId: capped.id,
    passed: true,
  })

  // 5. Real directory effect + lost guest receipt stays original unknown review.
  const unknown = await submit("unknown-action")
  const changed = await until(async () => {
    const action = (
      await pool.query(
        "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='key_press' AND input->>'key'='enter' AND status='intent' ORDER BY action_no LIMIT 1",
        [unknown.id]
      )
    ).rows[0]
    if (!action) return null
    const row = (
      await pool.query(
        "SELECT container_name FROM workstation_control WHERE agent_id=$1",
        [agent]
      )
    ).rows[0]
    const exists = await dockerRaw([
      "exec",
      row.container_name,
      "test",
      "-d",
      unknown.root,
    ])
    return exists.exitCode === 0 ? { actionNo: action.action_no, row } : null
  }, "real parent effect before receipt")
  await docker(["restart", "--time", "0", changed.row.container_name], {
    timeoutMs: 45000,
  })
  const unknownReview = await until(
    async () => await pending(unknown.id),
    "unknown action review"
  )
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM task_actions WHERE task_id=$1 AND action_no=$2",
        [unknown.id, changed.actionNo]
      )
    ).rows[0].status,
    "unknown"
  )
  const unknownCount = await actionCount(unknown.id)
  await respondToRequest(
    owner,
    unknownReview.id,
    "continue",
    unknownReview.payload_version,
    {}
  )
  await until(async () => {
    const row = await pending(unknown.id)
    return row && row.id !== unknownReview.id ? row : null
  }, "unknown action stays blocked")
  assert.equal(providerRequests.length, 3)
  assert.equal(await actionCount(unknown.id), unknownCount)
  await cancel(unknown.id)
  checks.push({
    check:
      "real filesystem effect with unknown GUI receipt cannot enter automatic repair or replay after Continue",
    taskId: unknown.id,
    passed: true,
  })

  // 6. A dropped model response preserves unknown billing and never substitutes
  // a fresh logical decision after owner Continue.
  mode = "lost-response"
  await lock(302)
  const lost = await submit("unknown-model")
  await perturb()
  const lostReview = await until(
    async () => await pending(lost.id),
    "lost model response review"
  )
  assert.equal(providerRequests.length, 4)
  assert.equal(
    (
      await pool.query("SELECT status FROM task_model_attempts WHERE task_id=$1", [
        lost.id,
      ])
    ).rows[0].status,
    "unknown"
  )
  const lostCount = await actionCount(lost.id)
  await respondToRequest(owner, lostReview.id, "continue", lostReview.payload_version, {})
  await until(async () => {
    const row = await pending(lost.id)
    return row && row.id !== lostReview.id ? row : null
  }, "lost response has no automatic paid retry")
  assert.equal(providerRequests.length, 4)
  assert.equal(await actionCount(lost.id), lostCount)
  await cancel(lost.id)
  checks.push({
    check:
      "lost repair response records one unknown attempt, retains cost uncertainty and never retries on generic Continue",
    taskId: lost.id,
    passed: true,
  })

  // 7. The owner explicitly admits a new independent sample of the repair draft.
  // This sample uses the same declared GUI perturbation, with zero model calls.
  mode = "success"
  await lock(302)
  const independent = await submit("independent-repair", {
    versionId: draftId,
    verify: true,
    allowRepair: false,
  })
  await perturb()
  const independentState = await waitOutcome(independent.id)
  assert.equal(
    independentState.status,
    "completed",
    JSON.stringify({ independentState, request: await pending(independent.id) })
  )
  assert.equal(independentState.result.directoryTree.grade, "program_checked")
  assert.equal((await getWorkflowVersion(owner, draftId)).status, "verifying")
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_model_attempts WHERE task_id=$1",
        [independent.id]
      )
    ).rows[0].count,
    0
  )
  checks.push({
    check:
      "explicit draft verification executes new GUI actions on fresh parameters with zero model calls; one sample keeps draft unready",
    taskId: independent.id,
    passed: true,
  })
  const finalOriginal = await getWorkflowVersion(owner, versionId)
  assert.deepEqual(finalOriginal, original)
  assert.equal(taskIds.length, 7)
  assert.equal(providerRequests.length, 4)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM workflow_versions WHERE compilation_task_id=ANY($1::text[])",
        [taskIds]
      )
    ).rows[0].count,
    1
  )
  checks.push({
    check:
      "source ready version/plan/environment remain byte-equivalent; only the fully checked repaired run generates a new draft",
    passed: true,
  })
  passed = true
} finally {
  await latch.query("SELECT pg_advisory_unlock_all()")
  latch.release()
  for (const id of taskIds) {
    const current = await state(id)
    if (!["completed", "failed", "cancelled"].includes(current.status) && worker)
      await cancel(id)
    const actions = (
      await pool.query(
        "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
        [id]
      )
    ).rows
    for (const action of actions)
      if (action.receipt?.output?.image) {
        if (action.kind === "screen_share")
          await writeFile(
            path.join(directory, `${id}-final.jpg`),
            Buffer.from(action.receipt.output.image, "base64")
          )
        delete action.receipt.output.image
      }
    results.push({
      taskId: id,
      state: await state(id),
      run: (await pool.query("SELECT * FROM task_workflow_runs WHERE task_id=$1", [id]))
        .rows[0],
      actions,
      attempts: (
        await pool.query(
          "SELECT decision_no,attempt_no,status,usage,cost_micros,error FROM task_model_attempts WHERE task_id=$1",
          [id]
        )
      ).rows,
      requests: (
        await pool.query(
          "SELECT kind,status,payload,decision FROM task_requests WHERE task_id=$1",
          [id]
        )
      ).rows,
    })
  }
  if (worker?.child.pid && worker.child.exitCode === null)
    process.kill(-worker.child.pid, "SIGTERM")
  await Promise.all(jobs.map((job) => job.done))
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve()))
  )
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    controlledProvider: true,
    realModelJudgmentEvaluated: false,
    cloudRequests: 0,
    scope:
      "C3 native Thunar GUI perturbations and deterministic local provider; not real-model repair quality, general application drift, cloud deployment or OwnDesk superiority",
    checks,
    providerRequests,
    results,
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  const trialsPath = "docs/evidence/workflow-repair-trials.json"
  let trials: unknown[] = []
  try {
    trials = JSON.parse(await readFile(trialsPath, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  trials.push({
    passed,
    database,
    directory,
    tasks: taskIds.length,
    checks: checks.length,
  })
  await writeFile(trialsPath, JSON.stringify(trials, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-repair.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(
  JSON.stringify({ passed, directory, tasks: taskIds.length, checks: checks.length })
)
