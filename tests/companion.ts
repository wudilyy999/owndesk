// Companion backend against a throwaway database: chat with an injected mock model, memory,
// errand confirmation, the crisis path, life-session scheduling and share delivery.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"
import { adds, asks, decides, numberOf } from "./helpers/memory-model"

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
  const { desc, eq } = await import("drizzle-orm")

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

  // Typing rhythm has its own test (tests/companion-b1.ts); here replies should land at once
  await updateCompanion(ownerId, agentId, { typingPace: "off" })

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
      model: adds(scripted([[call("remember", { note: "对花生过敏" })], text("记住了")])),
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
    {
      model: decides(
        scripted([
          [call("remember", { note: "对方让我忘掉过敏的事" })],
          text("好，忘了"),
        ]),
        (seen) =>
          JSON.stringify({
            ops: [
              {
                op: "DELETE",
                id: numberOf(seen, "对花生过敏"),
                reason: "对方让忘掉",
              },
            ],
          })
      ),
      price,
    }
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
  assert.equal((await confirmErrand(ownerId, card.id)).taskId, task.taskId)
  await assert.rejects(cancelErrand(ownerId, card.id), /already answered/)
  await assert.rejects(confirmErrand("someone-else", card.id))
  assert.equal(await syncErrands(), 0, "nothing to report while the task is running")
  await pool.query("UPDATE tasks SET status='needs_review' WHERE id=$1", [task.taskId])
  assert.equal(await syncErrands(), 1, "a task stopped for review is reported")
  assert.equal(await syncErrands(), 0, "the review notice is sent once")
  // Nobody answers: only after the patience runs out is it stopped, once, so it cannot block the next errand
  const { stopStalledErrands, ERRAND_REVIEW_PATIENCE_MS } =
    await import("@/lib/companion/errands")
  await pool.query("UPDATE tasks SET updated_at=now() WHERE id=$1", [task.taskId])
  assert.equal(await stopStalledErrands(), 0, "a fresh review stop is left for the owner")
  const later = new Date(Date.now() + ERRAND_REVIEW_PATIENCE_MS + 60_000)
  assert.equal(await stopStalledErrands(later), 1)
  assert.equal(await stopStalledErrands(later), 0, "stopped once")
  await pool.query("UPDATE tasks SET cancel_requested_at=NULL WHERE id=$1", [task.taskId])
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
    .orderBy(desc(companionMessages.createdAt))
    .limit(1)
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
  // Once the session has ended, a later tick in the same slot must not start or fail on a second one
  const {
    rows: [{ status: taskStatus }],
  } = await pool.query("SELECT status FROM tasks WHERE id=$1", [started.started[0]])
  await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [
    started.started[0],
  ])
  assert.equal(
    (await startLifeSessions(new Date(slot.getTime() + 60_000))).started.length,
    0
  )
  await pool.query("UPDATE tasks SET status=$2 WHERE id=$1", [
    started.started[0],
    taskStatus,
  ])
  // A session stopped for review is cancelled, once, so it cannot hold her computer forever
  const { stopStalledSessions } = await import("@/lib/companion/life")
  assert.equal(await stopStalledSessions(), 0, "a running session is left alone")
  await pool.query("UPDATE tasks SET status='needs_review' WHERE id=$1", [
    started.started[0],
  ])
  assert.equal(await stopStalledSessions(), 1)
  assert.equal(await stopStalledSessions(), 0)
  await pool.query("UPDATE tasks SET status=$2,cancel_requested_at=NULL WHERE id=$1", [
    started.started[0],
    taskStatus,
  ])
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
  await pool.query(
    "UPDATE life_activities SET image_path='life/coffee.jpg' WHERE id=$1",
    [activity.id]
  )
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
  assert.equal((share.metadata as { hasImage: boolean }).hasImage, true)

  // 9. Memory candidates: unsure notes wait for the person; only accepted notes reach the prompt
  const { reviewCandidate } = await import("@/lib/companion/memory")
  const promptSpy = () => {
    const seen = { prompt: "" }
    const model = scripted([text("好")])
    const original = model.doStream.bind(model)
    model.doStream = async (options) => {
      seen.prompt = String(options.prompt[0].content)
      return original(options)
    }
    return { model, seen }
  }
  const unsure = await companionChat(
    { ownerId, agentId, text: "我最近好像在看心理医生" },
    {
      model: asks(
        scripted([[call("remember", { note: "在看心理医生" })], text("嗯，我听着")])
      ),
      price,
    }
  )
  const memoryCard = unsure.replies.find((m) => m.kind === "memory_candidate")!
  const candidateId = (memoryCard.metadata as { memoryId: string }).memoryId
  assert.equal((memoryCard.metadata as { status: string }).status, "pending")
  assert.deepEqual(await listNotes(agentId, "active"), [])
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  const before = promptSpy()
  await companionChat(
    { ownerId, agentId, text: "晚上吃什么" },
    { model: before.model, price }
  )
  assert.doesNotMatch(before.seen.prompt, /心理医生/)
  await assert.rejects(reviewCandidate(randomUUID(), candidateId, "accept"), /not found/)
  await reviewCandidate(agentId, candidateId, "accept")
  await assert.rejects(reviewCandidate(agentId, candidateId, "accept"), /not found/)
  const after = promptSpy()
  await companionChat(
    { ownerId, agentId, text: "晚上吃什么" },
    { model: after.model, price }
  )
  assert.match(after.seen.prompt, /心理医生/)
  const [settled] = await db
    .select()
    .from(companionMessages)
    .where(eq(companionMessages.id, memoryCard.id))
  assert.equal((settled.metadata as { status: string }).status, "accepted")
  const second2 = await companionChat(
    { ownerId, agentId, text: "我可能喜欢上同事了" },
    {
      model: asks(scripted([[call("remember", { note: "喜欢上同事" })], text("哦？")])),
      price,
    }
  )
  const card3 = second2.replies.find((m) => m.kind === "memory_candidate")!
  await reviewCandidate(
    agentId,
    (card3.metadata as { memoryId: string }).memoryId,
    "dismiss"
  )
  assert.equal(
    (await listNotes(agentId)).some((n) => n.content === "喜欢上同事"),
    false
  )
  const [dismissed] = await db
    .select()
    .from(companionMessages)
    .where(eq(companionMessages.id, card3.id))
  assert.equal((dismissed.metadata as { status: string }).status, "dismissed")
  // A sure note is active at once
  await companionChat(
    { ownerId, agentId, text: "我叫阿明" },
    {
      model: adds(scripted([[call("remember", { note: "叫阿明" })], text("好")])),
      price,
    }
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 0)

  // 10. Rhythm: asleep means no life session and no share, but chat still answers, in her state
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "10:00", end: "12:00" }, nap: null, away: [] },
  })
  const nextDay = new Date("2026-11-02T03:00:00Z") // 11:00 in Taipei, inside her sleep
  assert.deepEqual(
    (await startLifeSessions(nextDay)).skipped.map((s) => s.reason),
    ["rhythm: asleep"]
  )
  const sleepy = promptSpy()
  const sleepReply = await companionChat(
    { ownerId, agentId, text: "睡了吗" },
    { model: sleepy.model, price, now: nextDay }
  )
  assert.match(sleepy.seen.prompt, /在睡觉/)
  assert.equal(sleepReply.replies[0].content, "好")
  await db
    .insert(lifeShares)
    .values({ agentId, activityId: activity.id, text: "睡着时攒下的分享" })
  assert.deepEqual(await deliverShares(nextDay), [], "no share while asleep")
  await pool.query("DELETE FROM life_shares WHERE status='pending'")

  // 11. Link co-viewing: queued from chat, waits while she sleeps, starts one session when online
  const { startCoviews, syncCoviews } = await import("@/lib/companion/coview")
  const open = async () => true
  const linked = promptSpy()
  await companionChat(
    { ownerId, agentId, text: "你看这个 https://example.com/post/1" },
    { model: linked.model, price, now: nextDay, linkCheck: open }
  )
  assert.match(linked.seen.prompt, /还没有点开/)
  const pendingRows = await pool.query("SELECT id,url,status FROM coview_requests")
  assert.deepEqual(
    pendingRows.rows.map((r) => [r.url, r.status]),
    [["https://example.com/post/1", "pending"]]
  )
  const refusedPrompt = promptSpy()
  await companionChat(
    { ownerId, agentId, text: "http://192.168.0.2/admin" },
    { model: refusedPrompt.model, price, now: nextDay }
  )
  assert.match(refusedPrompt.seen.prompt, /没法打开/)
  assert.equal((await pool.query("SELECT 1 FROM coview_requests")).rowCount, 1)
  await pool.query("UPDATE tasks SET status='completed' WHERE agent_id=$1", [agentId])
  assert.deepEqual(await startCoviews(nextDay), [], "asleep: it waits")
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "23:30", end: "07:30" }, nap: null, away: [] },
  })
  const [coviewTask] = await startCoviews(nextDay)
  assert.ok(coviewTask)
  assert.deepEqual(await startCoviews(nextDay), [], "one session per request")
  const config = await pool.query(
    "SELECT config_snapshot->'lifeSession'->'coview' AS coview, config_snapshot->'lifeSession'->>'prompt' AS prompt FROM tasks WHERE id=$1",
    [coviewTask]
  )
  assert.equal(config.rows[0].coview.url, "https://example.com/post/1")
  assert.match(config.rows[0].prompt, /example\.com\/post\/1/)
  // A session that ends without a reply says so once; one cut short by an errand is retried
  await pool.query("UPDATE tasks SET status='failed' WHERE id=$1", [coviewTask])
  await syncCoviews(nextDay)
  await syncCoviews(nextDay)
  const failures = await pool.query(
    "SELECT 1 FROM companion_messages WHERE kind='coview' AND metadata->>'failed'='true'"
  )
  assert.equal(failures.rowCount, 1)
  await pool.query("UPDATE coview_requests SET status='pending',task_id=NULL")
  const [retryTask] = await startCoviews(nextDay)
  await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [retryTask])
  await syncCoviews(nextDay)
  assert.equal(
    (await pool.query("SELECT status FROM coview_requests")).rows[0].status,
    "pending"
  )
  await syncCoviews(new Date(nextDay.getTime() + 25 * 3600_000))
  assert.equal(
    (await pool.query("SELECT status FROM coview_requests")).rows[0].status,
    "skipped"
  )

  // 12. Peek: live only while she is on her computer; a timed ticket carries its deadline
  const { peekState } = await import("@/lib/companion/peek")
  const { issueDesktopTicket } = await import("@/lib/desktop")
  const { encryptSecret } = await import("@/lib/secrets")
  await pool.query("UPDATE tasks SET status='completed' WHERE agent_id=$1", [agentId])
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "10:00", end: "12:00" }, nap: null, away: [] },
  })
  const view = await (
    await import("@/lib/companion/store")
  ).ensureCompanion(ownerId, agentId)
  assert.deepEqual(await peekState(view, nextDay), {
    live: false,
    caption: "她在睡觉，电脑没开着。",
  })
  await pool.query("UPDATE tasks SET status='running' WHERE id=$1", [coviewTask])
  assert.deepEqual(await peekState(view, nextDay), {
    live: true,
    caption: "她正在看你发的链接。",
  })
  await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [coviewTask])
  await pool.query(
    "INSERT INTO workstation_control(agent_id,container_name,connection_secret,mode,epoch,updated_at) VALUES($1,'c1',$2,'idle',3,now())",
    [agentId, encryptSecret(JSON.stringify({ password: "p" }))]
  )
  const owner = { userId: ownerId, sessionId: "s1" }
  const timed = await issueDesktopTicket(owner, agentId, "watch", null, 60)
  assert.ok(timed.until && Date.parse(timed.until) - Date.now() <= 60_000)
  const row = await pool.query("SELECT watch_until FROM desktop_tickets WHERE token=$1", [
    timed.token,
  ])
  assert.equal(row.rows[0].watch_until.toISOString(), timed.until)
  assert.equal((await issueDesktopTicket(owner, agentId, "watch", null)).until, null)
  await assert.rejects(
    issueDesktopTicket(owner, agentId, "control", null, 60),
    /Only a watch/
  )

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
