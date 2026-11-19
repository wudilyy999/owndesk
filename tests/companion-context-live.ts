// Long companion chat with the real configured model: an early fact must survive a real summary,
// and later messages must stay word for word. Runs in a throwaway database.
// `npm run test:companion:context-live`
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"

process.loadEnvFile(".env")
const sourceUrl = process.env.DATABASE_URL!
const source = new pg.Client({ connectionString: sourceUrl })
await source.connect()
const settings = (
  await source.query<{ key: string; value: string }>(
    "SELECT key,value FROM settings WHERE key IN ('model.chat','model.default','provider.custom.apiKey','provider.custom.baseUrl','pricing.custom')"
  )
).rows
await source.end()
const setting = (key: string) => settings.find((row) => row.key === key)?.value
const spec =
  process.env.CONTEXT_LIVE_MODEL ??
  setting("model.chat") ??
  setting("model.default") ??
  process.env.OWNDESK_DEFAULT_MODEL
assert.ok(spec, "Configure the real chat model first")
const database = `agent_context_live_${randomUUID().replaceAll("-", "")}`
const url = new URL(sourceUrl)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, { DATABASE_URL: url.toString(), INSTALL_ID: randomUUID() })
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
    // Copy the provider settings only into this throwaway database; nothing is printed
    for (const row of settings)
      await pool.query(
        "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [row.key, row.value]
      )
    const { companionChat } = await import("@/lib/companion/chat")
    const { readCheckpoint } = await import("@/lib/companion/context")
    const { updateCompanion } = await import("@/lib/companion/store")
    const { createModel, getProviderCredentials } =
      await import("@/lib/providers/registry")
    const { parseModelSpec } = await import("@/lib/providers/catalog")
    const parsed = parseModelSpec(spec)
    assert.ok(parsed, `unsupported model ${spec}`)
    const ownerId = "context-live-owner"
    const agentId = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'Asia/Shanghai',now())",
      [ownerId]
    )
    await pool.query(
      "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'小满','Companion','fixture',$2,now(),now())",
      [agentId, spec]
    )
    await updateCompanion(ownerId, agentId, { typingPace: "off" })
    const base = Date.now() - 3 * 3600_000
    const filler = "今天随便聊聊，" + "天气、晚饭、通勤和周末计划。".repeat(40)
    const rows: [string, string, string, number][] = [
      [randomUUID(), "user", "记住，我叫阿青，我们的暗号是蓝鲸42。", base],
      [randomUUID(), "assistant", "好，记住了，阿青。", base + 1000],
    ]
    for (let index = 0; index < 60; index++)
      rows.push([
        randomUUID(),
        index % 2 ? "assistant" : "user",
        `[M${String(index).padStart(3, "0")}] ${filler}`,
        base + 2000 + index * 1000,
      ])
    for (const [id, role, content, at] of rows)
      await pool.query(
        "INSERT INTO companion_messages(id,agent_id,role,kind,content,channel,created_at) VALUES($1,$2,$3,'chat',$4,'web',$5)",
        [id, agentId, role, content, new Date(at)]
      )
    const model = await createModel(spec, await getProviderCredentials(parsed.provider))
    const prompts: string[] = []
    const watched = new Proxy(model as object, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (key !== "doStream" || typeof value !== "function") return value
        return async (options: { prompt: unknown }) => {
          prompts.push(JSON.stringify(options.prompt))
          return value.call(target, options)
        }
      },
    })
    const turn = await companionChat(
      { ownerId, agentId, text: "我们的暗号是什么？只回答暗号本身。" },
      { model: watched as typeof model, spec, contextWindow: 32_768 }
    )
    const reply = turn.replies.map((message) => message.content).join("\n")
    const saved = (await readCheckpoint(agentId)).checkpoint
    assert(saved && saved.folded > 2, "older messages were folded by the real model")
    assert.match(saved.summary, /蓝鲸\s*42/, "the real summary kept the early fact")
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /前情提要/)
    assert.doesNotMatch(prompts[0], /\[M000\]/, "folded messages are not repeated")
    assert.match(prompts[0], /\[M059\]/, "recent messages stay verbatim")
    assert.match(reply, /蓝鲸\s*42/, "the real reply used the summarized fact")
    const usage = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM companion_usage WHERE agent_id=$1",
      [agentId]
    )
    assert(usage.rows[0].n >= 2, "summary and chat calls were both recorded")
    passed = true
    console.log(
      JSON.stringify(
        {
          passed,
          model: spec,
          folded: saved.folded,
          summaryChars: saved.summary.length,
          reply: reply.slice(0, 80),
          recordedCalls: usage.rows[0].n,
        },
        null,
        2
      )
    )
  } finally {
    await closeDurableClient()
    await pool.end()
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin.end()
}
if (!passed) process.exitCode = 1
