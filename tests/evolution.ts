// B1 runtime checks: real PostgreSQL, HTTP gateway and Git policy evaluation.
// Run with --database-only while provisioning Docker; the default also checks the lab.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import pg from "pg"
import type { ObjectiveBudget } from "@/db/schema"
import type { ModelMessage } from "ai"
import type { Gateway } from "@/lib/evolution/gateway"
import type { CandidateStack } from "@/lib/evolution/evaluator"

if (existsSync(".env")) process.loadEnvFile(".env")
if (process.env.B1_SOURCE_TAR) process.env.OWNDESK_SOURCE_TAR = process.env.B1_SOURCE_TAR
const database = `agent_evolution_${randomUUID().replaceAll("-", "")}`
const parent = path.resolve("data/experiments")
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, "b1-"))
process.env.EVOLUTION_DIR = path.join(directory, "evolution")
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
const exec = promisify(execFile)
const fixtureGit = (args: string[]) => exec("git", ["-c", "safe.directory=*", ...args])
const checks: string[] = []
const pass = (name: string) => {
  checks.push(name)
  console.log(`PASS ${checks.length}: ${name}`)
}
let upstreamCalls = 0
let upstreamStatus = 200
let upstreamUsage: "full" | "incomplete" = "full"
let reviewTurn = 0
const upstreamKey = randomBytes(24).toString("base64url")
const upstream = createServer((req, res) => {
  void (async () => {
    assert.equal(req.headers.authorization, `Bearer ${upstreamKey}`)
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    assert.equal(body.model, "b1-fixture")
    upstreamCalls++
    await delay(75)
    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus).end(JSON.stringify({ error: upstreamKey }))
      return
    }
    const usage =
      upstreamUsage === "full"
        ? { prompt_tokens: 1000, completion_tokens: 1000 }
        : { prompt_tokens: 1000 }
    const reviewing = body.tools?.some(
      (item: { function?: { name?: string } }) => item.function?.name === "open_page"
    )
    const reviewCall =
      reviewTurn++ === 0
        ? { name: "open_page", arguments: JSON.stringify({ path: "/companion" }) }
        : {
            name: "verdict",
            arguments: JSON.stringify({
              item: 1,
              status: "pass",
              note: "已在实际候选浏览器打开伴侣页面并保存截图",
            }),
          }
    if (!reviewing) reviewTurn--
    const choice = {
      message: { role: "assistant", content: "合成回复" },
      finish_reason: "stop",
      index: 0,
    }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const base = {
        id: "fixture",
        object: "chat.completion.chunk",
        model: body.model,
        created: 1,
      }
      res.end(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "合成回复" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
      )
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          model: body.model,
          choices: reviewing
            ? [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `review-${reviewTurn}`,
                        type: "function",
                        function: reviewCall,
                      },
                    ],
                  },
                },
              ]
            : [choice],
          usage,
        })
      )
    }
  })().catch(() => res.writeHead(500).end("Fixture failure"))
})
upstream.listen(0, "127.0.0.1")
await once(upstream, "listening")
process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
process.env.CUSTOM_API_KEY = upstreamKey
const gateways: Gateway[] = []
let passed = false
let closePool: (() => Promise<void>) | undefined
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)
  const { pool } = await import("@/db")
  closePool = () => pool.end()
  const { db } = await import("@/db")
  const { objectives } = await import("@/db/schema")
  const { eq } = await import("drizzle-orm")
  const { createObjective, objectiveUsage } = await import("@/lib/objectives")
  const { setCustomPrice } = await import("@/lib/spend")
  const { startGateway } = await import("@/lib/evolution/gateway")
  const { beginAttempt, finishAttempt, LabBudgetError, spendBlock } =
    await import("@/lib/evolution/meter")
  const { sanitizedSeed } = await import("@/lib/evolution/snapshot")
  const { policyStage, evaluate, CandidateSession } =
    await import("@/lib/evolution/evaluator")
  const { writeImprovement, readImprovement } = await import("@/lib/evolution/store")
  const { adoptImprovement, watchAdoptions } =
    await import("@/lib/evolution/improvements")
  const { updateCompanion } = await import("@/lib/companion/store")
  const owner = "b1-runtime-owner"
  const agentId = randomUUID()
  const spec = "custom/b1-fixture"
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [owner]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'B1','Assistant','fixture',$2,now(),now())",
    [agentId, spec]
  )
  await updateCompanion(owner, agentId, { typingPace: "off" })
  await setCustomPrice(spec, { input: 1, output: 1 })
  const setting = (key: string, value: string) =>
    pool.query(
      "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, value]
    )
  const taskFor = async (budget: Partial<ObjectiveBudget> = {}) => {
    const objective = await createObjective(
      owner,
      {
        agentId,
        title: "B1 runtime",
        objective: "Synthetic improvement",
        doneCriteria: "Runtime proof",
        budget: { roundMaxSteps: 40, ...budget },
      },
      `improvement:${randomUUID()}`
    )
    const taskId = randomUUID()
    await pool.query(
      `INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,completion_contract,config_snapshot,budget,objective_id,created_at,updated_at)
       VALUES($1,$2,$3,'improvement',$1,'{}','B1 runtime','running','{}',$4,'{}',$5,now(),now())`,
      [
        taskId,
        owner,
        agentId,
        JSON.stringify({ model: spec, runtime: "agent", instructions: "", memories: [] }),
        objective.id,
      ]
    )
    await pool.query(
      "INSERT INTO objective_rounds(id,objective_id,round_no,input,task_id,started_at) VALUES($1,$2,1,'{}',$3,now())",
      [randomUUID(), objective.id, taskId]
    )
    return { objective, taskId }
  }
  // Actual HTTP model adapter + task ledger: identical reads fit, distinct ones force
  // one billed summary and the next normal turn reuses its checkpoint.
  {
    const { labContext } = await import("@/lib/evolution/context")
    const { createModel, modelContextWindow } = await import("@/lib/providers/registry")
    const { taskId, objective } = await taskFor()
    const request = labContext({
      taskId,
      segment: 1,
      spec,
      model: await createModel(spec),
      tools: {},
      output: 8000,
      timeout: 30000,
    })
    const history: ModelMessage[] = [
      { role: "user", content: "Only inspect the synthetic fixture." },
    ]
    const add = (value: string) => {
      const id = `file-${history.length}`
      history.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "read_file",
              toolCallId: id,
              input: { path: "test.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "read_file",
              toolCallId: id,
              output: { type: "text", value },
            },
          ],
        }
      )
    }
    const n = Math.ceil(modelContextWindow(spec) / 3300)
    for (let i = 0; i < n; i++) add("x".repeat(11000))
    await request(history)
    assert.equal((await objectiveUsage(objective.id)).steps, 1)
    for (let i = 0; i < n; i++) add(String(i) + "y".repeat(11000))
    await request(history)
    assert.equal((await objectiveUsage(objective.id)).steps, 3)
    add("next small read")
    await request(history)
    assert.equal((await objectiveUsage(objective.id)).steps, 4)
    pass(
      "Lab folds identical reads without a summary, bills one summary at overflow, and reuses it the next turn"
    )
  }
  const gatewayFor = async (budget: Partial<ObjectiveBudget> = {}) => {
    const fixture = await taskFor(budget)
    const blocked: string[] = []
    const gateway = await startGateway({
      host: "127.0.0.1",
      taskId: fixture.taskId,
      spec,
      objective: async () =>
        (
          await db
            .select()
            .from(objectives)
            .where(eq(objectives.id, fixture.objective.id))
        )[0],
      onBlocked: async (reason) => {
        blocked.push(reason)
      },
    })
    gateways.push(gateway)
    return { ...fixture, gateway, blocked }
  }
  const request = (gateway: Gateway, stream = false) =>
    fetch(`${gateway.url}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "lab",
        messages: [{ role: "user", content: "合成消息" }],
        stream,
      }),
      signal: AbortSignal.timeout(15000),
    })

  const lastRound = await gatewayFor({ maxRounds: 1 })
  assert.equal(await spendBlock(lastRound.objective, spec), null)
  const reply = await request(lastRound.gateway)
  assert.equal(reply.status, 200)
  await reply.text()
  assert.equal((await objectiveUsage(lastRound.objective.id)).steps, 1)
  assert.equal((await objectiveUsage(lastRound.objective.id)).costMicros, 2000)
  pass("maxRounds=1 allows its allocated round; gateway receipts count steps and cost")

  const capped = await gatewayFor({ maxCostMicros: 1000 })
  const beforeCapped = upstreamCalls
  const concurrent = await Promise.all([request(capped.gateway), request(capped.gateway)])
  for (const response of concurrent) await response.text()
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 402])
  assert.equal(upstreamCalls - beforeCapped, 1)
  assert.equal(capped.blocked.length, 1)
  pass("concurrent candidate requests serialize against the improvement cost cap")

  await setting("usage.monthlyBudget", "0")
  const monthly = await gatewayFor()
  const beforeMonthly = upstreamCalls
  const denied = await request(monthly.gateway)
  assert.equal(denied.status, 402)
  await denied.text()
  assert.equal(upstreamCalls, beforeMonthly)
  assert.equal(monthly.blocked.length, 1)
  pass("monthly budget blocks an improvement with no owner-specific limits")

  await setting("usage.monthlyBudget", "")
  const unlimited = await gatewayFor()
  for (let i = 0; i < 2; i++) {
    const response = await request(unlimited.gateway, true)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /\[DONE\]/)
  }
  assert.equal((await objectiveUsage(unlimited.objective.id)).costMicros, 4000)
  pass("no default cost cap; streamed usage is metered")

  const steps = await gatewayFor({ maxSteps: 1 })
  for (const status of [200, 402]) {
    const response = await request(steps.gateway)
    assert.equal(response.status, status)
    await response.text()
  }
  pass("owner step limit is enforced on lab requests")
  const roundSteps = await gatewayFor({ roundMaxSteps: 1 })
  const beforeRoundSteps = upstreamCalls
  const roundResponses = await Promise.all([
    request(roundSteps.gateway),
    request(roundSteps.gateway),
  ])
  for (const response of roundResponses) await response.text()
  assert.deepEqual(roundResponses.map((response) => response.status).sort(), [200, 402])
  assert.equal(upstreamCalls - beforeRoundSteps, 1)
  await assert.rejects(beginAttempt(roundSteps.taskId, 2, spec), (error: unknown) => {
    assert(error instanceof LabBudgetError)
    assert.equal(error.end, "steps")
    return true
  })
  pass("one frozen round allowance covers concurrent gateway and reviewer requests")
  const beforeInvalid = upstreamCalls
  assert.equal((await fetch(`${unlimited.gateway.url}/models`)).status, 401)
  const invalid = await fetch(`${unlimited.gateway.url}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${unlimited.gateway.token}` },
    body: "null",
  })
  assert.equal(invalid.status, 400)
  await invalid.text()
  assert.equal(upstreamCalls, beforeInvalid)
  pass("invalid token and malformed body cannot call the provider")

  upstreamStatus = 400
  const providerError = await request(unlimited.gateway)
  assert.equal(providerError.status, 400)
  assert(!(await providerError.text()).includes(upstreamKey))
  upstreamStatus = 200
  pass("provider error text cannot disclose its real credential to a candidate")
  const incomplete = await gatewayFor({ maxCostMicros: 5000 })
  upstreamUsage = "incomplete"
  const missingUsage = await request(incomplete.gateway)
  assert.equal(missingUsage.status, 200)
  await missingUsage.text()
  upstreamUsage = "full"
  assert.equal((await objectiveUsage(incomplete.objective.id)).unknownCost, 1)
  const blockedMissingUsage = await request(incomplete.gateway)
  assert.equal(blockedMissingUsage.status, 402)
  await blockedMissingUsage.text()
  pass("incomplete upstream usage stays unknown and blocks a bounded retry")
  const uncertain = await taskFor({ maxCostMicros: 5000 })
  const attempt = await beginAttempt(uncertain.taskId, 1, spec)
  await finishAttempt(
    attempt.id,
    attempt.price,
    null,
    "Simulated uncertain model response"
  )
  await assert.rejects(beginAttempt(uncertain.taskId, 1, spec), LabBudgetError)
  pass("unknown model cost prevents a bounded improvement from silently retrying")

  const session = new CandidateSession({
    webUrl: "http://127.0.0.1:6797",
    appUrl: "http://web:6797",
  } as never)
  for (const route of ["https://example.com/", "//example.com/", "/\\example.com/"])
    await assert.rejects(session.request("GET", route), /候选网页/)
  pass("reviewer URLs cannot send the candidate owner cookie to another origin")

  const marker = randomBytes(24).toString("base64url")
  await pool.query(
    "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at) VALUES($1,$2,'user','chat',$3,'web',now())",
    [randomUUID(), agentId, marker]
  )
  const { setSetting } = await import("@/lib/config")
  await setSetting("provider.custom.apiKey", marker)
  const seed = await sanitizedSeed({
    labPriceSpec: "custom/lab",
    labPrice: { input: 1, output: 1 },
  })
  assert(!seed.sql.includes(marker))
  assert(!seed.sql.includes(upstreamKey))
  assert(seed.sql.includes("（合成）"))
  assert(!seed.sql.includes('"model":"custom/b1-fixture"'))
  assert(seed.sql.includes('"model":"custom/lab"'))
  assert(!seed.sql.includes('INSERT INTO "vault_items"'))
  pass(
    "snapshot exports synthetic chat and memories without real chat or secret settings"
  )

  const repo = path.join(directory, "seed")
  const { repoDir, commitTree } = await import("@/lib/evolution/repo")
  await mkdir(repo, { recursive: true })
  await mkdir(process.env.EVOLUTION_DIR!, { recursive: true })
  await fixtureGit(["init", repo])
  await mkdir(path.join(repo, "lib"), { recursive: true })
  await mkdir(path.join(repo, "tests"), { recursive: true })
  await writeFile(path.join(repo, "lib/spend.ts"), "export const budget = true\n")
  await writeFile(path.join(repo, "tests/frozen.test.ts"), "// Frozen test\n")
  await fixtureGit(["-C", repo, "add", "."])
  await fixtureGit([
    "-C",
    repo,
    "-c",
    "user.name=OwnDesk runtime",
    "-c",
    "user.email=runtime@owndesk.local",
    "commit",
    "-m",
    "Trusted policy fixture",
  ])
  await cp(path.join(repo, ".git"), repoDir(), { recursive: true })
  await fixtureGit(["--git-dir", repoDir(), "config", "core.bare", "true"])
  const base = (await fixtureGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim()
  for (const [file, content] of [
    ["tests/frozen.test.ts", "// Replaced by candidate\n"],
    ["lib/spend.ts", "export const budget = false\n"],
    [
      "lib/leaked.ts",
      `export const apiKey = '${["sk", "proj", randomBytes(36).toString("base64url")].join("-")}'\n`,
    ],
  ]) {
    await writeFile(path.join(repo, "lib/spend.ts"), "export const budget = true\n")
    await writeFile(path.join(repo, "tests/frozen.test.ts"), "// Frozen test\n")
    await writeFile(path.join(repo, file), content)
    const commit = await commitTree(
      repo,
      base,
      `cand/${checks.length}`,
      "Adversarial candidate"
    )
    const policy = await policyStage(base, commit)
    assert.equal(policy.status, "fail")
    assert(policy.detail.includes(file), `Policy must identify ${file}`)
    if (file === "lib/leaked.ts") assert.match(policy.detail, /gitleaks:/)
  }
  pass(
    "real Git changes to frozen tests, spend protection and an API-key shape fail policy"
  )
  const failed = await evaluate({
    key: "dishonest",
    baseCommit: base,
    trustedCommit: base,
    commit: (
      await fixtureGit([
        "--git-dir",
        repoDir(),
        "rev-parse",
        `refs/heads/cand/${checks.length - 1}`,
      ])
    ).stdout.trim(),
    labImage: "unused",
    checklist: ["Must pass"],
    request: "Reformer claims all tests passed",
    objective: async () => lastRound.objective,
    taskId: lastRound.taskId,
    spec,
    onBlocked: async () => {},
    log: () => {},
    stopAfter: "policy",
  })
  assert.equal(failed.evaluation.passed, false)
  assert.equal(failed.evaluation.stages[0].status, "fail")
  pass("a reformer's passing claim cannot override the trusted evaluation")

  const version = randomUUID(),
    previousVersion = randomUUID()
  await pool.query(
    `INSERT INTO agent_versions(id,label,kind,status,source_revision,web_image_id,worker_image_id,images,summary,created_at) VALUES($1,'local-runtime','local','rejected','fixture','fixture-web','fixture-worker','{}','Synthetic version',now())`,
    [version]
  )
  await pool.query(
    `INSERT INTO agent_versions(id,label,kind,status,source_revision,web_image_id,worker_image_id,images,summary,created_at) VALUES($1,'previous-runtime','official','retained','previous-fixture','previous-web','previous-worker','{}','Synthetic previous version',now())`,
    [previousVersion]
  )
  const at = new Date().toISOString()
  await writeImprovement({
    objectiveId: lastRound.objective.id,
    ownerId: owner,
    agentId,
    title: "B1 rollback",
    request: "Synthetic",
    checklist: ["Works"],
    baseVersionId: null,
    baseCommit: base,
    status: "adopted",
    candidates: [],
    adoption: { versionId: version, roundNo: 1, at },
    createdAt: at,
    updatedAt: at,
  })
  const stableImprovement = (await readImprovement(lastRound.objective.id))!
  const oldCandidate = await commitTree(
    repo,
    base,
    "cand/stale-adoption",
    "Old candidate"
  )
  await writeFile(path.join(repo, "lib/current.ts"), "export const newer = true\n")
  const currentSource = await commitTree(repo, base, "cand/current", "Newer installation")
  await pool.query(
    "UPDATE agent_versions SET status='active',git_commit=$2 WHERE id=$1",
    [previousVersion, currentSource]
  )
  await writeImprovement({
    ...stableImprovement,
    baseVersionId: previousVersion,
    status: "ready",
    candidates: [
      {
        roundNo: 1,
        branch: "cand/stale-adoption",
        parent: base,
        taskId: lastRound.taskId,
        phase: "done",
        commit: oldCandidate,
        versionId: version,
        evaluation: {
          suiteRevision: base,
          stages: [],
          acceptance: [],
          passed: true,
          startedAt: at,
        },
      },
    ],
  })
  await assert.rejects(adoptImprovement(owner, lastRound.objective.id), {
    status: 409,
    message: "当前版本已更新，请基于当前版本重新发起改进后再采用",
  })
  assert.equal((await readImprovement(lastRound.objective.id))?.status, "ready")
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM deployments")).rows[0].count,
    0
  )
  await pool.query("UPDATE agent_versions SET status='retained' WHERE id=$1", [
    previousVersion,
  ])
  await writeImprovement(stableImprovement)
  pass("an otherwise passing candidate cannot replace a newer unrelated source revision")
  const promotion = randomUUID(),
    rollback = randomUUID()
  await pool.query(
    `INSERT INTO deployments(id,from_version_id,to_version_id,action,status,reason,related_id,health_log,started_at,updated_at,finished_at) VALUES($1,$2,$3,'promote','rolled_back','Synthetic delayed failure',$4,'[]',now(),now(),now())`,
    [promotion, previousVersion, version, rollback]
  )
  await writeImprovement({
    ...stableImprovement,
    adoption: { ...stableImprovement.adoption!, deploymentId: promotion },
  })
  await pool.query(
    `INSERT INTO deployments(id,from_version_id,to_version_id,action,status,reason,health_log,started_at,updated_at,finished_at) VALUES($1,$2,$3,'promote','failed','Unrelated attempt','[]',now()+interval '1 second',now(),now())`,
    [randomUUID(), previousVersion, version]
  )
  await pool.query("UPDATE objectives SET status='paused' WHERE id=$1", [
    lastRound.objective.id,
  ])
  await watchAdoptions()
  assert.equal((await readImprovement(lastRound.objective.id))?.status, "adopted")
  assert.equal(
    (
      await pool.query("SELECT status FROM objectives WHERE id=$1", [
        lastRound.objective.id,
      ])
    ).rows[0].status,
    "paused",
    "A promotion's rolled_back status alone cannot start debug"
  )
  await pool.query(
    `INSERT INTO deployments(id,from_version_id,to_version_id,action,status,reason,related_id,health_log,started_at,updated_at) VALUES($1,$2,$3,'auto_rollback','running','Restoring the previous version',$4,'[]',now(),now())`,
    [rollback, version, previousVersion, promotion]
  )
  await watchAdoptions()
  assert.equal((await readImprovement(lastRound.objective.id))?.feedback, undefined)
  assert.equal(
    (
      await pool.query("SELECT status FROM objectives WHERE id=$1", [
        lastRound.objective.id,
      ])
    ).rows[0].status,
    "paused",
    "Debug must wait while the rollback is running"
  )
  await pool.query(
    "UPDATE deployments SET status='failed',reason='Synthetic old-version health failure' WHERE id=$1",
    [rollback]
  )
  await watchAdoptions()
  const recoveryFailed = await readImprovement(lastRound.objective.id)
  assert.equal(recoveryFailed?.adoption?.outcome, "failed")
  assert.equal(recoveryFailed?.feedback, undefined)
  assert.equal(
    (
      await pool.query("SELECT status FROM objectives WHERE id=$1", [
        lastRound.objective.id,
      ])
    ).rows[0].status,
    "paused",
    "A failed rollback cannot start debug"
  )
  const failureNotice = await pool.query(
    "SELECT content FROM companion_messages WHERE metadata->>'objectiveId'=$1",
    [lastRound.objective.id]
  )
  assert.equal(failureNotice.rows.length, 1)
  assert.match(failureNotice.rows[0].content, /恢复.*未完成/)
  assert.doesNotMatch(failureNotice.rows[0].content, /你可以照常用/)
  await watchAdoptions()
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM companion_messages WHERE metadata->>'objectiveId'=$1",
        [lastRound.objective.id]
      )
    ).rows[0].n,
    1,
    "The failed recovery notice is sent once"
  )
  await pool.query("UPDATE deployments SET status='healthy' WHERE id=$1", [rollback])
  await watchAdoptions()
  const debug = await readImprovement(lastRound.objective.id)
  assert.equal(debug?.status, "working")
  assert.equal(debug?.adoption?.outcome, "auto_rolled_back")
  assert.match(debug?.feedback ?? "", /Reproduce and fix/)
  const notices = await pool.query(
    "SELECT count(*)::int AS n FROM companion_messages WHERE metadata->>'objectiveId'=$1",
    [lastRound.objective.id]
  )
  await watchAdoptions()
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM companion_messages WHERE metadata->>'objectiveId'=$1",
        [lastRound.objective.id]
      )
    ).rows[0].n,
    notices.rows[0].n
  )
  assert.equal(
    (
      await pool.query("SELECT status FROM objectives WHERE id=$1", [
        lastRound.objective.id,
      ])
    ).rows[0].status,
    "active"
  )
  await writeImprovement({
    ...debug!,
    status: "adopted",
    feedback: undefined,
    adoption: { versionId: version, roundNo: 1, at },
  })
  await pool.query(
    "UPDATE deployments SET status='failed',from_version_id=NULL,related_id=NULL,started_at=now()+interval '2 seconds' WHERE id=$1",
    [promotion]
  )
  await watchAdoptions()
  const noPrevious = await readImprovement(lastRound.objective.id)
  assert.equal(noPrevious?.adoption?.outcome, "failed")
  assert.equal(noPrevious?.feedback, undefined)
  assert.equal(
    (
      await pool.query("SELECT status FROM objectives WHERE id=$1", [
        lastRound.objective.id,
      ])
    ).rows[0].status,
    "paused",
    "A failed promotion without a rollback target pauses the objective"
  )
  pass(
    "debug waits for healthy recovery; missing, running and failed rollbacks cannot start it"
  )
  const { improvementOverview } = await import("@/lib/evolution/improvements")
  const single = await improvementOverview(owner)
  assert.equal(single.improvements.length, 1)
  assert.equal(single.improvements[0].objective?.id, lastRound.objective.id)
  assert(debug)
  await writeImprovement({
    ...debug,
    objectiveId: capped.objective.id,
    title: "Second overview item",
    adoption: undefined,
  })
  const multiple = await improvementOverview(owner)
  assert.equal(multiple.improvements.length, 2)
  assert(multiple.improvements.every((item) => item.objective?.id === item.objectiveId))
  pass("improvement overview joins one or several objective ids without an array error")

  if (!process.argv.includes("--database-only")) {
    const { startLab, stopLab } = await import("@/lib/evolution/lab")
    const { docker, dockerRaw } = await import("@/lib/docker")
    const lab = await startLab(
      process.env.B1_LAB_IMAGE ?? "node:24.20.0-bookworm-slim",
      `runtime-${randomUUID().slice(0, 8)}`
    )
    try {
      const inspected = JSON.parse(
        (await docker(["inspect", lab.name])).stdout.toString()
      )[0]
      assert.equal(inspected.HostConfig.NetworkMode, "none")
      assert.equal(
        inspected.Mounts.some((mount: { Source: string }) =>
          mount.Source.includes("docker.sock")
        ),
        false
      )
      const check = await dockerRaw([
        "exec",
        "-w",
        "/tmp",
        lab.name,
        "node",
        "-e",
        'const a=require("node:assert/strict"),fs=require("node:fs"); a(!fs.existsSync("/var/run/docker.sock")); fetch("https://example.com",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1),()=>console.log("network denied"))',
      ])
      assert.equal(check.exitCode, 0, check.stderr)
      assert.match(check.stdout.toString(), /network denied/)
      pass("actual lab denies external network and has no Docker socket")
    } finally {
      await stopLab(lab)
    }
    const { startReviewBrowser } = await import("@/lib/evolution/browser")
    const key = `browser-${randomUUID().slice(0, 8)}`
    const network = `owndesk-b1-${key}`
    const web = `owndesk-b1-cand-${key}-web`
    await docker(["network", "create", "--internal", network])
    try {
      const html =
        '<!doctype html><title>B1 browser</title><input id="date" type="date"><button id="search" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'date\').value">搜索</button><p id="result">请选择日期</p>'
      await docker([
        "run",
        "-d",
        "--name",
        web,
        "--network",
        network,
        "--network-alias",
        "web",
        "--read-only",
        "--cap-drop",
        "ALL",
        "node:24.20.0-bookworm-slim",
        "node",
        "-e",
        `require('node:http').createServer((q,s)=>s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(${JSON.stringify(html)})).listen(6797,'0.0.0.0')`,
      ])
      const review = await startReviewBrowser({
        key,
        network,
        containers: { web },
        appUrl: "http://web:6797",
      } as never)
      try {
        const normal = review.browser.contexts()[0]
        assert(normal, "trusted browser provides a normal profile for PWA tests")
        const page = await normal.newPage()
        await page.goto("http://web:6797")
        const cdp = await normal.newCDPSession(page)
        const installability = (await cdp.send("Page.getInstallabilityErrors")) as {
          installabilityErrors: { errorId: string }[]
        }
        assert(
          !installability.installabilityErrors.some(
            (error) => error.errorId === "in-incognito"
          )
        )
        const { chromium } = await import("playwright")
        const another = await chromium.connectOverCDP(review.endpoint)
        await another.close()
        assert.equal(await page.title(), "B1 browser")
        assert(await page.evaluate(() => window.isSecureContext))
        assert(await page.evaluate(() => "serviceWorker" in navigator))
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
        await page.evaluate(() => navigator.clipboard.writeText("合成剪贴板验收"))
        assert.equal(
          await page.evaluate(() => navigator.clipboard.readText()),
          "合成剪贴板验收"
        )
        await page.locator("input,textarea,select,button,a >> nth=0").fill("2026-11-14")
        await page.locator("input,textarea,select,button,a >> nth=1").click()
        assert.equal(await page.locator("#result").innerText(), "2026-11-14")
        const image = await page.screenshot({
          path: path.join(directory, "browser-proof.png"),
        })
        assert(image.length > 1000)
        pass(
          "trusted review browser renders, fills, clicks and captures a candidate screenshot"
        )
      } finally {
        await review.close()
      }
      await setSetting("provider.custom.apiKey", upstreamKey)
      const { reviewAcceptance } = await import("@/lib/evolution/evaluator")
      const t = await taskFor()
      const candidate = {
        key,
        network,
        containers: { web },
        appUrl: "http://web:6797",
        webUrl: "http://web:6797",
        login: { email: "synthetic", password: randomUUID() },
        gateway: { token: randomUUID() },
        testEnvironment: {},
      } as CandidateStack
      const session = new CandidateSession(candidate)
      session.cookie = "fixture=" + randomUUID()
      const settings = {
        stack: candidate,
        session,
        checklist: ["Check the rendered page"],
        request: "Check the synthetic page",
        changed: [],
        objective: async () => t.objective,
        taskId: t.taskId,
        spec,
        log: () => {},
      }
      reviewTurn = 0
      const first = await reviewAcceptance(settings)
      assert.equal(first[0].status, "pass")
      assert(first[0].screenshot)
      const calls = upstreamCalls
      assert.deepEqual(await reviewAcceptance(settings), first)
      assert.equal(upstreamCalls, calls)
      pass(
        "new browser and reviewer instance restore a confirmed checklist result with its actual screenshot and no repeated model request"
      )
    } finally {
      await dockerRaw(["rm", "-f", web])
      await dockerRaw(["network", "rm", network])
    }
  }
  if (process.argv.includes("--candidate-stack")) {
    assert(process.env.B1_SOURCE_TAR && process.env.B1_SOURCE_REVISION)
    await setSetting("provider.custom.apiKey", upstreamKey)
    const { importSource } = await import("@/lib/versions")
    const { ensureLabImage } = await import("@/lib/evolution/lab")
    const {
      startCandidateStack,
      removeCandidateStack,
      coreChecks,
      frozenRegressions,
      reviewAcceptance,
      leakScan,
    } = await import("@/lib/evolution/evaluator")
    const trusted = await importSource(process.env.B1_SOURCE_REVISION)
    assert(trusted)
    const labImage = await ensureLabImage(trusted)
    const fixture = await taskFor()
    const key = `stack-${randomUUID().slice(0, 8)}`
    let stack: CandidateStack | undefined
    const log = (line: string) => console.log(line)
    const current = async () =>
      (
        await db.select().from(objectives).where(eq(objectives.id, fixture.objective.id))
      )[0]
    try {
      stack = await startCandidateStack({
        key,
        images: {
          web: process.env.B1_WEB_IMAGE ?? "owndesk-web:b1-validation",
          worker: process.env.B1_WORKER_IMAGE ?? "owndesk-worker:b1-validation",
        },
        taskId: fixture.taskId,
        spec,
        objective: current,
        onBlocked: async (reason) => {
          throw new Error(reason)
        },
        log,
      })
      assert.deepEqual(await leakScan(stack), [])
      pass(
        "production candidate environment, database and large filesystem stream contain no installation secret"
      )
      const core = await coreChecks(stack, log)
      await writeFile(
        path.join(directory, "candidate-core.json"),
        JSON.stringify(core.results, null, 2) + "\n"
      )
      if (core.results.some((item) => !item.ok)) {
        const { dockerRaw } = await import("@/lib/docker")
        for (const service of ["web", "worker"] as const) {
          const logs = await dockerRaw(["logs", stack.containers[service]], {
            maxOutputBytes: 4 * 1024 * 1024,
          })
          await writeFile(
            path.join(directory, `candidate-${service}.log`),
            logs.stdout.toString() + logs.stderr,
            { mode: 0o600 }
          )
        }
      }
      assert(
        core.results.every((item) => item.ok),
        core.results
          .filter((item) => !item.ok)
          .map((item) => item.name)
          .join(", ")
      )
      pass(
        "production candidate login, fixture task, deduplication, artifact bytes and gateway chat pass"
      )
      const { default: sharp } = await import("sharp")
      const { docker } = await import("@/lib/docker")
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#5cb8ff" },
      })
        .png()
        .toBuffer()
      const form = new FormData()
      form.set(
        "file",
        new Blob([new Uint8Array(png)], { type: "image/png" }),
        "synthetic.png"
      )
      const uploaded = await fetch(`${stack.webUrl}/api/companion/uploads`, {
        method: "POST",
        headers: { Origin: stack.appUrl, Cookie: core.session.cookie },
        body: form,
      })
      assert.equal(uploaded.status, 201)
      const saved = (await uploaded.json()) as { id: string }
      const image = await core.session.request(
        "GET",
        `/api/companion/uploads/${saved.id}`
      )
      assert.equal(image.status, 200)
      const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata()
      assert.equal(metadata.width, 4)
      assert.equal(metadata.height, 4)
      const stored = await docker([
        "exec",
        stack.containers.worker,
        "find",
        "/app/data/artifacts/companion-images",
        "-name",
        `${saved.id}.jpg`,
      ])
      assert(stored.stdout.toString().trim().endsWith(`/${saved.id}.jpg`))
      pass(
        "candidate Web stores an uploaded picture in the shared volume and both services can read it"
      )
      const regressions = await frozenRegressions({
        stack,
        labImage,
        trustedCommit: trusted,
        commit: trusted,
        changed: [],
        taskId: fixture.taskId,
        log,
      })
      await writeFile(
        path.join(directory, "candidate-regressions.json"),
        JSON.stringify(regressions, null, 2) + "\n"
      )
      assert(
        regressions.every((item) => item.ok),
        regressions
          .filter((item) => !item.ok)
          .map((item) => item.name)
          .join(", ")
      )
      pass(
        "all five frozen task, companion and memory regressions pass in the candidate lab"
      )
      const acceptance = await reviewAcceptance({
        stack,
        session: core.session,
        checklist: ["伴侣页面可在真实浏览器打开并显示测试聊天"],
        request: "验证独立评审的完整模型工具循环与截图归档",
        changed: [],
        objective: current,
        taskId: fixture.taskId,
        spec,
        log,
      })
      const afterReview = upstreamCalls
      const restoredVerdicts = await reviewAcceptance({
        stack,
        session: core.session,
        checklist: ["伴侣页面可在真实浏览器打开并显示测试聊天"],
        request: "验证独立评审的完整模型工具循环与截图归档",
        changed: [],
        objective: current,
        taskId: fixture.taskId,
        spec,
        log,
      })
      assert.deepEqual(restoredVerdicts, acceptance)
      assert.equal(
        upstreamCalls,
        afterReview,
        "a new reviewer instance reuses its verified artifact and does not repeat the UI action or model request"
      )
      assert.equal(acceptance[0].status, "pass")
      assert(acceptance[0].screenshot)
      pass(
        "independent scripted reviewer uses the actual candidate browser and archives a screenshot"
      )
      // Exhaust the shared round allowance during the browser review, after one
      // completed verdict, and retain both reviewed and unfinished checklist items.
      const {
        rows: [{ n: used }],
      } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_model_attempts WHERE task_id=$1",
        [fixture.taskId]
      )
      await pool.query("UPDATE tasks SET budget=$2 WHERE id=$1", [
        fixture.taskId,
        JSON.stringify({ maxSteps: used + 2 }),
      ])
      reviewTurn = 0
      const before = upstreamCalls
      const blocked: string[] = []
      const unfinished = await reviewAcceptance({
        stack,
        session: core.session,
        checklist: ["实际打开伴侣页面并给出结论", "继续检查另一项"],
        request: "检查额度用尽时保留尚未完成的验收结果",
        changed: [],
        objective: current,
        taskId: fixture.taskId,
        spec,
        log,
        onBlocked: async (reason, end) => {
          blocked.push(end)
          assert.match(reason, /步数上限/)
        },
      })
      assert.equal(upstreamCalls - before, 2)
      assert.deepEqual(blocked, ["steps"])
      assert.equal(unfinished[0].status, "pass")
      assert(unfinished[0].screenshot)
      assert.equal(unfinished[1].status, "fail")
      assert.match(unfinished[1].note, /验收尚未完成.*步数上限/)
      pass("exhausted review retains its unfinished checklist and makes no extra request")
    } finally {
      if (stack) await removeCandidateStack(key, stack.gateway)
    }
  }
  passed = true
} finally {
  await Promise.all(gateways.map((gateway) => gateway.close()))
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await closePool?.()
  if (passed) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
  await admin.end()
  const report = {
    passed,
    scope: process.argv.includes("--database-only")
      ? "database-http-policy"
      : "database-http-policy-lab",
    checks,
    databaseRetained: !passed,
    directory,
  }
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n"
  )
  console.log(`B1 evidence: ${path.join(directory, "report.json")}`)
}
