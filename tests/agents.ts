// Updating an agent must preserve the default companion and the list's stable order.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import pg from "pg"

process.loadEnvFile(".env")
const database = `agent_order_${randomUUID().replaceAll("-", "")}`
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
let passed = false
try {
  const migration = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
  })
  await once(migration, "exit")
  assert.equal(migration.exitCode, 0)
  const { pool } = await import("@/db")
  const { listAgents } = await import("@/lib/agents")
  try {
    await pool.query(
      `INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES
       ('oldest','Default','Synthetic ordering check','a','custom/test','2026-01-01',now()),
       ('same-b','Second tie','Synthetic ordering check','b','custom/test','2026-02-01',now()),
       ('same-a','First tie','Synthetic ordering check','c','custom/test','2026-02-01',now()),
       ('hidden','Fixture','Synthetic ordering check','d','fixture/durable-report','2025-01-01',now())`
    )
    const before = (await listAgents()).map((agent) => agent.id)
    assert.equal(before[0], "oldest")
    await pool.query(
      "UPDATE agents SET name='Saved settings',updated_at=now() WHERE id='oldest'"
    )
    const after = (await listAgents()).map((agent) => agent.id)
    console.log(JSON.stringify({ before, after }))
    assert.equal(after[0], "oldest", "Saving settings keeps the same default companion")
    assert.deepEqual(after, ["oldest", "same-a", "same-b"])
    assert(!after.includes("hidden"))
    passed = true
    console.log(
      "PASS: PostgreSQL agent updates preserve the default, tie order and fixture exclusion"
    )
  } finally {
    await pool.end()
  }
} finally {
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  else console.error(`Failed ordering evidence database retained: ${database}`)
  await admin.end()
}
