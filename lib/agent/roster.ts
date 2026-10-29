import { pool } from "@/db"
import { HttpError } from "@/lib/errors"

export async function assertDelegationRoster(agentIds: string[]) {
  if (!agentIds.length) return
  const allowed = await pool.query(
    "SELECT id FROM agents WHERE id=ANY($1::text[]) AND model IS DISTINCT FROM 'fixture/durable-report'",
    [agentIds]
  )
  if (allowed.rowCount !== new Set(agentIds).size)
    throw new HttpError(
      400,
      "Choose existing non-fixture agents for this task's delegation roster"
    )
}
