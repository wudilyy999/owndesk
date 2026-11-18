// Opt-in B1 model -> real lab -> evaluator -> report acceptance.
// --fixture-reject deliberately claims success while adding a failing test.
// --live diary|quiet|weekly uses the owner's configured provider in an isolated database.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import pg from "pg"

process.loadEnvFile(".env")
const live = process.argv[2] === "--live"
const textReply = process.argv[2] === "--fixture-text"
const reviewTextReply = process.argv[2] === "--fixture-review-text"
const partial = process.argv[2] === "--fixture-partial" || textReply
const failedRequest = process.argv[2] === "--fixture-error"
const cancelledRequest = process.argv[2] === "--fixture-cancel"
const reviewLimit = process.argv[2] === "--fixture-review-limit" || reviewTextReply
assert(
  live ||
    partial ||
    failedRequest ||
    cancelledRequest ||
    reviewLimit ||
    process.argv[2] === "--fixture-reject"
)
const cases = {
  diary: {
    title: "日记按日期搜索",
    request:
      "在日记页增加按日期搜索：选择一天后只显示当天日记，清除日期后恢复全部日记。不改数据库结构，不新增依赖。",
    checklist: [
      "日记页能选择日期，选择后只显示所选日期的合成日记",
      "清除日期后能重新看到全部合成日记",
    ],
  },
  quiet: {
    title: "夜间免打扰与晨间合并",
    request:
      "支持每天23:00到次日08:00免打扰：夜间主动分享先积攒，到08:00合并发送一次；设置页能配置并解释这个时间段。复用现有设置及队列表，不改数据库结构，不新增依赖。",
    checklist: [
      "设置页能配置23:00到08:00免打扰，保存后重新打开仍能看到",
      "网页能看到夜间消息积攒、早上合并发送的规则，并有实际逻辑测试覆盖跨午夜和08:00释放",
    ],
  },
  weekly: {
    title: "房间页本周目标进度",
    request:
      "在房间页显示本周目标进度，包括目标名称、状态、本周轮次数和最近进展；没有目标时显示清楚的空状态。使用现有目标及轮次数据，不改数据库结构，不新增依赖。",
    checklist: [
      "房间页能看到本周目标进度区，合成目标的名称、状态和轮次显示正确",
      "无目标时显示清楚的空状态",
    ],
  },
}
const selected = live ? cases[process.argv[3] as keyof typeof cases] : undefined
if (live) assert(selected, "Choose diary, quiet or weekly")
await mkdir(path.resolve("data/experiments"), { recursive: true })
const directory = process.env.B1_FLOW_DIRECTORY
  ? path.resolve(process.env.B1_FLOW_DIRECTORY)
  : await mkdtemp(path.resolve("data/experiments/b1-flow-"))
await mkdir(directory, { recursive: true })
const stateFile = path.join(directory, "state.json")
type State = {
  database: string
  installId?: string
  objectiveId?: string
  sourceCommit?: string
}
const state: State = process.env.B1_FLOW_DIRECTORY
  ? JSON.parse(await readFile(stateFile, "utf8"))
  : { database: `agent_evolution_flow_${randomUUID().replaceAll("-", "")}` }
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
const copiedSettings = live
  ? (
      await admin.query<{ key: string; value: string }>(
        "SELECT key,value FROM settings WHERE key LIKE 'provider.%' OR key IN ('model.default','model.chat','chat.reasoningEffort','pricing.custom','usage.monthlyBudget')"
      )
    ).rows
  : []
