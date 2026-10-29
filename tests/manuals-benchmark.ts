import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import type { ConsoleState } from "./fixtures/manual-console"
import { benchmarkCases, evaluateConsole } from "./manuals-benchmark-cases"

// Representation experiment, not a head-to-head execution of the upstream products.
// Visible semantic evidence comes from the fixture, not a screenshot summarizer.
assert(
  (process.argv[2] === "--prepare" && [3, 4].includes(process.argv.length)) ||
    (["--run", "--terra-retry"].includes(process.argv[2]) && process.argv.length === 4),
  "Use --prepare; review both draft files, then --run DIRECTORY"
)
process.loadEnvFile(".env")
const originalEnv = await readFile(".env")
const main = new pg.Client({ connectionString: process.env.DATABASE_URL })
await main.connect()
const counts = async () =>
  (
    await main.query(`SELECT
 (SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM task_model_attempts) AS attempts,
 (SELECT count(*)::int FROM task_actions) AS actions,(SELECT count(*)::int FROM artifacts) AS artifacts,
 (SELECT count(*)::int FROM tasks WHERE status IN ('queued','running')) AS active`)
  ).rows[0]
const mainBefore = await counts()
const preparing = process.argv[2] === "--prepare"
const terraRetry = process.argv[2] === "--terra-retry"
const creating = preparing && process.argv.length === 3
const directory = preparing
  ? creating
    ? path.resolve("data/experiments", `manual-benchmark-${Date.now()}`)
    : path.resolve(process.argv[3])
  : path.resolve(process.argv[3])
await mkdir(directory, { recursive: true, mode: 0o700 })
type Arm = "none" | "lossy" | "semantic"
type Admission = {
  database: string
  installId: string
  agentId: string
  ownerId: string
  model: string
  tasks: Record<string, { key: string; id?: string }>
  cells: Record<string, Record<string, unknown>>
}
const admissionPath = path.join(directory, "admission.json")
let setup: Admission
if (creating) {
  const previous = JSON.parse(await readFile("docs/evidence/manuals.json", "utf8"))
  assert(/^agent_manual_[a-f0-9]+$/.test(previous.inheritedSource.database))
  const database = `agent_manual_benchmark_${randomUUID().replaceAll("-", "")}`
  await main.query(
    `CREATE DATABASE "${database}" TEMPLATE "${previous.inheritedSource.database}"`
  )
  setup = {
    database,
    installId: randomUUID(),
    agentId: "",
    ownerId: "",
    model: "openai/gpt-6.1-sol",
    tasks: {},
    cells: {},
  }
  await writeFile(admissionPath, JSON.stringify(setup, null, 2))
} else setup = JSON.parse(await readFile(admissionPath, "utf8"))
assert(/^agent_manual_benchmark_[a-f0-9]+$/.test(setup.database))
const dbUrl = new URL(process.env.DATABASE_URL!)
dbUrl.pathname = "/" + setup.database
Object.assign(process.env, {
  DATABASE_URL: dbUrl.toString(),
  INSTALL_ID: setup.installId,
  APP_URL: "http://127.0.0.1:17257",
  WORKER_PORT: "17258",
  WORKER_HOST: "127.0.0.1",
  WORKSTATION_IMAGE: "owndesk-workstation:manual-benchmark-cjk",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
})
const { pool } = await import("@/db")
const { docker, dockerRaw } = await import("@/lib/docker")
const { ensureWorkstation, stopInstallationWorkstations, stopWorkstationBoundary } =
  await import("@/lib/workstation")
const { submitTask } = await import("@/lib/tasks")
const { requestCancellation, respondToRequest } = await import("@/lib/task-control")
const { saveManual } = await import("@/lib/manuals")
const save = () => writeFile(admissionPath, JSON.stringify(setup, null, 2))
let container = "",
  worker: ReturnType<typeof spawn> | undefined,
  workerDone: Promise<unknown> | undefined
