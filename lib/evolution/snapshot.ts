// The sanitized snapshot for a candidate stack (B1 owner decision): only persona, settings
// and definitions, plus synthetic chat and memory written here. No real chat, memory, life
// records, pictures, vault items, connection credentials, channel tokens, push
// subscriptions, sessions or secret settings ever leave the trusted database.
import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { pool } from "@/db"

// Non-secret settings a candidate may see
const SETTING_KEYS = ["agent.maxSteps", "chat.reasoningEffort"]
const SETTING_PREFIXES = ["manual."]

const SYNTHETIC_CHAT: [role: "user" | "assistant", content: string][] = [
  ["user", "早上好，今天有点困。"],
  ["assistant", "早上好！昨晚睡得晚吗？先喝杯水醒醒神。"],
  ["user", "下午要整理一份周报，晚点提醒我一下。"],
  ["assistant", "好，我记着。周报写完要是想让我帮你过一遍也可以。"],
  ["user", "今天的日记：去公园散步，看到很多银杏叶。"],
  ["assistant", "听起来很舒服！秋天的银杏最好看了。"],
]
const SYNTHETIC_MEMORY = [
  "（合成）喜欢喝不加糖的拿铁",
  "（合成）周末通常去公园散步",
  "（合成）在学做菜，最近在练番茄炒蛋",
]

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
const insertJson = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((name) => `"${name}"`)
    .join(",")
  return `INSERT INTO ${table}(${columns}) SELECT ${columns} FROM json_populate_record(NULL::${table}, ${literal(JSON.stringify(row))}::json);`
}

export type SnapshotLogin = { email: string; password: string }

export async function sanitizedSeed(input: {
  labPriceSpec: string
  labPrice: { input: number; output: number; cached?: number } | null
}): Promise<{ sql: string; login: SnapshotLogin; agentIds: string[] }> {
  const login = {
    email: `lab-${randomUUID().slice(0, 8)}@owndesk.local`,
    password: randomUUID() + randomUUID(),
  }
  const userId = randomUUID()
  const statements: string[] = ["BEGIN;"]
  const {
    rows: [owner],
  } = await pool.query<{ time_zone: string }>("SELECT time_zone FROM owners LIMIT 1")
  statements.push(
    insertJson('"user"', {
      id: userId,
      name: "Lab Owner",
      email: login.email,
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    insertJson("account", {
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(login.password),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    insertJson("owners", {
      id: 1,
      user_id: userId,
      time_zone: owner?.time_zone ?? "UTC",
      created_at: new Date().toISOString(),
    })
  )
  const agents = await pool.query(
    "SELECT id,name,role,instructions,glyph,created_at,updated_at FROM agents ORDER BY created_at"
  )
  for (const row of agents.rows) statements.push(insertJson("agents", row))
  const companions = await pool.query(
    `SELECT agent_id,persona,time_zone,shares_paused,max_shares_per_day,quiet_start,quiet_end,
      life_times,life_daily_budget_micros,life_session_max_steps,rhythm,push_preview,created_at,updated_at
     FROM companions`
  )
  for (const row of companions.rows)
    statements.push(
      insertJson("companions", { ...row, owner_id: userId, life_enabled: false })
    )
  // Routine definitions, switched off (the candidate never runs the owner's routines)
  const routines = await pool.query(
    `SELECT id,name,agent_id,prompt,schedule,time_zone,plan_version,missed_run_policy,date_range,
      completion_contract,budget,delegate_agent_ids,created_at
     FROM routines WHERE deleted_at IS NULL AND squad_id IS NULL`
  )
  for (const row of routines.rows)
    statements.push(insertJson("routines", { ...row, enabled: false }))
  const settings = await pool.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings WHERE key = ANY($1) OR key LIKE ANY($2)`,
    [SETTING_KEYS, SETTING_PREFIXES.map((prefix) => `${prefix}%`)]
  )
  for (const row of settings.rows)
    statements.push(
      insertJson("settings", { ...row, updated_at: new Date().toISOString() })
    )
  if (input.labPrice)
    statements.push(
      insertJson("settings", {
        key: "pricing.custom",
        value: JSON.stringify({ [input.labPriceSpec]: input.labPrice }),
        updated_at: new Date().toISOString(),
      })
    )
  const base = Date.now() - 3 * 3600_000
  for (const companion of companions.rows) {
    SYNTHETIC_CHAT.forEach(([role, content], index) =>
      statements.push(
        insertJson("companion_messages", {
          id: randomUUID(),
          agent_id: companion.agent_id,
          role,
          kind: "chat",
          content,
          channel: "web",
          created_at: new Date(base + index * 60_000).toISOString(),
        })
      )
    )
    for (const content of SYNTHETIC_MEMORY)
      statements.push(
        insertJson("memories", {
          id: randomUUID(),
          agent_id: companion.agent_id,
          content,
          source: "user",
          status: "active",
          kind: "note",
          created_at: new Date(base).toISOString(),
          updated_at: new Date(base).toISOString(),
        })
      )
  }
  statements.push("COMMIT;")
  return {
    sql: statements.join("\n"),
    login,
    agentIds: agents.rows.map((row) => row.id as string),
  }
}