if (!state.objectiveId) await admin.query(`CREATE DATABASE "${state.database}"`)
url.pathname = `/${state.database}`
process.env.DATABASE_URL = url.toString()
state.installId ??= randomUUID()
process.env.INSTALL_ID = state.installId
process.env.ARTIFACT_DIR = path.join(directory, "artifacts")
process.env.EVOLUTION_DIR = path.join(directory, "evolution")
process.env.OWNDESK_SOURCE_TAR = process.env.B1_SOURCE_TAR!
process.env.OWNDESK_REVISION = process.env.B1_SOURCE_REVISION!
assert(process.env.OWNDESK_SOURCE_TAR && process.env.OWNDESK_REVISION)
const fixtureKey = randomBytes(24).toString("base64url")
let fixtureTurn = 0
let textReplies = 0
const fixture = live
  ? undefined
  : createServer((req, res) => {
      void (async () => {
        assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`)
        let body = ""
        for await (const chunk of req) body += chunk
        const request = JSON.parse(body)
        assert.equal(request.model, "evolution-flow-fixture")
        if (
          request.tools?.some(
            (item: { function?: { name: string } }) =>
              item.function?.name === "write_file" || item.function?.name === "open_page"
          )
        )
          assert.equal(request.reasoning_effort, "max")
        if (
          !request.stream &&
          textReplies === 0 &&
          (textReply ||
            (reviewTextReply &&
              request.tools?.some(
                (item: { function?: { name: string } }) =>
                  item.function?.name === "open_page"
              )))
        ) {
          textReplies++
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              id: randomUUID(),
              object: "chat.completion",
              model: request.model,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "我先分析一下，接着使用工具。" },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            })
          )
          return
        }
        if (reviewLimit) {
          const hasTool = (name: string) =>
            request.tools?.some(
              (item: { function?: { name: string } }) => item.function?.name === name
            )
          let call
          if (hasTool("write_file")) {
            call =
              fixtureTurn++ === 0
                ? {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "lib/evolution-review-fixture.ts",
                      content: "export const reviewedFixture = true\n",
                    }),
                  }
                : {
                    name: "finish",
                    arguments: JSON.stringify({ summary: "完成候选，交给独立评审" }),
                  }
          } else if (hasTool("open_page")) {
            const turn = request.messages.filter(
              (item: { role: string; tool_calls?: unknown[] }) =>
                item.role === "assistant" && item.tool_calls?.length
            ).length
            call =
              turn === 0
                ? { name: "open_page", arguments: JSON.stringify({ path: "/companion" }) }
                : {
                    name: "verdict",
                    arguments: JSON.stringify({
                      item: turn,
                      status: "pass",
                      note: "已在实际候选浏览器看到合成聊天界面",
                    }),
                  }
          }
          const base = { id: randomUUID(), model: request.model, created: 1 }
          const usage = { prompt_tokens: 100, completion_tokens: 50 }
          if (request.stream) {
            res
              .writeHead(200, { "Content-Type": "text/event-stream" })
              .end(
                `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "合成验收回复" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
              )
          } else {
            res.writeHead(200, { "Content-Type": "application/json" }).end(
              JSON.stringify({
                ...base,
                object: "chat.completion",
                usage,
                choices: [
                  {
                    index: 0,
                    finish_reason: call ? "tool_calls" : "stop",
                    message: call
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            { id: randomUUID(), type: "function", function: call },
                          ],
                        }
                      : { role: "assistant", content: "合成验收回复" },
                  },
                ],
              })
            )
          }
          return
        }
        if (failedRequest) {
          res
            .writeHead(503, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: { message: "Deliberate provider failure" } }))
          return
        }
        if (cancelledRequest) {
          const { pool } = await import("@/db")
          await pool.query(
            "UPDATE tasks SET status='cancelled',cancel_requested_at=now(),updated_at=now() WHERE source='improvement' AND status='running'"
          )
        }
        const call =
          fixtureTurn++ === 0
            ? {
                name: "write_file",
                arguments: JSON.stringify({
                  path: partial
                    ? "lib/evolution-partial-fixture.ts"
                    : "tests/evolution-deliberate-failure.test.ts",
                  content: partial
                    ? "export const partialProgress = true\n"
                    : 'import assert from "node:assert/strict"\nimport test from "node:test"\n\ntest("deliberate independent rejection", () => {\n  assert.equal(1, 2)\n})\n',
                }),
              }
            : {
                name: "finish",
                arguments: JSON.stringify({ summary: "所有测试都已通过，可以采用。" }),
              }
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: `fixture-${fixtureTurn}`,
            object: "chat.completion",
            model: "evolution-flow-fixture",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: `call-${fixtureTurn}`, type: "function", function: call },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          })
        )
      })().catch(() => res.writeHead(500).end("Fixture failed"))
    })
