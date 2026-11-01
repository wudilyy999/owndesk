// Real-model spike for the light chat path: latency (first token / total), tokens, tool use.
// Usage: set -a; . ./.env; set +a; npx tsx scripts/spike-chat.ts
import { db, pool } from "@/db"
import { agents, companionUsage, owners } from "@/db/schema"
import { desc } from "drizzle-orm"
import { companionChat } from "@/lib/companion/chat"
import { listNotes } from "@/lib/companion/memory"

export {}
const [owner] = await db.select().from(owners)
const [agent] = await db.select().from(agents)
const turns = [
  "今天好累，下班路上还下雨了",
  "对了，我下个月 15 号生日，喜欢吃抹茶蛋糕，帮我记一下",
  "帮我去网上查一下台北到高雄下周五的高铁票价，整理成一个表格",
  "你是真人吗？",
]
for (const text of turns) {
  const started = Date.now()
  let first = 0
  const { replies } = await companionChat(
    { ownerId: owner.userId, agentId: agent.id, text },
    {},
    (event) => {
      if (event.type === "delta" && !first) first = Date.now() - started
    }
  )
  const [usage] = await db
    .select()
    .from(companionUsage)
    .orderBy(desc(companionUsage.createdAt))
    .limit(1)
  console.log(
    JSON.stringify({
      text,
      firstTokenMs: first,
      totalMs: Date.now() - started,
      tokens: [usage.inputTokens, usage.outputTokens],
      model: usage.model,
      costMicros: usage.costMicros,
      replies: replies.map((r) => `[${r.kind}] ${r.content}`),
    })
  )
}
console.log(
  "memories",
  (await listNotes(agent.id)).map((n) => n.content)
)
await pool.end()
