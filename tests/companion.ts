// Companion backend against a throwaway database: chat with an injected mock model, memory,
// errand confirmation, the crisis path, life-session scheduling and share delivery.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_companion_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "companion@fixture.test",
  OWNER_PASSWORD: randomUUID(),
})
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)

  const { db, pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  const { companionChat } = await import("@/lib/companion/chat")
  const { listNotes } = await import("@/lib/companion/memory")
  const { cancelErrand, confirmErrand, syncErrands } =
    await import("@/lib/companion/errands")
  const { updateCompanion } = await import("@/lib/companion/store")
  const { startLifeSessions, deliverShares } = await import("@/lib/companion/life")
  const { setCustomPrice } = await import("@/lib/spend")
  const { companionMessages, lifeActivities, lifeShares } = await import("@/db/schema")
  const { eq } = await import("drizzle-orm")

  const ownerId = "companion-owner"
  const agentId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [ownerId]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
    [agentId]
  )

  // Scripted model: each call pops the next reply (tool calls or text)
  const scripted = (steps: Array<Array<Record<string, unknown>>>) => {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        const parts = steps[Math.min(call++, steps.length - 1)]
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              for (const part of parts) controller.enqueue(part as never)
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: parts.some((p) => p.type === "tool-call")
                    ? "tool-calls"
                    : "stop",
                  raw: undefined,
                },
                usage: {
                  inputTokens: {
                    total: 1000,
                    noCache: 1000,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: 200, text: 200, reasoning: 0 },
                },
              })
              controller.close()
            },
          }),
        }
      },
    })
  }
  const text = (value: string) => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: value },
    { type: "text-end", id: "t" },
  ]
  const call = (name: string, input: unknown) => ({
    type: "tool-call",
    toolCallId: randomUUID(),
    toolName: name,
    input: JSON.stringify(input),
  })
  const price = {
    kind: "priced",
    source: "custom",
    price: { input: 1, output: 4 },
  } as const

  // 1. Plain chat: user row, two bubbles, usage with cost
  const first = await companionChat(
    { ownerId, agentId, text: "早" },
    { model: scripted([text("早呀\n\n昨晚睡得好吗")]), price }
  )
  assert.deepEqual(
    first.replies.map((m) => m.content),
    ["早呀", "昨晚睡得好吗"]
  )
  const usage = await pool.query("SELECT cost_micros FROM companion_usage")
  assert.equal(usage.rowCount, 1)
  assert.ok(Number(usage.rows[0].cost_micros) > 0)

  // 2. Memory: remember, then forget; the deleted note is gone and no longer in the prompt
  await companionChat(
    { ownerId, agentId, text: "我对花生过敏" },
    {
      model: scripted([[call("remember", { note: "对花生过敏" })], text("记住了")]),
      price,
    }
  )
  const [note] = await listNotes(agentId)
  assert.equal(note.content, "对花生过敏")
  assert.equal(note.source, "agent")
  let seenPrompt = ""
  const spy = scripted([text("好")])
  const original = spy.doStream.bind(spy)
  spy.doStream = async (options) => {
    seenPrompt = String(options.prompt[0].content)
    return original(options)
  }
  await companionChat({ ownerId, agentId, text: "我吃什么好" }, { model: spy, price })
  assert.match(seenPrompt, /对花生过敏/)
  await companionChat(
    { ownerId, agentId, text: "忘掉过敏的事" },
    { model: scripted([[call("forget", { id: note.id })], text("好，忘了")]), price }
  )
  assert.equal((await listNotes(agentId)).length, 0)
  seenPrompt = ""
  const spy2 = scripted([text("好")])
  const original2 = spy2.doStream.bind(spy2)
  spy2.doStream = async (options) => {
    seenPrompt = String(options.prompt[0].content)
    return original2(options)
  }
  await companionChat({ ownerId, agentId, text: "我吃什么" }, { model: spy2, price })
  assert.doesNotMatch(seenPrompt, /对花生过敏/)

  // 3. Crisis: fixed reply, no model call
  let modelCalled = false
  const crisisModel = scripted([text("x")])
  crisisModel.doStream = async () => {
    modelCalled = true
    throw new Error("must not be called")
  }
  const crisis = await companionChat(
    { ownerId, agentId, text: "我不想活了" },
    { model: crisisModel, price }
  )
  assert.equal(modelCalled, false)
  assert.equal(crisis.replies[0].kind, "crisis")
  assert.match(crisis.replies[0].content, /1925/)

  // 4. Errand: proposal card, UI confirmation starts exactly one task; a second answer is refused
  const proposed = await companionChat(
    { ownerId, agentId, text: "帮我查下明天台北到高雄的高铁" },
    {
      model: scripted([
        [call("propose_errand", { goal: "查明天台北到高雄高铁时刻" })],
        text("我去查，你先确认一下"),
      ]),
      price,
    }
  )
  const card = proposed.replies.find((m) => m.kind === "errand_proposal")!
  assert.equal((card.metadata as { status: string }).status, "pending")
  const taskCount = async () =>
    Number((await pool.query("SELECT count(*) FROM tasks")).rows[0].count)
  assert.equal(await taskCount(), 0, "no task before confirmation")
  const task = await confirmErrand(ownerId, card.id)
  assert.equal(await taskCount(), 1)
  await assert.rejects(confirmErrand(ownerId, card.id), /already answered/)
  await assert.rejects(cancelErrand(ownerId, card.id), /already answered/)
  await assert.rejects(confirmErrand("someone-else", card.id))
  assert.equal(await syncErrands(), 0, "nothing to report while the task is running")
  await pool.query("UPDATE tasks SET status='completed',result=$2 WHERE id=$1", [
    task.taskId,
    JSON.stringify({ summary: "最早一班 07:10" }),
  ])
  assert.equal(await syncErrands(), 1)
  assert.equal(await syncErrands(), 0)
  const [update] = await db
    .select()
    .from(companionMessages)
    .where(eq(companionMessages.kind, "errand_update"))
  assert.match(update.content, /07:10/)

  // 5. Cancelled proposals never start a task
  const second = await companionChat(
    { ownerId, agentId, text: "再帮我订个外卖" },
    {
      model: scripted([[call("propose_errand", { goal: "订外卖" })], text("确认一下")]),
      price,
    }
  )
  const card2 = second.replies.find((m) => m.kind === "errand_proposal")!
  await cancelErrand(ownerId, card2.id)
  await assert.rejects(confirmErrand(ownerId, card2.id), /already answered/)
  assert.equal(await taskCount(), 1)

  // 6. Partner mode needs the 18+ confirmation in the database path too
  await assert.rejects(updateCompanion(ownerId, agentId, { mode: "partner" }), /18/)
  assert.equal(
    (await updateCompanion(ownerId, agentId, { mode: "partner", adultConfirmed: true }))
      .mode,
    "partner"
  )

  // 7. Life sessions: unpriced model is skipped; priced model starts once per slot and is idempotent
  await pool.query("UPDATE tasks SET status='completed' WHERE agent_id=$1", [agentId])
  await updateCompanion(ownerId, agentId, {
    lifeEnabled: true,
    lifeTimes: ["10:30"],
    timeZone: "Asia/Taipei",
  })
  const slot = new Date("2026-11-01T03:00:00Z") // 11:00 in Taipei
  const skipped = await startLifeSessions(slot)
  assert.deepEqual(
    skipped.skipped.map((s) => s.reason),
    ["model has no price"]
  )
  await setCustomPrice("custom/mock", { input: 1, output: 4 })
  const started = await startLifeSessions(slot)
  assert.equal(started.started.length, 1)
  assert.equal((await startLifeSessions(slot)).started.length, 0)
  const lifeTask = await pool.query(
    "SELECT config_snapshot->'lifeSession'->>'prompt' AS prompt, budget FROM tasks WHERE id=$1",
    [started.started[0]]
  )
  assert.match(lifeTask.rows[0].prompt, /小满/)
  assert.ok(lifeTask.rows[0].budget.maxCostMicros <= 1_000_000_000)
  // A person's errand preempts a running life session
  const { submitTask } = await import("@/lib/tasks")
  await submitTask(ownerId, "companion", {
    agentId,
    goal: "插队的任务",
    clientRequestId: randomUUID(),
    timeZone: "Asia/Taipei",
    completionContract: { requireHumanReview: false },
    budget: { maxSteps: 10 },
  })
  const preempted = await pool.query(
    "SELECT cancel_requested_at FROM tasks WHERE id=$1",
    [started.started[0]]
  )
  assert.ok(preempted.rows[0].cancel_requested_at, "life session is asked to stop")

  // 8. Shares: delivered into the chat once, respecting the daily limit and quiet hours
  await pool.query("UPDATE tasks SET status='completed' WHERE agent_id=$1", [agentId])
  const [activity] = await db
    .insert(lifeActivities)
    .values({
      agentId,
      taskId: started.started[0],
      kind: "read",
      title: "一篇咖啡文章",
      summary: "写手冲",
      url: "https://example.com/coffee",
    })
    .returning()
  await db
    .insert(lifeShares)
    .values({ agentId, activityId: activity.id, text: "看到这篇，想起你喜欢咖啡" })
  assert.deepEqual(
    await deliverShares(new Date("2026-11-01T16:00:00Z")),
    [],
    "23:00 is quiet"
  )
  assert.equal((await deliverShares(new Date("2026-11-01T04:00:00Z"))).length, 1)
  assert.equal((await deliverShares(new Date("2026-11-01T04:30:00Z"))).length, 0)
  const [share] = await db
    .select()
    .from(companionMessages)
    .where(eq(companionMessages.kind, "share"))
  assert.match(share.content, /example\.com\/coffee/)

  await closeDurableClient()
  await pool.end()
  console.log("companion integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