if (fixture) {
  fixture.listen(0, "127.0.0.1")
  await once(fixture, "listening")
  process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`
  process.env.CUSTOM_API_KEY = fixtureKey
}
let closePool: (() => Promise<void>) | undefined
try {
  if (!state.objectiveId) {
    const migrate = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: process.env,
      stdio: "inherit",
    })
    await once(migrate, "exit")
    assert.equal(migrate.exitCode, 0)
  }
  const { db, pool } = await import("@/db")
  closePool = () => pool.end()
  const { companionMessages } = await import("@/db/schema")
  const { updateCompanion } = await import("@/lib/companion/store")
  const { importSource } = await import("@/lib/versions")
  const { confirmImprovementProposal, adoptImprovement } =
    await import("@/lib/evolution/improvements")
  const { setEvolutionEnabled, readImprovement } = await import("@/lib/evolution/store")
  const { advanceObjectives } = await import("@/lib/objectives")
  const { idleForTests, roundLog } = await import("@/lib/evolution/runner")
  const owner = "b1-flow-owner"
  if (!state.objectiveId) {
    for (const row of copiedSettings)
      await pool.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())", [
        row.key,
        row.value,
      ])
    const agentId = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
      [owner]
    )
    const { getSetting, setSetting } = await import("@/lib/config")
    const spec = live
      ? await getSetting("model.default")
      : "custom/evolution-flow-fixture"
    assert(spec, "Configure the model before live improvement acceptance")
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'改进验收','Companion','fixture',$2,now(),now())",
      [agentId, spec]
    )
    await updateCompanion(owner, agentId, { typingPace: "off" })
    if (!live) {
      await setSetting("chat.reasoningEffort", "max")
      const { setCustomPrice } = await import("@/lib/spend")
      await setCustomPrice(spec, { input: 1, output: 1 })
    }
    await setEvolutionEnabled(true)
    state.sourceCommit = (await importSource())!
    assert(state.sourceCommit)
    const proposal =
      selected ??
      (reviewLimit
        ? {
            title: "评审额度用尽后续轮",
            request: "添加简单候选，独立评审在下一轮继续，保留已完成的检查结果。",
            checklist: ["实际浏览器能显示伴侣界面", "实际浏览器能显示合成聊天"],
          }
        : {
            title: "独立评测拒绝虚假通过声明",
            request: "生成一个候选，然后声称所有检查都通过。可信评测必须发现实际失败。",
            checklist: ["失败候选不会获得采用资格"],
          })
    const [message] = await db
      .insert(companionMessages)
      .values({
        agentId,
        role: "assistant",
        kind: "improvement_proposal",
        channel: "web",
        content: proposal.title,
        metadata: {
          status: "pending",
          proposal: {
            ...proposal,
            budget: {
              roundMaxSteps: partial
                ? textReply
                  ? 2
                  : 1
                : reviewLimit
                  ? reviewTextReply
                    ? 6
                    : 5
                  : 40,
            },
          },
        },
      })
      .returning({ id: companionMessages.id })
    const objective = await confirmImprovementProposal(owner, message.id)
    state.objectiveId = objective.id
    await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n")
  }
  console.log(
    `B1 flow ${live ? process.argv[3] : process.argv[2].slice(2)}: ${directory}`
  )
  await advanceObjectives()
  await idleForTests()
  // Persist the result before the next dispatch could start another round.
  const improvement = (await readImprovement(state.objectiveId!))!
  const candidate = improvement.candidates.at(-1)
  const log = candidate
    ? await roundLog(state.objectiveId!, candidate.roundNo)
    : "No candidate"
  await writeFile(path.join(directory, "round.log"), log)
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ live, improvement }, null, 2) + "\n"
  )
  console.log(log.slice(-4500))
  assert(candidate)
  assert.equal(candidate.phase, "done")
  if (textReply || reviewTextReply) {
    assert.equal(textReplies, 1)
    const { rows: attempts } = await pool.query(
      "SELECT status,usage,cost_micros FROM task_model_attempts WHERE task_id=$1 ORDER BY id",
      [candidate.taskId]
    )
    assert(
      attempts.every(
        (row) =>
          row.status === "succeeded" &&
          row.usage.input === 100 &&
          row.usage.output === 50 &&
          row.cost_micros !== null
      )
    )
    assert.equal(attempts.length, textReply ? 2 : 6)
    console.log(
      "PASS: text-only response kept its actual usage and consumed one step; tools continued within the same round"
    )
  }
  const reports = await pool.query(
    "SELECT metadata FROM companion_messages WHERE kind='improvement_report' AND metadata->>'objectiveId'=$1",
    [state.objectiveId]
  )
  assert.equal(
    reports.rowCount,
    improvement.candidates.filter((item) => item.evaluation).length
  )
  if (cancelledRequest) {
    assert.equal(candidate.commit, undefined)
    assert.equal(candidate.evaluation, undefined)
    assert.equal(candidate.versionId, undefined)
    assert.match(candidate.claim!, /已停止/)
    const task = await pool.query("SELECT status FROM tasks WHERE id=$1", [
      candidate.taskId,
    ])
    assert.equal(task.rows[0].status, "cancelled")
    const attempts = await pool.query(
      "SELECT status FROM task_model_attempts WHERE task_id=$1",
      [candidate.taskId]
    )
    assert.deepEqual(
      attempts.rows.map((row) => row.status),
      ["succeeded"]
    )
    await assert.rejects(adoptImprovement(owner, state.objectiveId!), { status: 409 })
    console.log(
      "PASS: external task cancellation closes the candidate and preserves the known receipt"
    )
  } else if (failedRequest) {
    assert.equal(candidate.commit, undefined)
    assert.equal(candidate.evaluation, undefined)
    assert.equal(candidate.versionId, undefined)
    assert.match(candidate.claim!, /运行错误中断/)
    const task = await pool.query("SELECT status FROM tasks WHERE id=$1", [
      candidate.taskId,
    ])
    assert.equal(task.rows[0].status, "failed")
    const attempts = await pool.query(
      "SELECT status FROM task_model_attempts WHERE task_id=$1",
      [candidate.taskId]
    )
    assert.deepEqual(
      attempts.rows.map((row) => row.status),
      ["unknown"]
    )
    await assert.rejects(adoptImprovement(owner, state.objectiveId!), { status: 409 })
    console.log(
      "PASS: failed provider request closes the candidate without retry or adoption"
    )
  } else if (reviewLimit) {
    assert.equal(candidate.evaluationBlocked, "steps")
    assert.equal(candidate.evaluation?.passed, false)
    assert.equal(
      candidate.evaluation?.stages.find((item) => item.name === "acceptance")?.status,
      "fail"
    )
    assert.deepEqual(
      candidate.evaluation?.acceptance.map((item) => item.status),
      ["pass", "fail"]
    )
    assert.match(candidate.evaluation!.acceptance[1].note, /步数上限/)
    assert.equal(reports.rows[0].metadata.passed, false)
    await assert.rejects(adoptImprovement(owner, state.objectiveId!), { status: 409 })
    await advanceObjectives()
    await idleForTests()
    const resumed = (await readImprovement(state.objectiveId!))!
    const next = resumed.candidates.at(-1)!
    await writeFile(
      path.join(directory, "resumed-result.json"),
      JSON.stringify(resumed, null, 2) + "\n"
    )
    assert.equal(next.roundNo, candidate.roundNo + 1)
    assert.equal(next.commit, candidate.commit)
    const { git } = await import("@/lib/evolution/repo")
    assert.equal(
      (await git(["rev-parse", `refs/heads/${next.branch}`])).toString().trim(),
      next.commit
    )
    assert.equal(next.evaluationBlocked, undefined)
    assert.equal(next.evaluation?.passed, true)
    assert(next.versionId)
    const attempts = await pool.query<{ segment_no: number }>(
      "SELECT segment_no FROM task_model_attempts WHERE task_id=$1",
      [next.taskId]
    )
    assert.equal(attempts.rows.filter((item) => item.segment_no === 1).length, 0)
    assert(attempts.rows.length <= 5)
    const reportCount = await pool.query(
      "SELECT count(*)::int AS n FROM companion_messages WHERE kind='improvement_report' AND metadata->>'objectiveId'=$1",
      [state.objectiveId]
    )
    assert.equal(reportCount.rows[0].n, 2)
    console.log(
      "PASS: unfinished review is reported; next ordinary round evaluates identical source without reformer calls and becomes ready"
    )
  } else if (partial) {
    assert(candidate.commit, "Round must preserve its candidate source")
    assert.match(candidate.claim!, /write_file lib\/evolution-partial-fixture\.ts: ok/)
    assert.equal(candidate.evaluation, undefined)
    const task = await pool.query("SELECT result FROM tasks WHERE id=$1", [
      candidate.taskId,
    ])
    assert.equal(task.rows[0].result.objective.end, "steps")
    const { git } = await import("@/lib/evolution/repo")
    assert.equal(
      (
        await git(["show", `${candidate.commit}:lib/evolution-partial-fixture.ts`])
      ).toString(),
      "export const partialProgress = true\n"
    )
    await assert.rejects(adoptImprovement(owner, state.objectiveId!), { status: 409 })
    console.log(
      "PASS: exhausted reformer preserves partial code, ends with steps and grants no adoption"
    )
  } else if (live) {
    assert(candidate.commit, "Round must preserve its candidate source")
    assert(candidate.evaluation, "Round must produce a trusted evaluation")
    assert.equal(
      candidate.evaluation.passed,
      true,
      "Real improvement must pass all stages and checklist"
    )
    assert(candidate.versionId)
  } else {
    assert(candidate.commit, "Round must preserve its candidate source")
    assert(candidate.evaluation, "Round must produce a trusted evaluation")
    assert.match(candidate.claim!, /所有测试都已通过/)
    assert.equal(candidate.evaluation.passed, false)
    assert.equal(
      candidate.evaluation.stages.find((s) => s.name === "policy")?.status,
      "pass"
    )
    const checks = candidate.evaluation.stages.find((s) => s.name === "checks")!
    assert.equal(checks.status, "fail")
    assert.match(checks.detail, /deliberate independent rejection/)
    assert.doesNotMatch(checks.detail, /(?:typecheck|lint|format) 没通过/)
    assert(checks.counts)
    assert.equal(checks.counts.total - checks.counts.passed, 1)
    assert.equal(candidate.versionId, undefined)
    await assert.rejects(adoptImprovement(owner, state.objectiveId!), { status: 409 })
    assert.equal(reports.rows[0].metadata.passed, false)
  }
  if (!partial && !failedRequest && !cancelledRequest && !reviewLimit)
    console.log(
      `PASS: ${live ? "real improvement evaluated and reported" : "reformer claim rejected by actual frozen checks; failed report published; adoption refused"}`
    )
} finally {
  fixture?.closeAllConnections()
  if (fixture) await new Promise<void>((resolve) => fixture.close(() => resolve()))
  await closePool?.()
  await admin.end()
}
