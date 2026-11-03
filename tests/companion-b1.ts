// Stage B1 against a throwaway database: typing rhythm (schedule, reveal times, playback events),
// redo of the latest turn (regenerate / edit), failure restore, and read-only memory on regenerate.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_companion_b1_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "b1@fixture.test",
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
  const { companionChat, latestRound } = await import("@/lib/companion/chat")
  const { listNotes } = await import("@/lib/companion/memory")
  const { updateCompanion, ensureCompanion } = await import("@/lib/companion/store")
  const { visibleMessage } = await import("@/lib/companion/pacing")
  const { companionMessages } = await import("@/db/schema")
  const { companionSettingsSchema } = await import("@/lib/companion/persona")
  const { asc, eq } = await import("drizzle-orm")
  type Event = import("@/lib/companion/chat").ChatEvent

  const ownerId = "b1-owner"
  const agentId = randomUUID()
  await pool.query(
    "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Taipei',now())",
    [ownerId]
  )
  await pool.query(
    "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
    [agentId]
  )
  await ensureCompanion(ownerId, agentId)
  await updateCompanion(ownerId, agentId, {
    rhythm: { sleep: { start: "03:00", end: "03:01" }, nap: null, away: [] },
  } as never)

  const scripted = (steps: Array<Array<Record<string, unknown>>>, seen?: string[]) => {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async (options) => {
        seen?.push(JSON.stringify(options.prompt))
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
                  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 20, text: 20, reasoning: 0 },
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
  const broken = () =>
    new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("model is down")
      },
    })
  const rows = () =>
    db.select().from(companionMessages).orderBy(asc(companionMessages.createdAt))
  const live = async () =>
    (await rows()).filter((m) => !m.supersededAt).map((m) => [m.role, m.content] as const)

  // 1. Natural pace: bubbles get increasing reveal times, playback shows typing then one bubble at a time
  const waits: number[] = []
  const events: Event[] = []
  const pacedDeps = (model: MockLanguageModelV3) => ({
    model,
    price,
    playback: true,
    sleep: async (ms: number) => void waits.push(ms),
    random: () => 0.5,
  })
  const first = await companionChat(
    { ownerId, agentId, text: "早" },
    pacedDeps(scripted([text("早呀\n\n昨晚睡得好吗\n\n我刚起来")])),
    (event) => events.push(event)
  )
  assert.equal(first.replies.length, 3)
  assert.equal(first.schedule.length, 3)
  assert.ok(first.schedule[0] > 0 && first.schedule[0] <= 1500, "first bubble waits less")
  assert.ok(
    first.schedule[0] < first.schedule[1] && first.schedule[1] < first.schedule[2]
  )
  assert.ok(first.schedule[2] <= 8000, "whole reply capped")
  assert.deepEqual(
    first.replies.map(
      (m) => m.revealAt!.getTime() - first.replies[0].revealAt!.getTime()
    ),
    first.schedule.map((ms) => ms - first.schedule[0])
  )
  assert.equal(waits.length, 3)
  const kinds = events.map((e) =>
    e.type === "messages" ? `m${e.messages.length}` : e.type
  )
  assert.deepEqual(
    kinds.filter((k) => k !== "delta"),
    ["user", "typing", "typing", "m1", "typing", "m1", "typing", "m1"]
  )
  assert.ok(events.some((e) => e.type === "typing" && e.on))
  // Not yet revealed bubbles are invisible to the conversation, revealed ones are not
  const visible = async (at: Date) =>
    (await db.select().from(companionMessages).where(visibleMessage(at))).filter(
      (m) => m.role === "assistant"
    ).length
  assert.equal(await visible(new Date(first.replies[0].revealAt!.getTime() - 1)), 0)
  assert.equal(await visible(new Date(first.replies[1].revealAt!.getTime())), 2)
  assert.equal(await visible(new Date(first.replies[2].revealAt!.getTime() + 1)), 3)

  // 2. Pace "fast" is quicker than "natural"; "off" shows everything at once
  const gaps = async (pace: "natural" | "fast" | "off") => {
    await updateCompanion(ownerId, agentId, { typingPace: pace })
    const reply = await companionChat(
      { ownerId, agentId, text: `节奏 ${pace}` },
      pacedDeps(scripted([text("一二三四五六七八九十\n\n一二三四五六七八九十")]))
    )
    return reply.schedule
  }
  const natural = await gaps("natural")
  const fast = await gaps("fast")
  const off = await gaps("off")
  assert.ok(fast[1] < natural[1])
  assert.deepEqual(off, [0, 0])
  assert.equal(companionSettingsSchema.safeParse({ typingPace: "slow" }).success, false)
  assert.equal(companionSettingsSchema.safeParse({ typingPace: "fast" }).success, true)

  // From here on everything is instant and easy to read
  await updateCompanion(ownerId, agentId, { typingPace: "off" })
  await pool.query("DELETE FROM companion_messages")

  // 3. Regenerate: the old answer is hidden (kept), the new one is shown, the user turn stays
  const seen: string[] = []
  await companionChat(
    { ownerId, agentId, text: "我今天有点烦" },
    { model: scripted([text("怎么了\n\n跟我说说")], seen), price }
  )
  const beforeRows = await rows()
  const again = await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: scripted([text("抱抱，发生什么了")], seen), price }
  )
  assert.deepEqual(
    again.replies.map((m) => m.content),
    ["抱抱，发生什么了"]
  )
  assert.equal(again.user.id, beforeRows[0].id, "same user message")
  assert.deepEqual(await live(), [
    ["user", "我今天有点烦"],
    ["assistant", "抱抱，发生什么了"],
  ])
  const all = await rows()
  assert.equal(all.length, 4, "nothing is deleted")
  assert.ok(all.filter((m) => m.supersededAt).length === 2)
  assert.equal((all[0].metadata as { redo?: number }).redo, 1)
  assert.ok(
    !seen[1].includes("跟我说说") && !seen[1].includes("怎么了"),
    "old answer is not in the prompt"
  )
  assert.equal(
    seen[1].split("我今天有点烦").length - 1,
    1,
    "the user message appears once in the history"
  )

  // 4. Regenerate is read-only for notes: a remember call does not write
  const notesBefore = (await listNotes(agentId)).length
  const readOnly = await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    {
      model: scripted([[call("remember", { note: "今天很烦" })], text("先深呼吸一下")]),
      price,
    }
  )
  assert.equal((await listNotes(agentId)).length, notesBefore)
  assert.equal(readOnly.replies[0].content, "先深呼吸一下")
  // Three redos are allowed, the fourth is refused and changes nothing
  await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: scripted([text("我在")]), price }
  )
  const liveBefore = await live()
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      { model: scripted([text("又一遍")]), price }
    ),
    /重说 3 次/
  )
  assert.deepEqual(await live(), liveBefore)

  // 5. Edit: your message is replaced, she answers the new one, the old turn is hidden
  const seen2: string[] = []
  const edited = await companionChat(
    { ownerId, agentId, text: "我今天其实挺开心的", redo: "edit" },
    { model: scripted([text("真的呀\n\n说来听听")], seen2), price }
  )
  assert.deepEqual(await live(), [
    ["user", "我今天其实挺开心的"],
    ["assistant", "真的呀"],
    ["assistant", "说来听听"],
  ])
  assert.notEqual(edited.user.id, (await rows())[0].id)
  assert.ok(!seen2[0].includes("有点烦"), "the old message is not in the prompt")
  assert.ok(seen2[0].includes("其实挺开心"))
  const round = await latestRound(agentId)
  assert.equal(round.user.id, edited.user.id)
  assert.equal(round.redone, 0)

  // 6. A failed redo puts the old answer back; a failed edit also removes the new user row
  const stable = await live()
  const stableCount = (await rows()).length
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      { model: broken(), price }
    )
  )
  assert.deepEqual(await live(), stable)
  assert.equal((await latestRound(agentId)).redone, 0)
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "改成别的", redo: "edit" },
      { model: broken(), price }
    )
  )
  assert.deepEqual(await live(), stable)
  assert.equal((await rows()).length, stableCount, "no stray user row left")

  // 7. Crisis wording in an edit gets the fixed reply and the old turn is hidden
  const crisis = await companionChat(
    { ownerId, agentId, text: "我不想活了", redo: "edit" },
    { model: broken(), price }
  )
  assert.equal(crisis.replies[0].kind, "crisis")
  assert.deepEqual(
    (await live()).map(([role]) => role),
    ["user", "assistant"]
  )
  // ...and a crisis reply can never be "regenerated" into something else
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      { model: scripted([text("x")]), price }
    ),
    /不能再重来/
  )

  // 8. Unsure notes: regenerating drops the candidate and its card; the new turn can propose again
  await pool.query("DELETE FROM companion_messages")
  await pool.query("DELETE FROM memories")
  await companionChat(
    { ownerId, agentId, text: "我最近在吃药" },
    {
      model: scripted([
        [call("remember", { note: "最近在吃药", certainty: "unsure" })],
        text("记得按时吃"),
      ]),
      price,
    }
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  assert.ok((await rows()).some((m) => m.kind === "memory_candidate"))
  await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: scripted([text("嗯，好好休息")]), price }
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 0)
  assert.deepEqual(await live(), [
    ["user", "我最近在吃药"],
    ["assistant", "嗯，好好休息"],
  ])

  // 9. A turn that has moved on cannot be redone: later message, other channel, handled card
  await companionChat(
    { ownerId, agentId, text: "晚点聊" },
    { model: scripted([text("好呀")]), price }
  )
  await pool.query(
    "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at) VALUES('tg1',$1,'user','chat','在吗','telegram',now() + interval '1 second')",
    [agentId]
  )
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      { model: scripted([text("x")]), price }
    ),
    /网页/
  )
  await pool.query("DELETE FROM companion_messages WHERE id='tg1'")
  await pool.query(
    "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,metadata,created_at) VALUES('c1',$1,'assistant','errand_proposal','查一下','web','{\"goal\":\"查一下\",\"status\":\"confirmed\"}', now() + interval '1 second')",
    [agentId]
  )
  await assert.rejects(
    companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      { model: scripted([text("x")]), price }
    ),
    /已经处理过/
  )

  await closeDurableClient()
  await pool.end()
  console.log("companion B1 integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
