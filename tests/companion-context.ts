// Long companion chats against a throwaway database: the model sees a rolling summary plus every
// later message, the summary folds old turns once the window fills, the latest round stays out of
// it, deleted memories are not brought back, and a provider "too long" refusal is retried once.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"

process.loadEnvFile(".env")
const database = `agent_chat_context_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  CUSTOM_BASE_URL: "http://127.0.0.1:1/v1",
  CUSTOM_API_KEY: "local-fixture-key",
})
const checks: string[] = []
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)
  const { pool } = await import("@/db")
  const { closeDurableClient } = await import("@/lib/durable")
  try {
    const { companionChat } = await import("@/lib/companion/chat")
    const { readCheckpoint } = await import("@/lib/companion/context")
    const { addNote, deleteNote } = await import("@/lib/companion/memory")
    const { updateCompanion } = await import("@/lib/companion/store")
    const ownerId = "context-owner"
    const agentId = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Shanghai',now())",
      [ownerId]
    )
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture','custom/mock',now(),now())",
      [agentId]
    )
    await updateCompanion(ownerId, agentId, { typingPace: "off" })
    const price = { kind: "local" } as const
    const usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    }
    const textOf = (prompt: unknown) => JSON.stringify(prompt)
    // Chat calls stream; summary calls are generateText. Both are recorded.
    type Call = { kind: "chat" | "summary"; prompt: string }
    const model = (
      calls: Call[],
      options: {
        reply?: string
        summary?: (prompt: string) => string
        refuse?: number
      } = {}
    ) => {
      let refusals = options.refuse ?? 0
      return new MockLanguageModelV3({
        doStream: async (call) => {
          calls.push({ kind: "chat", prompt: textOf(call.prompt) })
          if (refusals > 0) {
            refusals--
            throw Object.assign(
              new Error("This model's maximum context length is 65536 tokens"),
              { statusCode: 400 }
            )
          }
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] })
                controller.enqueue({ type: "text-start", id: "t" })
                controller.enqueue({
                  type: "text-delta",
                  id: "t",
                  delta: options.reply ?? "嗯嗯",
                })
                controller.enqueue({ type: "text-end", id: "t" })
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  usage,
                })
                controller.close()
              },
            }),
          }
        },
        doGenerate: async (call) => {
          const prompt = textOf(call.prompt)
          calls.push({ kind: "summary", prompt })
          return {
            content: [
              {
                type: "text",
                text:
                  options.summary?.(prompt) ??
                  `## 对方的偏好、要求和约定\n- 对方叫阿青，暗号是蓝鲸42\n\n## 重要细节\n- （无）`,
              },
            ],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          }
        },
      })
    }

    // 1. A long chat: the earliest fact is far beyond 30 messages back
    const base = Date.now() - 3 * 3600_000
    const filler = "今天随便聊聊，" + "天气、晚饭、通勤和周末计划。".repeat(40)
    const rows: unknown[] = []
    rows.push([randomUUID(), "user", "记住，我叫阿青，我们的暗号是蓝鲸42。", base])
    rows.push([randomUUID(), "assistant", "好，记住了。", base + 1000])
    for (let index = 0; index < 60; index++)
      rows.push([
        randomUUID(),
        index % 2 ? "assistant" : "user",
        `[M${String(index).padStart(3, "0")}] ${filler}`,
        base + 2000 + index * 1000,
      ])
    for (const [id, role, content, at] of rows as [string, string, string, number][])
      await pool.query(
        "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at) VALUES($1,$2,$3,'chat',$4,'web',$5)",
        [id, agentId, role, content, new Date(at)]
      )
    const first: Call[] = []
    await companionChat(
      { ownerId, agentId, text: "你还记得我们的暗号吗？" },
      { model: model(first), price, contextWindow: 32_768 }
    )
    const summaries = first.filter((call) => call.kind === "summary")
    const chat = first.filter((call) => call.kind === "chat")
    assert(summaries.length >= 1, "older chat was summarized")
    assert.match(summaries[0].prompt, /蓝鲸42/, "the summary call saw the earliest fact")
    assert.equal(chat.length, 1)
    assert.match(chat[0].prompt, /前情提要/)
    assert.match(
      chat[0].prompt,
      /蓝鲸42/,
      "the early fact reaches the reply via the summary"
    )
    assert.match(chat[0].prompt, /你还记得我们的暗号吗/)
    assert.doesNotMatch(chat[0].prompt, /\[M000\]/, "folded messages are not repeated")
    assert.match(chat[0].prompt, /\[M059\]/, "recent messages stay verbatim")
    assert.doesNotMatch(
      chat[0].prompt,
      /放不下/,
      "nothing between the summary and the tail is lost"
    )
    const saved = await readCheckpoint(agentId)
    assert(saved.checkpoint && saved.checkpoint.folded > 2)
    checks.push(
      "Long chat (62 older messages) folds old turns into a summary; earliest fact reaches the model and recent messages stay verbatim"
    )

    // 2. Later turns reuse the checkpoint and accumulate messages verbatim
    const second: Call[] = []
    await companionChat(
      { ownerId, agentId, text: "再说一次暗号" },
      { model: model(second, { reply: "蓝鲸42呀" }), price, contextWindow: 32_768 }
    )
    assert.equal(second.filter((call) => call.kind === "summary").length, 0)
    const third: Call[] = []
    await companionChat(
      { ownerId, agentId, text: "好的" },
      { model: model(third), price, contextWindow: 32_768 }
    )
    const thirdChat = third.find((call) => call.kind === "chat")!.prompt
    assert.match(thirdChat, /你还记得我们的暗号吗/)
    assert.match(thirdChat, /再说一次暗号/)
    assert.match(thirdChat, /蓝鲸42呀/)
    assert.equal(third.filter((call) => call.kind === "summary").length, 0)
    checks.push(
      "Turns after the checkpoint accumulate verbatim without a new summary call"
    )

    // 3. Redo: the latest round never enters the summary, and its replaced answer stays out
    const before = (await readCheckpoint(agentId)).checkpoint!
    const longTurn = "这是很长的一轮。" + "细节".repeat(9000)
    await companionChat(
      { ownerId, agentId, text: longTurn },
      { model: model([], { reply: "旧回答ABC" }), price, contextWindow: 32_768 }
    )
    const redo: Call[] = []
    await companionChat(
      { ownerId, agentId, text: "", redo: "regenerate" },
      {
        model: model(redo, { reply: "新回答" }),
        price,
        contextWindow: 32_768,
      }
    )
    for (const call of redo.filter((item) => item.kind === "summary")) {
      assert.doesNotMatch(call.prompt, /旧回答ABC/)
      assert.doesNotMatch(call.prompt, /这是很长的一轮/)
    }
    assert.doesNotMatch(redo.find((call) => call.kind === "chat")!.prompt, /旧回答ABC/)
    assert.match(redo.find((call) => call.kind === "chat")!.prompt, /这是很长的一轮/)
    const after = (await readCheckpoint(agentId)).checkpoint!
    const through = await pool.query(
      "SELECT content FROM companion_messages WHERE id=$1",
      [after.through.id]
    )
    assert.doesNotMatch(String(through.rows[0]?.content), /这是很长的一轮|旧回答ABC/)
    assert(after.folded >= before.folded)
    checks.push(
      "Regenerate keeps the latest round verbatim, never folds it, and the replaced answer is not summarized or shown"
    )

    // 4. A deleted memory is removed from the summary before the next reply
    const note = await addNote(agentId, "暗号是蓝鲸42", "user", "active")
    await deleteNote(agentId, note.id, { actor: "user", origin: "memory" })
    const forget: Call[] = []
    await companionChat(
      { ownerId, agentId, text: "我们聊点别的" },
      {
        model: model(forget, {
          summary: (prompt) =>
            prompt.includes("已删除的记忆")
              ? "## 对方的偏好、要求和约定\n- 对方叫阿青\n\n## 重要细节\n- （无）"
              : "## 重要细节\n- 暗号是蓝鲸42",
        }),
        price,
        contextWindow: 32_768,
      }
    )
    const rewrite = forget.find((call) => call.kind === "summary")
    assert(rewrite, "the summary is rewritten after a deletion")
    assert.match(rewrite.prompt, /已删除的记忆/)
    assert.match(rewrite.prompt, /暗号是蓝鲸42/)
    const forgetChat = forget.find((call) => call.kind === "chat")!.prompt
    assert.match(forgetChat, /对方叫阿青/)
    assert.doesNotMatch(
      forgetChat.split("我们聊点别的")[0].split("前情提要")[1] ?? "",
      /蓝鲸42[^呀]/
    )
    assert.doesNotMatch((await readCheckpoint(agentId)).checkpoint!.summary, /蓝鲸42/)
    // A failed rewrite holds the old summary back instead of using it
    const note2 = await addNote(agentId, "对方叫阿青", "user", "active")
    await deleteNote(agentId, note2.id, { actor: "user", origin: "memory" })
    const broken = model([], { summary: () => "随便写的，没有模板" })
    const held: Call[] = []
    const heldModel = model(held)
    broken.doStream = heldModel.doStream
    await companionChat(
      { ownerId, agentId, text: "嗯" },
      { model: broken, price, contextWindow: 32_768 }
    )
    assert.doesNotMatch(
      held.find((call) => call.kind === "chat")!.prompt.split("前情提要")[1] ?? "",
      /对方叫阿青/
    )
    checks.push(
      "Deleting a memory rewrites the summary without it; when the rewrite fails the old summary is held back"
    )

    // 5. Provider refuses as too long: summarize harder once and answer; a second refusal fails
    await pool.query("DELETE FROM settings WHERE key=$1", [
      `companion.context.${agentId}`,
    ])
    const retry: Call[] = []
    const answered = await companionChat(
      { ownerId, agentId, text: "最后一个问题" },
      { model: model(retry, { refuse: 1 }), price, contextWindow: 200_000 }
    )
    assert.equal(answered.replies[0].content, "嗯嗯")
    assert.equal(retry.filter((call) => call.kind === "chat").length, 2)
    assert(
      retry.some((call) => call.kind === "summary"),
      "forced summary after refusal"
    )
    const twice: Call[] = []
    await assert.rejects(
      companionChat(
        { ownerId, agentId, text: "再问一个" },
        { model: model(twice, { refuse: 2 }), price, contextWindow: 200_000 }
      ),
      /maximum context length/
    )
    assert.equal(twice.filter((call) => call.kind === "chat").length, 2)
    checks.push(
      "A context-window refusal before any reply triggers one forced summary and resend; a second refusal is reported"
    )

    // 6. A model that keeps calling tools still answers: the last step cannot call tools
    const choices: unknown[] = []
    const looping = new MockLanguageModelV3({
      doStream: async (call) => {
        choices.push(call.toolChoice)
        const parts =
          call.toolChoice?.type === "none"
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "翻完了，没找到更多" },
                { type: "text-end", id: "t" },
              ]
            : [
                {
                  type: "tool-call",
                  toolCallId: randomUUID(),
                  toolName: "recall_memory",
                  input: JSON.stringify({ page: 1 }),
                },
              ]
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              for (const part of parts) controller.enqueue(part as never)
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: call.toolChoice?.type === "none" ? "stop" : "tool-calls",
                  raw: undefined,
                },
                usage,
              })
              controller.close()
            },
          }),
        }
      },
    })
    const looped = await companionChat(
      { ownerId, agentId, text: "帮我翻翻记忆" },
      { model: looping, price, contextWindow: 200_000 }
    )
    assert.equal(choices.length, 4)
    assert.deepEqual(choices.at(-1), { type: "none" })
    assert.deepEqual(
      looped.replies.map((reply) => reply.content),
      ["翻完了，没找到更多"]
    )
    checks.push("A tool-calling loop ends with a forced text reply on the last step")

    // 7. Channel retries: an answered delivery returns the saved reply without a model call; a
    // delivery that failed after a tool wrote something is not run twice
    const sourceKey = `telegram:${randomUUID()}`
    const once: Call[] = []
    const firstDelivery = await companionChat(
      { ownerId, agentId, text: "渠道里的一句话", channel: "telegram", sourceKey },
      { model: model(once, { reply: "收到啦" }), price, contextWindow: 200_000 }
    )
    const again: Call[] = []
    const secondDelivery = await companionChat(
      { ownerId, agentId, text: "渠道里的一句话", channel: "telegram", sourceKey },
      { model: model(again), price, contextWindow: 200_000 }
    )
    assert.equal(again.length, 0, "no model call for an answered delivery")
    assert.equal(secondDelivery.user.id, firstDelivery.user.id)
    assert.deepEqual(
      secondDelivery.replies.map((reply) => reply.id),
      firstDelivery.replies.map((reply) => reply.id)
    )
    const count = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM companion_messages WHERE agent_id=$1 AND content='渠道里的一句话'",
            [agentId]
          )
        ).rows[0].count
      )
    assert.equal(await count(), 1)
    const notes = async () =>
      Number(
        (await pool.query("SELECT count(*) FROM memories WHERE agent_id=$1", [agentId]))
          .rows[0].count
      )
    const notesBefore = await notes()
    const crashKey = `telegram:${randomUUID()}`
    let step = 0
    const crashing = model([])
    crashing.doStream = async () => {
      if (step++ === 0)
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({
                type: "tool-call",
                toolCallId: randomUUID(),
                toolName: "remember",
                input: JSON.stringify({ note: "喜欢蓝色的杯子" }),
              } as never)
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
              })
              controller.close()
            },
          }),
        }
      throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 })
    }
    await assert.rejects(
      companionChat(
        {
          ownerId,
          agentId,
          text: "我喜欢蓝色的杯子",
          channel: "telegram",
          sourceKey: crashKey,
        },
        { model: crashing, price, contextWindow: 200_000 }
      ),
      /已经办的事/
    )
    assert.equal(await notes(), notesBefore + 1, "the remembered fact was kept once")
    const retried: Call[] = []
    await assert.rejects(
      companionChat(
        {
          ownerId,
          agentId,
          text: "我喜欢蓝色的杯子",
          channel: "telegram",
          sourceKey: crashKey,
        },
        { model: model(retried), price, contextWindow: 200_000 }
      ),
      /没有重复执行/
    )
    assert.equal(retried.length, 0)
    assert.equal(await notes(), notesBefore + 1, "a retry does not remember it twice")
    checks.push(
      "A retried channel delivery reuses its saved reply; after a tool wrote something a failed turn is never run again"
    )
    passed = true
  } finally {
    await closeDurableClient()
    await pool.end()
  }
} finally {
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, database }, null, 2))
