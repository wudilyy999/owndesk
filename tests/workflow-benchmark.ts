import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import type { BenchmarkManifest, BenchmarkTask } from "@/lib/workflow-benchmark"

// Ten pre-frozen REAL deterministic GUI repetitions. Cloud baseline/repair arms
// remain unsubmitted while the original C1 unknown request awaits retry consent.
process.loadEnvFile(".env")
const core = JSON.parse(
  await readFile("docs/evidence/workflow-execution-core.json", "utf8")
)
assert(core.passed && /^agent_flowrun_[a-f0-9]+$/.test(core.database))
const resume = process.argv[2]
  ? JSON.parse(await readFile(path.join(process.argv[2], "result.json"), "utf8"))
  : null
if (resume)
  assert(
    /^agent_flowbench_[a-f0-9]+$/.test(resume.database) &&
      resume.manifest &&
      !resume.passed
  )
const database = resume?.database ?? `agent_flowbench_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
const runLabel = resume ? `resume-${Date.now()}-` : ""
await mkdir(directory, { recursive: true })
if (resume)
  await writeFile(
    path.join(directory, `${runLabel}previous-result.json`),
    JSON.stringify(resume, null, 2),
    { flag: "wx" }
  )
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
const credentials = (
  await admin.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [
    ["provider.custom.apiKey", "provider.custom.baseUrl", "pricing.custom"],
  ])
).rows
assert(credentials.some((row) => row.key === "provider.custom.apiKey"))
if (!resume)
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${core.database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: resume?.manifest.installId ?? randomUUID(),
  APP_URL: "http://127.0.0.1:17197",
  WORKER_PORT: "17198",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const jobs: { child: ChildProcess; done: Promise<void>; output: () => string }[] = []
const checks: Record<string, unknown>[] = []
const taskIds: string[] = [...(resume?.taskIds ?? [])]
let worker: (typeof jobs)[number] | undefined
let passed = false
let fixtureFailure: string | null = null
let fixtureRequests = 0
let fixtureManifest: BenchmarkManifest
const fixture = createServer((req, res) => {
  void (async () => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const names = body.tools.map((tool: any) => tool.function.name)
    assert(names.includes("desktop_open_application") && names.includes("key_press"))
    for (const name of [
      "shell",
      "fs_write",
      "browser_click",
      "delegate",
      "vault_fill",
      "memory_write",
    ])
      assert(!names.includes(name))
    const previous = body.messages
      .filter((message: any) => message.role === "tool")
      .at(-1)
    const content = previous ? JSON.parse(previous.content) : null
    const output = Array.isArray(content) ? JSON.parse(content[0].text) : content
    if (output) assert.equal(output.ok, true, JSON.stringify(output))
    const step = fixtureManifest.plan.steps[fixtureRequests]
    let toolName = "complete_task"
    let input: Record<string, unknown> = {
      summary: "Controlled desktop-only channel fixture completed",
      files: [],
    }
    const { bindWorkflowText } = await import("@/lib/workflow-schema")
    const parameters = fixtureManifest.cases[0].parameters
    if (step)
      switch (step.operation) {
        case "open_application":
          toolName = "desktop_open_application"
          input = { application: "Thunar" }
          break
        case "observe":
          toolName = step.share ? "screen_share" : "screen_capture"
          input = {}
          break
        case "assert":
          toolName = "screen_capture"
          input = {}
          break
        case "key_press":
          toolName = "key_press"
          input = {
            key: step.key,
            modifiers: step.modifiers,
            observationId: output.observationId,
          }
          break
        case "key_type":
          toolName = "key_type"
          input = {
            text: bindWorkflowText(step.text, parameters),
            observationId: output.observationId,
          }
          break
        default:
          throw new Error("Unexpected manual step in controlled channel fixture")
      }
    fixtureRequests++
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `benchmark-fixture-${fixtureRequests}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "workflow-benchmark-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `fixture-${fixtureRequests}`,
                  type: "function",
                  function: { name: toolName, arguments: JSON.stringify(input) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      })
    )
  })().catch((error) => {
    fixtureFailure = error.message
    res.writeHead(500).end("Controlled channel provider failed")
  })
})
function start(args: string[], name: string) {
  const child = spawn(process.execPath, args, { env: process.env, detached: true })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += chunk
  })
  child.stderr!.on("data", (chunk) => {
    output += chunk
  })
  const job = {
    child,
    output: () => output,
    done: once(child, "exit").then(async () => {
      await writeFile(path.join(directory, `${runLabel}${name}.log`), output)
    }),
  }
  jobs.push(job)
  return job
}
async function command(args: string[], name: string, expected = 0) {
  const job = start(["--import", "tsx", "scripts/workflow-benchmark.ts", ...args], name)
  await job.done
  assert.equal(job.child.exitCode, expected, job.output())
  return job
}
async function until<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 360000
  while (Date.now() < deadline) {
    assert.equal(fixtureFailure, null)
    if (worker) assert.equal(worker.child.exitCode, null, worker.output())
    const value = await read()
    if (value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
const { pool } = await import("@/db")
const { submitBenchmarkCase, readBenchmarkTask } =
  await import("@/lib/workflow-benchmark-db")
const { closeDurableClient } = await import("@/lib/durable")
const { requestCancellation } = await import("@/lib/task-control")
const { benchmarkReport, benchmarkTotals } = await import("@/lib/workflow-benchmark")
const results: BenchmarkTask[] = []
let manifest: BenchmarkManifest | undefined
let finalReport: unknown
try {
  for (const row of credentials)
    await pool.query(
      "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [row.key, row.value]
    )
  await pool.query(
    "INSERT INTO settings(key,value,updated_at) VALUES('agent.maxSteps','80',now()) ON CONFLICT(key) DO UPDATE SET value='80'"
  )
  const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  const versionId = core.results[0].input.workflowExecution.versionId
  const agentIds: BenchmarkManifest["agentIds"] = resume?.manifest.agentIds ?? {
    baseline: randomUUID(),
    checked: randomUUID(),
    repair: randomUUID(),
  }
  for (const id of resume ? [] : Object.values(agentIds))
    await pool.query(
      "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Matched Desktop','Matched Thunar GUI tasks','','custom/gemini-3.8-flash-high',$2,now(),now())",
      [id, randomUUID()]
    )
  const seed = Date.now()
  const cases =
    resume?.manifest.cases ??
    Array.from({ length: 10 }, (_, index) => ({
      id: `sample-${index + 1}`,
      parameters: {
        parentName: `PA-C4-${seed}-${index + 1}`,
        draftName: [
          "Draft-A",
          "Draft with spaces",
          "待处理",
          "Draft_04",
          "Input-5",
          "原始材料",
          "Work in progress",
          "Batch-08",
          "DRAFT-nine",
          "Input final",
        ][index],
        readyName: [
          "Ready-A",
          "Ready with spaces",
          "已完成",
          "Ready_04",
          "Output-5",
          "归档结果",
          "Work complete",
          "Batch-08-ready",
          "READY-nine",
          "Output final",
        ][index],
      },
    }))
  const spec = path.join(directory, "spec.json")
  if (!resume)
    await writeFile(
      spec,
      JSON.stringify({ ownerId: owner, agentIds, versionId, cases }, null, 2),
      { mode: 0o600 }
    )
  if (!resume) await command(["freeze", spec, directory], "freeze")
  const manifestPath = path.join(directory, "manifest.json")
  const frozen = await readFile(manifestPath, "utf8")
  manifest = JSON.parse(frozen)
  assert(manifest && manifest.cases.length === 10)
  await command(["freeze", spec, directory], "freeze-overwrite-rejected", 1)
  assert.equal(await readFile(manifestPath, "utf8"), frozen)
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS count FROM tasks WHERE source LIKE $1", [
        `benchmark:${manifest.id}:%`,
      ])
    ).rows[0].count,
    resume ? 10 : 0
  )
  checks.push({
    check:
      "CLI froze ten distinct inputs/model/channel/exact validated image before any sample, with three independent desktops; manifest overwrite rejected",
    passed: true,
  })
  await pool.query("UPDATE agents SET instructions='changed after freeze' WHERE id=$1", [
    agentIds.checked,
  ])
  await assert.rejects(
    () => submitBenchmarkCase(manifest!, "checked", "sample-1"),
    /changed after freezing/
  )
  await pool.query("UPDATE agents SET instructions='' WHERE id=$1", [agentIds.checked])
  await assert.rejects(
    () =>
      submitBenchmarkCase(
        { ...manifest!, installId: randomUUID() },
        "checked",
        "sample-1"
      ),
    /original isolated/
  )
  checks.push({
    check: "frozen config/installation mismatch rejects before Task submission",
    passed: true,
  })
  worker = start(["--import", "tsx", "worker/main.ts"], "worker")
  await until(
    async () => (worker!.output().includes("Worker ready") ? true : null),
    "isolated worker ready"
  )
  for (const sample of manifest.cases) {
    const job = await command(
      ["submit", manifestPath, "checked", sample.id],
      `submit-${sample.id}`
    )
    const admission = JSON.parse(job.output().trim())
    if (!taskIds.includes(admission.taskId)) taskIds.push(admission.taskId)
    assert((await submitBenchmarkCase(manifest, "checked", sample.id)).reused)
    const state = await until(async () => {
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
    }, `checked GUI sample ${sample.id}`)
    const metrics = await readBenchmarkTask(pool, admission.taskId, "execution")
    if (resume)
      assert.deepEqual(
        metrics,
        resume.results.find((row: BenchmarkTask) => row.taskId === metrics.taskId),
        "Rechecking a completed sample must not create new GUI/model operations"
      )
    results.push(metrics)
    assert.equal(state.status, "completed", JSON.stringify(state))
    assert.equal(state.result.directoryTree.grade, "program_checked")
    assert.equal(metrics.attempts.length, 0)
    assert.deepEqual(metrics.environment, manifest.environment)
    assert(metrics.actions.every((action) => action.status === "succeeded"))
    const screen = (
      await pool.query(
        "SELECT receipt->'output' AS output FROM task_actions WHERE task_id=$1 AND kind='screen_share' ORDER BY action_no DESC LIMIT 1",
        [admission.taskId]
      )
    ).rows[0].output
    await writeFile(
      path.join(directory, `${sample.id}-final.jpg`),
      Buffer.from(screen.image, "base64")
    )
    await writeFile(
      path.join(directory, `${sample.id}-metrics.json`),
      JSON.stringify(metrics, null, 2),
      { mode: 0o600 }
    )
  }
  checks.push({
    check:
      "ten pre-frozen new-input native GUI tasks all completed with fixed host directory checks and zero model requests; retries reuse original Tasks",
    tasks: taskIds,
    passed: true,
  })
  assert.equal(await readFile(manifestPath, "utf8"), frozen)
  const partial = benchmarkReport(manifest, [], results, new Date().toISOString())
  assert.equal(partial.arms.checked.tasks, 10)
  assert.equal(partial.arms.checked.completed, 10)
  assert.equal(partial.arms.baseline.missingCases.length, 10)
  assert.equal(partial.arms.repair.missingCases.length, 10)
  assert.equal(partial.comparable, false)
  assert.equal(partial.economics.checked.netApiCostSavingsMicros, null)
  checks.push({
    check:
      "missing cloud baseline/repair arms remain 0/10 and cannot produce a savings or completed-C4 claim",
    passed: true,
  })

  // Additional local channel fixture, kept OUTSIDE the frozen cloud population.
  fixture.listen(0, "127.0.0.1")
  await once(fixture, "listening")
  const address = fixture.address()
  assert(address && typeof address !== "string")
  const { setSettings } = await import("@/lib/config")
  const { setCustomPrice } = await import("@/lib/spend")
  await setSettings([
    { key: "provider.custom.apiKey", value: `local-benchmark-${randomUUID()}` },
    { key: "provider.custom.baseUrl", value: `http://127.0.0.1:${address.port}/v1` },
  ])
  await setCustomPrice("custom/workflow-benchmark-fixture", { input: 0, output: 0 })
  const fixtureAgent = randomUUID()
  await pool.query(
    "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Local Channel Fixture','Channel validation','','custom/workflow-benchmark-fixture',$2,now(),now())",
    [fixtureAgent, randomUUID()]
  )
  fixtureManifest = {
    ...manifest,
    agentIds: { baseline: fixtureAgent, checked: "unused", repair: "unused" },
    cases: [
      {
        ...manifest.cases[0],
        parameters: {
          parentName: `PA-C4-channel-${seed}`,
          draftName: "Channel draft",
          readyName: "Channel ready",
        },
      },
      ...manifest.cases.slice(1),
    ],
  }
  const { benchmarkTaskInput } = await import("@/lib/workflow-benchmark")
  const { submitTask } = await import("@/lib/tasks")
  const fixtureTask = await submitTask(owner, "c4-local-channel", {
    ...benchmarkTaskInput(fixtureManifest, "baseline", "sample-1"),
    clientRequestId: randomUUID(),
  })
  taskIds.push(fixtureTask.taskId)
  const { executeAction } = await import("@/worker/actions")
  const rejected = await executeAction(fixtureTask.taskId, 1, 901, "shell", {
    command: "touch /home/agent/forbidden-channel-marker",
  })
  assert.equal(rejected.ok, false)
  assert.match(String(rejected.output.error), /Desktop-only/)
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM task_actions WHERE task_id=$1 AND kind='shell'",
        [fixtureTask.taskId]
      )
    ).rows[0].count,
    0
  )
  const fixtureState = await until(async () => {
    const row = (
      await pool.query("SELECT status,result FROM tasks WHERE id=$1", [
        fixtureTask.taskId,
      ])
    ).rows[0]
    return ["completed", "needs_review", "failed"].includes(row.status) ? row : null
  }, "local controlled ordinary model desktop task")
  assert.equal(fixtureState.status, "completed", JSON.stringify(fixtureState))
  const channel = await readBenchmarkTask(pool, fixtureTask.taskId, "control")
  assert.deepEqual(channel.environment, manifest.environment)
  assert.equal(channel.attempts.length, fixtureManifest.plan.steps.length + 1)
  assert.equal(channel.attempts.length, fixtureRequests)
  assert(
    channel.actions.every(
      (action) => !["shell", "fs_write", "browser_open"].includes(action.kind)
    )
  )
  await writeFile(
    path.join(directory, "channel-fixture-metrics.json"),
    JSON.stringify(channel, null, 2)
  )
  checks.push({
    check:
      "ordinary original model runtime uses only desktop tools/fixed launcher, records actual image, rejects direct Shell before any intent and completes fixed result; local responses excluded from cloud-matched population",
    taskId: fixtureTask.taskId,
    localRequests: fixtureRequests,
    passed: true,
  })

  // Build canonical refs from every retained C0-C3 trial, including failures and
  // UI-only admissions. Synthetic certification copies contain no new executions.
  const refs = new Map<
    string,
    { database: string; taskId: string; phase: BenchmarkTask["phase"] }
  >()
  const add = (
    database: string,
    taskId: string | undefined,
    phase: BenchmarkTask["phase"]
  ) => {
    if (taskId && !refs.has(taskId)) refs.set(taskId, { database, taskId, phase })
  }
  const c0 = JSON.parse(await readFile("docs/evidence/flow-c0-trials.json", "utf8"))
  for (const trial of c0.trials)
    add(path.basename(trial.directory), trial.taskId, "exploration")
  const c1 = JSON.parse(
    await readFile("docs/evidence/workflow-compilation-trials.json", "utf8")
  )
  for (const trial of c1.trials)
    add(path.basename(trial.directory), trial.taskId, "compilation")
  const c2 = JSON.parse(
    await readFile("docs/evidence/workflow-execution-trials.json", "utf8")
  )
  for (const trial of c2.trials) {
    const report = JSON.parse(
      await readFile(path.join(trial.directory, "result.json"), "utf8")
    )
    const phase = report.database.includes("flowcontrol")
      ? "control"
      : report.database.includes("flowui")
        ? "ui"
        : "validation"
    add(report.database, report.taskId, phase)
    for (const id of report.tasks ?? []) add(report.database, id, phase)
    for (const row of report.results ?? []) add(report.database, row.taskId, phase)
  }
  const c3 = JSON.parse(
    await readFile("docs/evidence/workflow-repair-trials.json", "utf8")
  )
  for (const trial of c3) {
    const report = JSON.parse(
      await readFile(path.join(trial.directory, "result.json"), "utf8")
    )
    for (const row of report.results) add(report.database, row.taskId, "repair")
  }
  const controls = JSON.parse(
    await readFile("docs/evidence/workflow-repair-controls.json", "utf8")
  )
  for (const row of controls.results) add(controls.database, row.taskId, "control")
  const ui = JSON.parse(await readFile("docs/evidence/workflow-repair-ui.json", "utf8"))
  add(ui.database, ui.submittedTaskId, "ui")
  for (const id of taskIds.filter(
    (id) => !results.some((result) => result.taskId === id)
  ))
    add(database, id, "control")
  const refsFile = path.join(directory, "setup-refs.json")
  const setupFile = path.join(directory, `${runLabel}setup-metrics.json`)
  await writeFile(refsFile, JSON.stringify([...refs.values()], null, 2))
  await command(["collect", refsFile, setupFile], "collect-history")
  const setup = JSON.parse(await readFile(setupFile, "utf8")) as BenchmarkTask[]
  const historical = benchmarkTotals(setup, new Date().toISOString())
  assert.equal(historical.tasks, refs.size)
  assert(historical.unknownCostAttempts >= 98)
  assert(historical.uncertainAttempts >= 3)
  assert.equal(
    setup
      .filter((task) => task.phase === "exploration")
      .reduce((sum, task) => sum + task.attempts.length, 0),
    97
  )
  const reportPath = path.join(directory, `${runLabel}benchmark-report.json`)
  await command(
    [
      "report",
      manifestPath,
      setupFile,
      reportPath,
      "a459092e-9f6a-41fb-8af7-a13bfa2ba0a6",
    ],
    "report"
  )
  finalReport = JSON.parse(await readFile(reportPath, "utf8"))
  const report = (finalReport as any).report
  assert.equal(report.setup.tasks, refs.size)
  assert.equal(report.setup.totalCostMicros, null)
  assert.equal(report.arms.checked.completed, 10)
  assert.equal(report.economics.checked.comparedUserDeliveries, 11)
  assert.equal(report.economics.checked.netApiCostSavingsMicros, null)
  assert.equal(report.economics.checked.netAllInCostSavingsMicros, null)
  assert.equal(report.fullC4Accepted, false)
  checks.push({
    check:
      "read-only CLI historical collection includes all selected C0-C3 Tasks/failures, 97 C0 calls, unknown costs/outcomes and one shared first delivery without cloned-task double counting; unmeasured labor/environment and missing arms stay explicit",
    canonicalTasks: refs.size,
    totals: historical,
    passed: true,
  })
  passed = true
} finally {
  for (const id of taskIds) {
    const state = (
      await pool.query("SELECT owner_id,status FROM tasks WHERE id=$1", [id])
    ).rows[0]
    if (!["completed", "failed", "cancelled"].includes(state.status))
      await requestCancellation(state.owner_id, id)
  }
  if (worker?.child.pid && worker.child.exitCode === null)
    process.kill(-worker.child.pid, "SIGTERM")
  await Promise.all(jobs.map((job) => job.done))
  if (fixture.listening)
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve()))
    )
  await closeDurableClient()
  await pool.end()
  const evidence = {
    passed,
    database,
    directory,
    manifest,
    checks,
    taskIds,
    results,
    localChannelFixtureRequests: fixtureRequests,
    cloudRequests: 0,
    scope:
      "C4 measurement/admission tooling, ten true GUI checked repetitions and local fixed-provider channel validation; cloud baseline/repair arms are unsubmitted, real-model extraction and full-cost savings remain unverified",
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2))
  if (passed)
    await writeFile(
      "docs/evidence/workflow-benchmark.json",
      JSON.stringify(evidence, null, 2)
    )
}
console.log(
  JSON.stringify({ passed, directory, tasks: taskIds.length, checks: checks.length })
)