let failure: string | undefined
const startedAt = new Date().toISOString()
const fixtureBase = "http://127.0.0.1:18087"
async function fixture(route: string, body?: unknown): Promise<any> {
  const script = `const r=await fetch(${JSON.stringify(fixtureBase + route)},${JSON.stringify(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })});if(!r.ok)throw Error(await r.text());process.stdout.write(await r.text())`
  const result = await docker(
    ["exec", container, "node", "--input-type=module", "-e", script],
    { timeoutMs: 10000 }
  )
  assert.equal(result.exitCode, 0, result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}
async function prepareDesktop() {
  container = (await ensureWorkstation(setup.agentId)).containerName
  const chineseFonts = await docker(["exec", container, "fc-list", ":lang=zh", "family"])
  assert(
    chineseFonts.stdout.toString().trim(),
    "Install CJK fonts in the isolated workstation before real-model GUI tests"
  )
  const copied = await docker([
    "cp",
    path.resolve("tests/fixtures/manual-console.ts"),
    `${container}:/tmp/manual-console.ts`,
  ])
  assert.equal(copied.exitCode, 0)
  const fixtureStarted = await docker([
    "exec",
    "-d",
    container,
    "sh",
    "-c",
    "exec node /tmp/manual-console.ts 18087 >/tmp/manual-console-server.log 2>&1",
  ])
  assert.equal(fixtureStarted.exitCode, 0)
  const deadline = Date.now() + 15000
  while (true) {
    const health = await dockerRaw([
      "exec",
      container,
      "curl",
      "-fsS",
      `${fixtureBase}/health`,
    ])
    if (health.exitCode === 0) break
    assert(Date.now() < deadline, "Fixture failed to start")
    await delay(250)
  }
}
async function waitTask(id: string, terminalOnly = false) {
  const end = Date.now() + 600000
  let last = ""
  while (Date.now() < end) {
    const row = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [id])
    ).rows[0]
    if (row.status !== last) {
      console.log(JSON.stringify({ id, status: row.status }))
      last = row.status
    }
    if (
      (terminalOnly
        ? ["completed", "failed", "cancelled"]
        : [
            "completed",
            "failed",
            "cancelled",
            "waiting_user",
            "waiting_human",
            "needs_review",
          ]
      ).includes(row.status)
    )
      return row
    await delay(400)
  }
  throw Error(`Original task ${id} exceeded wait; inspect before resuming`)
}
async function submit(key: string, input: Record<string, unknown>) {
  if (!setup.tasks[key]) {
    setup.tasks[key] = { key: randomUUID() }
    await save()
  }
  const entry = setup.tasks[key]
  if (!entry.id) {
    const accepted = await submitTask(setup.ownerId, "manual-benchmark", {
      agentId: setup.agentId,
      clientRequestId: entry.key,
      budget: { maxSteps: 30 },
      completionContract: { requireHumanReview: false },
      ...input,
    } as Parameters<typeof submitTask>[2])
    entry.id = accepted.taskId
    await save()
  }
  const result = await waitTask(entry.id)
  await assertResolvedAttempts(entry.id)
  return { id: entry.id, ...result }
}
async function assertResolvedAttempts(id: string) {
  const unresolved = (
    await pool.query(
      `SELECT a.status FROM task_model_attempts a
       WHERE a.task_id=$1 AND a.status<>'succeeded' AND NOT (
         EXISTS (SELECT 1 FROM task_requests r WHERE r.task_id=a.task_id
           AND r.segment_no=a.segment_no AND r.status='resolved' AND r.decision='continue'
           AND r.payload->>'purpose' IN ('execution_error','model_retry')
           AND r.payload->>'decisionNo'=a.decision_no::text)
         AND EXISTS (SELECT 1 FROM task_model_attempts b WHERE b.task_id=a.task_id
           AND b.segment_no=a.segment_no AND b.decision_no=a.decision_no
           AND b.attempt_no>a.attempt_no AND b.status='succeeded'))`,
      [id]
    )
  ).rows
  assert.equal(
    unresolved.length,
    0,
    `Unresolved original model request on ${id}; no automatic retry or replacement task`
  )
}
const context =
  "当前桌面浏览器已打开只读演练控制台。请完全通过桌面截图、鼠标和键盘操作，不访问调试接口。"
const purpose =
  "云控制台交接核查：进入指定地域和实例，按已经演示的交接核查流程核对页面。仅浏览，不修改资源。"
