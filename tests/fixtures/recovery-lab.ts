import { randomUUID } from "node:crypto"

// Created explicitly by tests; owner initialization only creates the personal agent.
export async function ensureRecoveryLab() {
  const { pool } = await import("@/db")
  const {
    rows: [existing],
  } = await pool.query<{ id: string }>(
    "SELECT id FROM agents WHERE model='fixture/durable-report' LIMIT 1"
  )
  if (existing) return existing.id
  const id = randomUUID()
  await pool.query(
    "INSERT INTO agents(id,name,role,instructions,model,glyph,created_at,updated_at) VALUES($1,'Recovery Lab','Fixed-response recovery experiment; no model calls','Use the controlled three-step fixture.','fixture/durable-report',$2,now(),now())",
    [id, randomUUID()]
  )
  return id
}
