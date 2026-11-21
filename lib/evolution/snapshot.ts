import { defaultPersona } from "@/lib/companion/persona"
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

async function seedOwner(timeZone: string) {
  const login = {
    email: `lab-${randomUUID().slice(0, 8)}@owndesk.local`,
    password: randomUUID() + randomUUID(),
  }
  const userId = randomUUID()
  const statements: string[] = ["BEGIN;"]
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
      time_zone: timeZone,
      created_at: new Date().toISOString(),
    })
  )
  return { statements, login, userId }
}

function seedDiary(statements: string[], agentId: string, today: Date) {
  for (const [index, title] of ["公园散步", "番茄炒蛋", "整理周报"].entries()) {
    const createdAt = new Date(today.getTime() - index * 86400_000).toISOString()
    statements.push(
      insertJson("life_activities", {
        id: randomUUID(),
        agent_id: agentId,
        kind: "diary",
        title: `（合成）${title}日记`,
        summary: `（合成）${title}的测试记录`,
        body: `（合成）这是用于候选界面验收的${title}日记。`,
        starred: false,
        created_at: createdAt,
      })
    )
  }
}

// Development previews never read the owner's database.
export async function previewSeed() {
  const { statements, login, userId } = await seedOwner("UTC")
  const agentId = randomUUID(),
    now = new Date().toISOString()
  statements.push(
    insertJson("agents", {
      id: agentId,
      name: "预览助手",
      role: "assistant",
      glyph: "preview",
      created_at: now,
      updated_at: now,
    }),
    insertJson("companions", {
      agent_id: agentId,
      owner_id: userId,
      persona: defaultPersona,
      created_at: now,
      updated_at: now,
    })
  )
  const today = new Date()
  today.setUTCHours(4, 0, 0, 0)
  seedDiary(statements, agentId, today)
  statements.push("COMMIT;")
  return { sql: statements.join("\n"), login }
}

export async function sanitizedSeed(input: {
  labPriceSpec: string
  labPrice: { input: number; output: number; cached?: number } | null
}): Promise<{ sql: string; login: SnapshotLogin; agentIds: string[] }> {
  const {
    rows: [owner],
  } = await pool.query<{ time_zone: string }>("SELECT time_zone FROM owners LIMIT 1")
  const { statements, login, userId } = await seedOwner(owner?.time_zone ?? "UTC")
  const agents = await pool.query("SELECT * FROM agents ORDER BY created_at")
  for (const row of agents.rows)
    statements.push(
      insertJson("agents", { ...row, model: input.labPriceSpec, workstation_id: null })
    )
  // Persona and companion settings (no secrets live in this table)
  const companions = await pool.query("SELECT * FROM companions")
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
    // Synthetic dates and rounds let the reviewer exercise filtering and progress
    // without importing any of the owner's diary, objectives or task history.
    const today = new Date()
    today.setUTCHours(4, 0, 0, 0)
    seedDiary(statements, companion.agent_id, today)
    const objectiveId = randomUUID()
    statements.push(
      insertJson("objectives", {
        id: objectiveId,
        owner_id: userId,
        agent_id: companion.agent_id,
        title: "（合成）整理本周周报",
        objective: "（合成）整理本周的测试周报",
        completion_contract: { requireHumanReview: false },
        budget: { roundMaxSteps: 40 },
        status: "paused",
        created_at: new Date(today.getTime() - 9 * 86400_000).toISOString(),
        updated_at: today.toISOString(),
      })
    )
    for (const [index, daysAgo] of [8, 1, 0].entries()) {
      const at = new Date(today.getTime() - daysAgo * 86400_000).toISOString()
      statements.push(
        insertJson("objective_rounds", {
          id: randomUUID(),
          objective_id: objectiveId,
          round_no: index + 1,
          input: {
            agentId: companion.agent_id,
            goal: "（合成）整理测试周报",
            clientRequestId: randomUUID(),
            objectiveRound: { objectiveId, roundNo: index + 1 },
            budget: { maxSteps: 40 },
            completionContract: { requireHumanReview: false },
          },
          verdict: "progress",
          summary: `（合成）完成第 ${index + 1} 部分整理`,
          started_at: at,
          finished_at: at,
        })
      )
    }
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
