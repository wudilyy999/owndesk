import { pool } from "@/db"
import { respondToRequest } from "@/lib/task-control"

export async function resumeMonthlyBudgets() {
  const { rows } =
    await pool.query(`SELECT r.id,r.payload_version,t.owner_id FROM task_requests r JOIN tasks t ON t.id=r.task_id
    WHERE r.status='pending' AND r.kind='budget' AND r.payload->>'purpose'='monthly'
    AND (r.payload->'monthly'->>'endsAt')::timestamptz<=now() AND t.cancel_requested_at IS NULL
    AND t.status NOT IN ('completed','failed','cancelled') ORDER BY r.created_at LIMIT 20`)
  for (const row of rows)
    await respondToRequest(
      row.owner_id,
      row.id,
      "continue",
      row.payload_version,
      { note: "按已配置的自然月预算规则自动重新检查；新请求仍经过实时费用与预算检查。" },
      "calendar"
    )
}
