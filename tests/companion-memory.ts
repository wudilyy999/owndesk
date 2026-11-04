// Agent-driven memory against a throwaway database: the model's decisions are scripted, everything
// around them is real. Topic summaries and the tidy-up (merge / summarize / delete, paging, one
// undo for a whole run, schedule), recalling details in chat, merges and grouped undo.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"
import { decides, numberOf, summaryNumber, type Seen } from "./helpers/memory-model"

process.loadEnvFile(".env")
const database = `agent_companion_mem_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  OWNER_EMAIL: "mem@fixture.test",
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
  const { organizeMemory, organizeDue, organizeTick, organizeNow } =
    await import("@/lib/companion/consolidate")
  const { companionTick } = await import("@/lib/companion/tick")
  const { updateCompanion, ensureCompanion } = await import("@/lib/companion/store")
  const { companions, memories } = await import("@/db/schema")
  const { eq } = await import("drizzle-orm")

  const ownerId = "mem-owner"
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
  await updateCompanion(ownerId, agentId, { typingPace: "off" })

  const scripted = (steps: Array<Array<Record<string, unknown>>>, seen?: string[]) => {
    let calls = 0
    return new MockLanguageModelV3({
      doStream: async (options) => {
        seen?.push(JSON.stringify(options.prompt))
        const parts = steps[Math.min(calls++, steps.length - 1)]
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
  const ops = (...list: unknown[]) => JSON.stringify({ ops: list })
  const clean = async () => {
    await pool.query("DELETE FROM memory_changes")
    await pool.query("DELETE FROM companion_messages")
    await pool.query("DELETE FROM memories")
    await pool.query(
      "UPDATE companions SET memory_organized_at = NULL, memory_organize_requested = false"
    )
  }
  const all = () => memory.listNotes(agentId)
  const byText = async (content: string) =>
    (await all()).find((row) => row.content === content)!
  const user = (content: string) => memory.addNote(agentId, content, "user")

  // ───── 1. A tidy-up: topic summaries, a merge, a stale note removed, one undo for all ─────
  const coffee = await user("喜欢喝冰美式")
  const tea = await user("平时只喝无糖乌龙茶")
  const spicy = await user("爱吃辣")
  const spicy2 = await user("喜欢吃辣的")
  const job = await user("在一家游戏公司做策划")
  const crunch = await user("这周在赶版本，天天加班")
  const old = await user("暂时住在朋友家")
  const cat = await user("养了一只猫叫团子")
  const shown: Seen[] = []
  const result = await organizeMemory(agentId, {
    model: decides(
      new MockLanguageModelV3(),
      (seen) =>
        ops(
          {
            op: "MERGE",
            ids: [numberOf(seen, "爱吃辣"), numberOf(seen, "喜欢吃辣的")],
            text: "爱吃辣",
            reason: "两条是一件事",
          },
          { op: "DELETE", id: numberOf(seen, "暂时住在朋友家"), reason: "早就搬走了" },
          {
            op: "SUMMARIZE",
            topic: "饮食习惯",
            text: "爱喝冰美式，平时只喝无糖乌龙茶，爱吃辣。",
            ids: [
              numberOf(seen, "喜欢喝冰美式"),
              numberOf(seen, "平时只喝无糖乌龙茶"),
              numberOf(seen, "爱吃辣"),
            ],
            reason: "饮食相关",
          },
          {
            op: "SUMMARIZE",
            topic: "工作近况",
            text: "在游戏公司做策划，最近在赶版本，经常加班。",
            ids: [
              numberOf(seen, "在一家游戏公司做策划"),
              numberOf(seen, "这周在赶版本，天天加班"),
            ],
          }
        ),
      shown
    ),
  })
  assert.equal(shown.length, 1, "8 short notes fit one page")
  assert.equal(shown[0].call, "organize")
  assert.equal(shown[0].notes.length, 8)
  assert.equal(result.pages, 1)
  assert.equal(result.failedPages, 0)
  assert.equal(result.changes, 4)
  assert.ok(result.groupId)
  let rows = await all()
  const summaries = rows.filter((row) => row.kind === "summary")
  assert.deepEqual(summaries.map((row) => row.topic).sort(), ["工作近况", "饮食习惯"])
  const food = summaries.find((row) => row.topic === "饮食习惯")!
  assert.equal(food.source, "agent")
  assert.equal((await byText("爱喝冰美式，平时只喝无糖乌龙茶，爱吃辣。")).id, food.id)
  // The detailed notes stay (they are what she reads back), tied to their topic
  assert.equal((await byText("喜欢喝冰美式")).summaryId, food.id)
  assert.equal((await byText("爱吃辣")).summaryId, food.id)
  assert.equal(
    rows.some((row) => row.id === spicy2.id),
    false,
    "the duplicate was merged away"
  )
  assert.equal(
    rows.some((row) => row.id === old.id),
    false,
    "the stale note is gone"
  )
  assert.equal(
    (await byText("养了一只猫叫团子")).summaryId,
    null,
    "a loose note stays loose"
  )
  assert.equal(rows.filter((row) => row.kind === "note").length, 6)
  // Every change is logged under one group, with her reason
  let log = await memory.listChanges(agentId)
  assert.equal(log.length, 4, "the merged-away note, the stale note, 2 summaries")
  assert.ok(log.every((c) => c.groupId === result.groupId && c.origin === "organize"))
  assert.ok(log.every((c) => c.actor === "model" && !c.undoneAt))
  assert.ok(log.some((c) => c.reason === "早就搬走了"))
  const added = log.filter((c) => c.op === "add")
  assert.equal(added.length, 2)
  assert.deepEqual(
    added.map((c) => c.after!.kind),
    ["summary", "summary"]
  )
  // One undo puts the whole tidy-up back
  const undone = await memory.undoChange(agentId, log[3].id)
  assert.equal(undone.undone, 4)
  rows = await all()
  assert.equal(rows.filter((row) => row.kind === "summary").length, 0)
  assert.deepEqual(
    rows.map((row) => row.content).sort(),
    [
      "喜欢喝冰美式",
      "平时只喝无糖乌龙茶",
      "爱吃辣",
      "喜欢吃辣的",
      "在一家游戏公司做策划",
      "这周在赶版本，天天加班",
      "暂时住在朋友家",
      "养了一只猫叫团子",
    ].sort()
  )
  assert.ok(rows.every((row) => row.summaryId === null))
  assert.equal(rows.find((row) => row.content === "暂时住在朋友家")!.id, old.id)
  assert.equal(rows.find((row) => row.content === "喜欢吃辣的")!.id, spicy2.id)
  assert.ok((await memory.listChanges(agentId)).every((c) => c.undoneAt))
  await assert.rejects(memory.undoChange(agentId, log[0].id), /撤销过了/)
  void [coffee, tea, spicy, job, crunch, cat]

  // ───── 2. Paging: a lot of notes are read page by page, none skipped, summaries carry over ─────
  await clean()
  for (let i = 0; i < 130; i++) await user(`第${i}条：${"今天的小事".repeat(8)}${i}`)
  const pagesSeen: Seen[] = []
  const paged = await organizeMemory(agentId, {
    model: decides(
      new MockLanguageModelV3(),
      (seen) => {
        // Write (or extend) one topic from the first note on each page
        const first = seen.notes[0]
        const existing = seen.summaries.length
          ? summaryNumber(seen, "日常小事")
          : undefined
        return ops({
          op: "SUMMARIZE",
          ...(existing ? { id: existing } : {}),
          topic: "日常小事",
          text: `到这一页为止的日常小事（含：${first.slice(0, 6)}）`,
          ids: seen.notes.map((_, index) => String(index + 1)),
        })
      },
      pagesSeen
    ),
  })
  assert.ok(paged.pages >= 2, `130 notes need more than one page (${paged.pages})`)
  assert.equal(pagesSeen.length, paged.pages)
  const seenAll = pagesSeen.flatMap((p) => p.notes)
  assert.equal(seenAll.length, 130, "every note was seen")
  assert.equal(new Set(seenAll).size, 130, "each exactly once")
  assert.equal(pagesSeen[0].summaries.length, 0)
  assert.equal(
    pagesSeen[1].summaries.length,
    1,
    "the next page starts from the summary so far"
  )
  rows = await all()
  assert.equal(
    rows.filter((row) => row.kind === "summary").length,
    1,
    "one topic, rewritten"
  )
  assert.equal(rows.filter((row) => row.kind === "note" && row.summaryId).length, 130)
  assert.equal(rows.filter((row) => row.kind === "note").length, 130, "no note lost")

  // ───── 3. A page the model cannot answer changes nothing; others still go on ─────
  await clean()
  for (let i = 0; i < 130; i++) await user(`第${i}条：${"今天的小事".repeat(8)}${i}`)
  let page = 0
  const flaky = await organizeMemory(agentId, {
    decide: async (view) => {
      page++
      if (page === 1) return { ops: null }
      return {
        ops: [
          {
            op: "SUMMARIZE",
            id: null,
            topic: "小事",
            text: "一些小事",
            ids: [view.notes[0].id],
            reason: null,
          },
        ],
      }
    },
  })
  assert.equal(flaky.failedPages, 1)
  assert.equal((await all()).filter((row) => row.kind === "note").length, 130)
  assert.equal(flaky.changes, 1)
  const thrown = await organizeMemory(agentId, {
    model: decides(new MockLanguageModelV3(), new Error("model is down")),
  })
  assert.equal(thrown.failedPages, thrown.pages)
  assert.equal(thrown.changes, 0)
  assert.equal(
    (await all()).filter((row) => row.kind === "note").length,
    130,
    "nothing deleted"
  )

  // ───── 4. Summary undo: a rewritten summary gets its old text and notes back ─────
  await clean()
  const a = await user("爱喝美式")
  const b = await user("不吃香菜")
  const c = await user("最近想吃酸菜鱼")
  await organizeMemory(agentId, {
    decide: async (view) => ({
      ops: [
        {
          op: "SUMMARIZE",
          id: null,
          topic: "饮食习惯",
          text: "爱喝美式，不吃香菜",
          ids: view.notes.filter((n) => n.id !== c.id).map((n) => n.id),
          reason: null,
        },
      ],
    }),
  })
  const summary = (await all()).find((row) => row.kind === "summary")!
  assert.equal((await byText("爱喝美式")).summaryId, summary.id)
  await organizeMemory(agentId, {
    decide: async (view) => ({
      ops: [
        {
          op: "SUMMARIZE",
          id: summary.id,
          topic: "饮食习惯",
          text: "爱喝美式，不吃香菜，想吃酸菜鱼",
          ids: view.notes.map((n) => n.id),
          reason: "新增",
        },
      ],
    }),
  })
  assert.equal((await byText("最近想吃酸菜鱼")).summaryId, summary.id)
  const rewrite = (await memory.listChanges(agentId))[0]
  assert.equal(rewrite.op, "update")
  await memory.undoChange(agentId, rewrite.id)
  const back = (await all()).find((row) => row.id === summary.id)!
  assert.equal(back.content, "爱喝美式，不吃香菜")
  assert.equal((await byText("最近想吃酸菜鱼")).summaryId, null, "covers go back as well")
  assert.equal((await byText("爱喝美式")).summaryId, summary.id)
  // Deleting a summary by hand leaves its notes, loose again; undo puts it back with its notes
  await memory.deleteNote(agentId, summary.id, { actor: "user", origin: "memory" })
  assert.equal((await byText("爱喝美式")).summaryId, null)
  await memory.undoChange(agentId, (await memory.listChanges(agentId))[0].id)
  assert.equal((await byText("爱喝美式")).summaryId, summary.id)
  assert.equal((await byText("不吃香菜")).summaryId, summary.id)
  void [a, b]

  // ───── 5. Chat: the prompt has the summaries and the loose notes; details through recall_memory ─────
  const prompts: string[] = []
  const reply = await companionChat(
    { ownerId, agentId, text: "我晚上吃什么好" },
    {
      model: scripted(
        [
          [call("recall_memory", { topic: "饮食习惯" })],
          [call("recall_memory", { topic: "不存在的主题" })],
          [call("recall_memory", { page: 1 })],
          text("要不要吃酸菜鱼"),
        ],
        prompts
      ),
      price,
    }
  )
  assert.equal(reply.replies[0].content, "要不要吃酸菜鱼")
  const first = prompts[0]
  assert.match(first, /饮食习惯：爱喝美式，不吃香菜/)
  assert.match(first, /最近想吃酸菜鱼/, "a loose note is in the prompt")
  assert.doesNotMatch(
    first.split("还没归进主题的零散记忆")[1].split("# 办事")[0],
    /不吃香菜/,
    "sorted notes are not repeated"
  )
  assert.match(first, /recall_memory/)
  assert.ok(!first.includes("update_memory") && !first.includes("forget"))
  // The covered notes are not in the prompt, but the tool brings them back
  const afterTopic = prompts[1]
  assert.ok(afterTopic.includes("不吃香菜") && afterTopic.includes(summary.id) === false)
  assert.match(afterTopic, /recall_memory/)
  assert.match(
    prompts[2],
    /没有叫.*不存在的主题.*的主题/,
    "unknown topic: she is told which topics exist"
  )
  assert.match(prompts[2], /饮食习惯/)
  assert.match(prompts[3], /"pages":1/)
  const recalled = await memory.recallNotes(agentId, { topic: "饮食习惯" })
  assert.deepEqual(
    (recalled as { notes: { content: string }[] }).notes.map((n) => n.content).sort(),
    ["不吃香菜", "爱喝美式"]
  )
  // Paging through every note
  await pool.query(
    "INSERT INTO memories(id,agent_id,content,source,status,created_at,updated_at) SELECT gen_random_uuid()::text, $1, '另一条 ' || g || repeat('字', 80), 'user', 'active', now(), now() FROM generate_series(1, 200) g",
    [agentId]
  )
  const p1 = (await memory.recallNotes(agentId, { page: 1 })) as {
    pages: number
    notes: unknown[]
  }
  assert.ok(p1.pages > 1)
  let total = 0
  for (let p = 1; p <= p1.pages; p++)
    total += ((await memory.recallNotes(agentId, { page: p })) as { notes: unknown[] })
      .notes.length
  assert.equal(total, 203, "every note is on some page")

  // ───── 6. Merge and a decision that touches a summary: grouped, one undo ─────
  await clean()
  const x = await user("住在上海")
  const y = await user("家在上海浦东")
  const z = await user("在上海工作")
  await organizeMemory(agentId, {
    decide: async (view) => ({
      ops: [
        {
          op: "SUMMARIZE",
          id: null,
          topic: "住在哪",
          text: "住在上海浦东，在上海工作",
          ids: view.notes.map((n) => n.id),
          reason: null,
        },
      ],
    }),
  })
  const place = (await all()).find((row) => row.kind === "summary")!
  const moved = await memory.rememberDecided(agentId, "搬到杭州了", {
    guarded: false,
    origin: "test",
    decide: async (_fact, view) => {
      assert.equal(view.summaries.length, 1)
      assert.ok(view.notes.every((n) => n.summaryId === place.id))
      return {
        ops: [
          {
            op: "MERGE",
            ids: [x.id, y.id],
            text: "以前住在上海浦东，现在搬到杭州了",
            reason: "搬家",
          },
          {
            op: "UPDATE",
            id: place.id,
            text: "住在杭州，以前在上海",
            reason: "总结跟着改",
          },
        ],
      }
    },
  })
  assert.equal(moved.changes.filter((c) => c.op === "delete").length, 1)
  rows = await all()
  assert.equal(rows.filter((row) => row.kind === "note").length, 2)
  assert.equal(rows.find((row) => row.id === place.id)!.content, "住在杭州，以前在上海")
  assert.equal(
    rows.find((row) => row.id === x.id)!.summaryId,
    place.id,
    "the merged note stays under the topic"
  )
  const moveLog = (await memory.listChanges(agentId)).slice(0, 3)
  assert.equal(new Set(moveLog.map((c) => c.groupId)).size, 1)
  assert.ok(moveLog[0].groupId)
  await memory.undoChange(agentId, moveLog[2].id)
  rows = await all()
  assert.equal(rows.filter((row) => row.kind === "note").length, 3)
  assert.equal(
    rows.find((row) => row.id === place.id)!.content,
    "住在上海浦东，在上海工作"
  )
  assert.equal(rows.find((row) => row.id === y.id)!.summaryId, place.id)
  void z

  // ───── 7. ASK, ORGANIZE and the exact-duplicate shortcut in the remember step ─────
  await clean()
  const asked = await memory.rememberDecided(agentId, "好像在吃药", {
    guarded: false,
    origin: "test",
    decide: async () => ({ ops: [{ op: "ASK", text: "好像在吃药", reason: "拿不准" }] }),
  })
  assert.equal(asked.candidate!.content, "好像在吃药")
  assert.equal((await all()).filter((row) => row.status === "active").length, 0)
  const wishes = await memory.rememberDecided(agentId, "又记了一条", {
    guarded: false,
    origin: "test",
    decide: async () => ({
      ops: [
        { op: "ADD", text: "又记了一条" },
        { op: "ORGANIZE", reason: "有点乱了" },
      ],
    }),
  })
  assert.equal(wishes.organize, true)
  const [flag] = await db.select().from(companions).where(eq(companions.agentId, agentId))
  assert.equal(flag.memoryOrganizeRequested, true)
  let asked2 = 0
  await memory.rememberDecided(agentId, "又记了一条", {
    guarded: false,
    origin: "test",
    decide: async () => {
      asked2++
      return { ops: [] }
    },
  })
  assert.equal(asked2, 0, "the very same note needs no model call")
  // A sensitive picture: nothing is written, the model is not even asked
  let asked3 = 0
  const guarded = await memory.rememberDecided(agentId, "脸上有颗痣", {
    guarded: true,
    origin: "test",
    decide: async () => {
      asked3++
      return { ops: [{ op: "ADD", text: "脸上有颗痣" }] }
    },
  })
  assert.equal(asked3, 0)
  assert.ok(guarded.candidate)
  assert.equal(
    (await all()).filter((row) => row.content === "脸上有颗痣" && row.status === "active")
      .length,
    0
  )

  // ───── 8. The schedule: asked-for, or a day passed with something changed ─────
  const noopDecide = async () => ({ ops: [] })
  await organizeNow(agentId, { decide: noopDecide }) // clears the request flag
  assert.deepEqual(
    await organizeDue(new Date()),
    [],
    "nothing to do right after a tidy-up"
  )
  await user("刚加的一条")
  assert.deepEqual(await organizeDue(new Date()), [], "changed, but not a day yet")
  assert.deepEqual(
    await organizeDue(new Date(Date.now() + 25 * 3_600_000)),
    [agentId],
    "a day later it is due"
  )
  await pool.query(
    "UPDATE companions SET memory_organized_at = now() - interval '2 days'"
  )
  await pool.query("UPDATE memories SET updated_at = now() - interval '3 days'")
  assert.deepEqual(await organizeDue(new Date()), [], "a day passed but nothing changed")
  await pool.query("UPDATE companions SET memory_organize_requested = true")
  assert.deepEqual(await organizeDue(new Date()), [agentId], "she asked for it herself")
  let ticked = 0
  const tick = await organizeTick(new Date(), {
    decide: async () => {
      ticked++
      return { ops: [] }
    },
  })
  assert.equal(tick.length, 1)
  assert.equal(ticked, 1)
  const [after] = await db
    .select()
    .from(companions)
    .where(eq(companions.agentId, agentId))
  assert.equal(after.memoryOrganizeRequested, false)
  assert.ok(
    after.memoryOrganizedAt && Date.now() - after.memoryOrganizedAt.getTime() < 60_000
  )
  assert.deepEqual((await organizeTick(new Date())).length, 0, "claimed: not run twice")

  // ───── 9. Real worker tick runs the tidy-up of a companion that asked, and survives a failure ─────
  await pool.query("UPDATE companions SET memory_organize_requested = true")
  await companionTick(new Date()) // no model is configured here: the tidy-up fails and is logged
  const [failed] = await db
    .select()
    .from(companions)
    .where(eq(companions.agentId, agentId))
  assert.equal(failed.memoryOrganizeRequested, false, "claimed even though it failed")
  assert.equal((await db.select().from(memories)).length > 0, true, "nothing was lost")

  await closeDurableClient()
  await pool.end()
  console.log("companion memory (agent-driven) integration passed")
  passed = true
} catch (error) {
  console.error(error)
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
  process.exit(passed ? 0 : 1)
}