const parameters = [
  { name: "region", label: "地域", sourceValue: "华东一" },
  { name: "instanceId", label: "实例 ID", sourceValue: "db-demo-101" },
]
try {
  if (creating) {
    await pool.query("DELETE FROM session")
    await pool.query("DELETE FROM workstation_control")
    await pool.query("DELETE FROM memories")
    await pool.query(
      "DELETE FROM settings WHERE key LIKE 'manual.%' OR key LIKE 'provider.%' OR key LIKE 'agentZero.%'"
    )
    const copied = (
      await main.query("SELECT key,value FROM settings WHERE key=ANY($1)", [
        ["provider.openai.apiKey", "provider.openai.baseUrl", "pricing.custom"],
      ])
    ).rows
    assert(copied.some((s) => s.key === "provider.openai.apiKey"))
    for (const s of [...copied, { key: "model.default", value: setup.model }])
      await pool.query(
        "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
        [s.key, s.value]
      )
    const source = (
      await pool.query("SELECT agent_id,owner_id FROM tasks ORDER BY created_at LIMIT 1")
    ).rows[0]
    setup.agentId = source.agent_id
    setup.ownerId = source.owner_id
    await pool.query("UPDATE agents SET workstation_id=NULL,model=NULL,instructions=NULL")
    await save()
  }
  for (const entry of Object.values(setup.tasks))
    if (entry.id && !(terraRetry && entry.id === setup.tasks["compile-semantic"].id))
      await assertResolvedAttempts(entry.id)
  if (terraRetry) {
    const id = setup.tasks["compile-semantic"].id!
    const before = (await pool.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0]
    const segment = (
      await pool.query("SELECT * FROM task_segments WHERE task_id=$1 AND segment_no=$2", [
        id,
        before.active_segment,
      ])
    ).rows[0]
    const attempts = (
      await pool.query("SELECT * FROM task_model_attempts WHERE task_id=$1 ORDER BY id", [
        id,
      ])
    ).rows
    const request = (
      await pool.query(
        "SELECT * FROM task_requests WHERE task_id=$1 AND status='pending' AND payload->>'purpose'='execution_error'",
        [id]
      )
    ).rows[0]
    assert.equal(before.status, "needs_review")
    assert.equal(before.config_snapshot.model, "openai/gpt-6.1-sol")
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].status, "unknown")
    assert(request)
    await writeFile(
      path.join(directory, "before-terra-retry.json"),
      JSON.stringify({ before, segment, attempts, request }, null, 2),
      { flag: "wx", mode: 0o600 }
    )
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM task_events WHERE task_id=$1 AND key='owner-consent:terra-single-retry'",
            [id]
          )
        ).rowCount,
        0
      )
      await client.query(
        "UPDATE tasks SET config_snapshot=jsonb_set(config_snapshot,'{model}',$2::jsonb),budget=jsonb_set(budget,'{maxSteps}',$3::jsonb),updated_at=now() WHERE id=$1",
        [
          id,
          JSON.stringify("openai/gpt-6.1-terra"),
          JSON.stringify(request.payload.decisionNo),
        ]
      )
      await client.query(
        "UPDATE task_segments SET snapshot=jsonb_set(snapshot,'{config,model}',$3::jsonb) WHERE task_id=$1 AND segment_no=$2",
        [id, before.active_segment, JSON.stringify("openai/gpt-6.1-terra")]
      )
      const { appendEventInTransaction } = await import("@/lib/task-events")
      await appendEventInTransaction(
        client,
        id,
        "owner-consent:terra-single-retry",
        "model_switch",
        {
          fromModel: before.config_snapshot.model,
          toModel: "openai/gpt-6.1-terra",
          ownerInstruction: "改为使用6.1-terra",
          maxAdditionalRequests: 1,
          preserveUnknownAttempts: true,
          decisionNo: request.payload.decisionNo,
          gatewayModelIdVerified: "gpt-6.1-terra",
        }
      )
      await client.query(
        "UPDATE settings SET value=$1,updated_at=now() WHERE key='model.default'",
        ["openai/gpt-6.1-terra"]
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    setup.model = "openai/gpt-6.1-terra"
    await save()
    await respondToRequest(
      setup.ownerId,
      request.id,
      "continue",
      request.payload_version,
      {
        note: "按用户指示改为6.1-terra，在原任务追加一次请求，原未知费用保留。",
      }
    )
  }
  worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: process.env,
    detached: true,
  })
  let log = ""
  worker.stdout!.on("data", (c) => {
    log += c
  })
  worker.stderr!.on("data", (c) => {
    log += c
  })
  workerDone = once(worker, "exit").then(() =>
    writeFile(path.join(directory, `worker-${Date.now()}.log`), log)
  )
  if (terraRetry) {
    const id = setup.tasks["compile-semantic"].id!
    while (
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM task_model_attempts WHERE task_id=$1",
          [id]
        )
      ).rows[0].n < 2
    ) {
      assert(worker.exitCode === null, "Worker exited before the authorized retry")
      await delay(400)
    }
    const compiled = await waitTask(id)
    const attempts = (
      await pool.query(
        "SELECT model,status FROM task_model_attempts WHERE task_id=$1 ORDER BY id",
        [id]
      )
    ).rows
    assert.equal(attempts.length, 2)
    assert.equal(attempts[1].model, "openai/gpt-6.1-terra")
    assert.equal(
      compiled.status,
      "completed",
      "Single Terra retry did not complete; inspect the original chain"
    )
    await assertResolvedAttempts(id)
    await writeFile(
      path.join(directory, "semantic-draft.json"),
      JSON.stringify(compiled.result.manualDraft, null, 2)
    )
    console.log(JSON.stringify({ stage: "review-drafts", directory, model: setup.model }))
  } else if (preparing) {
    await prepareDesktop()
    await writeFile(
      path.join(directory, "dataset.json"),
      JSON.stringify(
        {
          version: 1,
          model: setup.model,
          arms: ["none", "lossy", "semantic"],
          cases: benchmarkCases,
          scope:
            "Synthetic cloud GUI; representation comparison, not upstream-product ranking. Semantic evidence is fixture-visible text, not automatic image understanding.",
          oracle:
            "Independent host checks final state, exact instance, applied policy, wrong-instance visits, and inspection before missing-target question.",
        },
        null,
        2
      )
    )
    const s: ConsoleState = await fixture("/sessions", {
      layout: "sidebar",
      missing: false,
    })
    await fixture(`/sessions/${s.id}/action`, { action: "region", value: "华北二" })
    assert.equal(
      (await docker(["exec", container, "browser", `${fixtureBase}/sessions/${s.id}`]))
        .exitCode,
      0
    )
    await docker([
      "exec",
      container,
      "xdotool",
      "key",
      "--clearmodifiers",
      "Escape",
      "ctrl+0",
    ])
    const source = await submit("source", {
      workstationChannel: "desktop",
      goal:
        context +
        "请演示我的交接核查流程：从首页进入数据与存储、关系型数据库，选择华东一地域；只打开精确匹配 db-demo-101 的实例，避免相似 ID。进入备份与恢复、归档日志，选择最近30分钟和仅异常，点击应用筛选；核对实例及筛选条件后保持页面可见。目标不存在时应停止询问。所有操作仅浏览。",
    })
    assert.equal(source.status, "completed", "Demonstration did not complete")
    const state: ConsoleState = await fixture(`/sessions/${s.id}/state`)
    assert(
      state.instance === "db-demo-101" &&
        state.page === "backups" &&
        state.tab === "归档日志" &&
        state.range === "最近30分钟" &&
        state.level === "仅异常" &&
        state.applied,
      "Source GUI did not satisfy the demonstrated policy"
    )
    assert(
      state.events.every((e) => e.action !== "instance" || e.value === "db-demo-101"),
      "Demonstration visited a wrong instance"
    )
    const visible = state.events.slice(1)
    await writeFile(
      path.join(directory, "demonstration.json"),
      JSON.stringify(visible, null, 2)
    )
    const actions = (
      await pool.query(
        "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
        [source.id]
      )
    ).rows
    for (const a of actions) {
      const image = a.receipt?.output?.image
      if (image) {
        await writeFile(
          path.join(directory, `source-${a.action_no}.jpg`),
          Buffer.from(image, "base64")
        )
        delete a.receipt.output.image
      }
    }
    await writeFile(
      path.join(directory, "source-actions.json"),
      JSON.stringify(actions, null, 2)
    )
    const semantic = visible
      .map(
        (e, i) =>
          `${i + 1}. 在「${e.before}」点击「${e.target}」，之后看到「${e.after}」；可见状态：${e.visibleResult}`
      )
      .join("\n")
      .replaceAll("华东一", "{{region}}")
      .replaceAll("db-demo-101", "{{instanceId}}")
    for (const arm of ["lossy", "semantic"] as const) {
      const candidatePurpose =
        arm === "lossy"
          ? purpose
          : purpose +
            "\n以下为同一次演示经检查的可见操作记录（测试夹具采集，尚非截图自动提炼）：\n" +
            semantic
      assert(candidatePurpose.length <= 2000)
      const compiled = await submit(`compile-${arm}`, {
        goal: "从成功演示生成交接核查操作手册。",
        manualCompilation: {
          sourceTaskId: source.id,
          name: "云控制台交接核查",
          purpose: candidatePurpose,
          parameters,
          reviewed: true,
        },
        budget: { maxSteps: 3 },
      })
      assert.equal(compiled.status, "completed")
      await writeFile(
        path.join(directory, `${arm}-draft.json`),
        JSON.stringify(compiled.result.manualDraft, null, 2)
      )
    }
    console.log(JSON.stringify({ stage: "review-drafts", directory }))
  } else {
    for (const arm of ["lossy", "semantic"] as const) {
      const id = setup.tasks[`compile-${arm}`].id!
      const draft = JSON.parse(
        await readFile(path.join(directory, `${arm}-draft.json`), "utf8")
      )
      if (arm === "semantic")
        for (const word of [
          "归档日志",
          "最近30分钟",
          "仅异常",
          "{{region}}",
          "{{instanceId}}",
        ])
          assert(
            draft.body.replace(/\s/g, "").includes(word),
            `Review required: semantic draft omitted ${word}`
          )
      await saveManual(setup.ownerId, id, {
        ...draft,
        name: "云控制台交接核查",
        description: purpose,
      })
    }
    const arms: Arm[] = ["none", "lossy", "semantic"]
    for (const [i, c] of benchmarkCases.entries())
      for (let j = 0; j < 3; j++) {
        const arm = arms[(i + j) % 3],
          key = `${c.id}:${arm}`
        if (setup.cells[key]) continue
        await pool.query(
          "UPDATE settings SET value=jsonb_set(value::jsonb,'{enabled}','false')::text,updated_at=now() WHERE key LIKE 'manual.%'"
        )
        if (arm !== "none")
          await pool.query(
            "UPDATE settings SET value=jsonb_set(value::jsonb,'{enabled}','true')::text,updated_at=now() WHERE key=$1",
            [`manual.${setup.tasks[`compile-${arm}`].id}`]
          )
        assert(
          !setup.tasks[key]?.id,
          "A partially recorded cell requires original-chain inspection"
        )
        await stopWorkstationBoundary(setup.agentId)
        await prepareDesktop()
        const s: ConsoleState = await fixture("/sessions", c)
        assert.equal(
          (
            await docker([
              "exec",
              container,
              "browser",
              `${fixtureBase}/sessions/${s.id}`,
            ])
          ).exitCode,
          0
        )
        await docker([
          "exec",
          container,
          "xdotool",
          "key",
          "--clearmodifiers",
          "Escape",
          "ctrl+0",
        ])
        const began = Date.now()
        const task = await submit(key, {
          workstationChannel: "desktop",
          goal: context + c.goal,
          budget: { maxSteps: 18 },
        })
        const current: ConsoleState = await fixture(`/sessions/${s.id}/state`)
        const decisions = (
          await pool.query(
            "SELECT decision_no,result->'calls' AS calls FROM task_model_decisions WHERE task_id=$1 ORDER BY decision_no",
            [task.id]
          )
        ).rows
        const asked = decisions.some((d) =>
          d.calls?.some((call: any) => call.toolName === "ask_user")
        )
        const loaded = decisions.some((d) =>
          d.calls?.some((call: any) => call.toolName === "load_manual")
        )
        const actions = (
          await pool.query(
            "SELECT action_no,kind,input,status,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
            [task.id]
          )
        ).rows
        const frame = actions.findLast((a) => a.receipt?.output?.image)?.receipt.output
          .image
        if (frame)
          await writeFile(
            path.join(directory, `${c.id}-${arm}.jpg`),
            Buffer.from(frame, "base64")
          )
        const oracle = evaluateConsole(c, current, asked)
        const frozen = (
          await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [task.id])
        ).rows[0].config_snapshot
        assert(
          !frozen.manualId && !frozen.conversation?.length && !frozen.memories.length,
          "Cross-cell instructions leaked"
        )
        assert.equal((frozen.manuals ?? []).length, arm === "none" ? 0 : 1)
        const guiOnly = actions.every(
          (a) =>
            ![
              "shell",
              "fs_read",
              "fs_write",
              "browser_open",
              "browser_click",
              "browser_evaluate",
            ].includes(a.kind)
        )
        setup.cells[key] = {
          taskId: task.id,
          case: c.id,
          arm,
          taskStatus: task.status,
          passed:
            oracle.passed && guiOnly && actions.every((a) => a.status === "succeeded"),
          oracle,
          loadedManual: loaded,
          askedUser: asked,
          actionCount: actions.length,
          decisions: decisions.length,
          elapsedMs: Date.now() - began,
          guiOnly,
          summary: task.result?.summary,
          state: current,
          modelCalls: decisions
            .flatMap((d) => d.calls ?? [])
            .map((call: any) => ({
              tool: call.toolName,
              input: call.toolName === "ask_user" ? call.input : undefined,
            })),
        }
        await save()
        await writeFile(
          path.join(directory, `${c.id}-${arm}.json`),
          JSON.stringify(setup.cells[key], null, 2)
        )
        console.log(
          JSON.stringify({
            cell: key,
            ...oracle,
            loaded,
            decisions: decisions.length,
            actions: actions.length,
          })
        )
        if (!["completed", "failed", "cancelled"].includes(task.status)) {
          await requestCancellation(setup.ownerId, task.id)
          await waitTask(task.id, true)
        }
      }
  }
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
  console.error(failure)
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null)
    worker.kill("SIGTERM")
  if (workerDone) await Promise.race([workerDone, delay(15000)])
  if (worker && worker.exitCode === null && worker.signalCode === null)
    process.kill(-worker.pid!, "SIGKILL")
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const ids = Object.values(setup.tasks).flatMap((t) => (t.id ? [t.id] : []))
  const attempts = (
    await pool.query(
      "SELECT task_id,segment_no,decision_no,attempt_no,model,status,usage,cost_micros,error FROM task_model_attempts WHERE task_id=ANY($1::text[]) ORDER BY id",
      [ids]
    )
  ).rows
  const mainAfter = await counts()
  assert.deepEqual(mainAfter, mainBefore)
  assert(originalEnv.equals(await readFile(".env")))
  const totals = Object.fromEntries(
    (["none", "lossy", "semantic"] as Arm[]).map((arm) => {
      const cells = Object.values(setup.cells).filter((c) => c.arm === arm)
      return [
        arm,
        {
          completedCells: cells.length,
          passed: cells.filter((c) => c.passed).length,
          actions: cells.reduce((n, c) => n + Number(c.actionCount), 0),
          decisions: cells.reduce((n, c) => n + Number(c.decisions), 0),
        },
      ]
    })
  )
  const report = {
    startedAt,
    recordedAt: new Date().toISOString(),
    directory,
    ...setup,
    stage: terraRetry ? "terra-single-retry" : preparing ? "prepare" : "run",
    failure,
    totals,
    attempts,
    knownCostMicros: attempts
      .filter((a) => a.cost_micros !== null)
      .reduce((n, a) => n + Number(a.cost_micros), 0),
    unknownAttempts: attempts.filter((a) => a.status === "unknown").length,
    unpricedAttempts: attempts.filter((a) => a.cost_micros === null).length,
    mainBefore,
    mainAfter,
    mainEnvUnchanged: true,
    mainRestarted: false,
    workstationImage: process.env.WORKSTATION_IMAGE,
    freshDesktopPerCell: true,
    limits: [
      "one sample per case and arm",
      "synthetic console, not real Alibaba Cloud",
      "fixture-visible semantic labels, not automated screenshot extraction",
      "not upstream products executed head-to-head",
      "successful source and lossy compilation use Sol; semantic compilation retry and evaluation use Terra",
    ],
  }
  const reportPath = path.join(directory, `report-${Date.now()}.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await writeFile("docs/evidence/manuals-benchmark.json", JSON.stringify(report, null, 2))
  await pool.end()
  await main.end()
  console.log(
    JSON.stringify({
      directory,
      reportPath,
      totals,
      unknownAttempts: report.unknownAttempts,
      knownCostMicros: report.knownCostMicros,
      failure,
    })
  )
}
