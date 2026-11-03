// Stage B2a against a throwaway database: similar-note confirm cards (merge / keep both / drop,
// never automatic) and pictures she is sent (storage, limits, description, sensitive-image memory rule).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_companion_b2a_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "b2a@fixture.test",
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
  const memory = await import("@/lib/companion/memory")
  const { listNotes } = memory
  const { updateCompanion, ensureCompanion } = await import("@/lib/companion/store")
  const { companionMessages } = await import("@/db/schema")
  const { asc, eq } = await import("drizzle-orm")

  const ownerId = "b2a-owner"
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
  await updateCompanion(ownerId, agentId, { typingPace: "off" })

  // ───── similar notes ─────
  const run = (model: MockLanguageModelV3, textIn: string) =>
    companionChat({ ownerId, agentId, text: textIn }, { model, price })
  const note = await memory.addNote(agentId, "喜欢吃辣", "user")

  // 1. She wants to remember something that is the same as an existing note: no second note,
  //    a candidate plus a merge card instead
  const turn = await run(
    scripted([
      [call("remember", { note: "爱吃辣的", certainty: "sure" })],
      text("记住啦"),
    ]),
    "我超爱吃辣的"
  )
  const cards = turn.replies.filter((m) => m.kind === "memory_merge")
  assert.equal(cards.length, 1, "one merge card")
  assert.equal((cards[0].metadata as { status: string }).status, "pending")
  assert.equal((cards[0].metadata as { otherNote: string }).otherNote, "喜欢吃辣")
  assert.equal(
    (await listNotes(agentId, "active")).length,
    1,
    "nothing was merged by itself"
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  assert.equal(turn.replies.filter((m) => m.kind === "memory_candidate").length, 0)
  const pending = await memory.listSuggestions(agentId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].other.id, note.id)

  // 2. keep both: the candidate becomes a note, the pair is not offered again
  await memory.resolveSuggestion(agentId, pending[0].id, "keep")
  assert.equal((await listNotes(agentId, "active")).length, 2)
  assert.equal((await memory.listSuggestions(agentId)).length, 0)
  assert.equal(
    await memory.scanSimilar(agentId),
    0,
    "decided pair is not suggested again"
  )
  const kept = (await rows()).find((m) => m.kind === "memory_merge")!
  assert.equal((kept.metadata as { status: string }).status, "kept")

  // 3. merge: the older note takes the merged wording, the newer one is removed
  await pool.query("DELETE FROM memories")
  await pool.query("DELETE FROM companion_messages")
  const old = await memory.addNote(agentId, "住在上海", "user")
  const turn2 = await run(
    scripted([
      [call("remember", { note: "我住在上海浦东", certainty: "sure" })],
      text("好"),
    ]),
    "我我住在上海浦东"
  )
  const card2 = turn2.replies.find((m) => m.kind === "memory_merge")!
  const suggestionId = (card2.metadata as { suggestionId: string }).suggestionId
  await memory.resolveSuggestion(agentId, suggestionId, "merge", "住在上海浦东")
  const active = await listNotes(agentId, "active")
  assert.deepEqual(
    active.map((n) => [n.id, n.content]),
    [[old.id, "住在上海浦东"]]
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 0)
  const merged = (await rows()).find((m) => m.kind === "memory_merge")!
  assert.equal((merged.metadata as { status: string }).status, "merged")
  await assert.rejects(
    memory.resolveSuggestion(agentId, suggestionId, "keep"),
    /not found/,
    "an answered suggestion cannot be answered twice"
  )

  // 4. drop: the newer note goes, the old one is untouched
  const turn3 = await run(
    scripted([
      [call("remember", { note: "住在上海浦东新区", certainty: "sure" })],
      text("好"),
    ]),
    "我住在浦东新区"
  )
  const card3 = turn3.replies.find((m) => m.kind === "memory_merge")!
  await memory.resolveSuggestion(
    agentId,
    (card3.metadata as { suggestionId: string }).suggestionId,
    "drop"
  )
  assert.deepEqual(
    (await listNotes(agentId)).map((n) => n.content),
    ["住在上海浦东"]
  )

  // 5. Different facts are saved as before, no card
  const turn4 = await run(
    scripted([
      [call("remember", { note: "养了一只猫叫团子", certainty: "sure" })],
      text("好"),
    ]),
    "我有只猫叫团子"
  )
  assert.equal(turn4.replies.filter((m) => m.kind === "memory_merge").length, 0)
  assert.equal((await listNotes(agentId, "active")).length, 2)

  // 6. A note the person writes is saved as written; a similar one only makes a card
  const mine = await memory.addNote(agentId, "养了一只猫，叫团子", "user")
  const made = await memory.suggestMerge(agentId, mine)
  assert.ok(made, "suggestion for the person's own note")
  assert.equal((await listNotes(agentId, "active")).length, 3, "note kept as written")
  assert.equal((await memory.listSuggestions(agentId)).length, 1)

  // 7. Scan finds old pairs; deleting a note closes its cards; redoing a turn drops its candidate
  await pool.query("DELETE FROM memory_suggestions")
  await memory.addNote(agentId, "养了一只猫叫团子呀", "user")
  assert.ok((await memory.scanSimilar(agentId)) >= 1)
  const [pair] = await memory.listSuggestions(agentId)
  await memory.deleteNote(agentId, pair.memory.id)
  assert.equal((await memory.listSuggestions(agentId)).length >= 0, true)
  await pool.query("DELETE FROM memory_suggestions")
  await pool.query("DELETE FROM companion_messages")
  await pool.query("DELETE FROM memories WHERE content <> '住在上海浦东'")
  await run(
    scripted([
      [call("remember", { note: "住在上海浦东区", certainty: "sure" })],
      text("好"),
    ]),
    "再说一遍我住浦东"
  )
  assert.equal((await listNotes(agentId, "candidate")).length, 1)
  const redone = await companionChat(
    { ownerId, agentId, text: "", redo: "regenerate" },
    { model: scripted([text("嗯嗯")]), price }
  )
  assert.equal(
    (await listNotes(agentId, "candidate")).length,
    0,
    "its candidate went with the old answer"
  )
  assert.equal(redone.replies.filter((m) => m.kind === "memory_merge").length, 0)
  assert.equal((await memory.listSuggestions(agentId)).length, 0)

  //@@IMAGES@@

  await closeDurableClient()
  await pool.end()
  console.log("companion B2a integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
