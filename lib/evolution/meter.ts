// Every model request the lab makes (the reformer, the reviewer, and the candidate stack
// through the lab gateway) is recorded on the improvement round's task, so it counts
// toward the improvement's own limits (if the owner set any) and the monthly budget.
import { pool } from "@/db"
import type { Objective } from "@/db/schema"
import { limitReason, objectiveUsage } from "@/lib/objectives"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import { getCustomPrices, monthlyBlock, monthlyUsage } from "@/lib/spend"

export const SEGMENT = { reformer: 1, reviewer: 2, gateway: 3 } as const

export class LabBudgetError extends Error {
  name = "LabBudgetError"
}

// Why no more lab model requests may be made for this improvement, or null
export async function spendBlock(objective: Objective, spec: string) {
  const reason = limitReason(objective.budget, await objectiveUsage(objective.id))
  if (reason) return reason
  const price = findPrice(spec, { custom: await getCustomPrices() })
  return monthlyBlock(await monthlyUsage(objective.ownerId), price)
}

export async function priceFor(spec: string): Promise<Price | null> {
  return findPrice(spec, { custom: await getCustomPrices() })
}

export async function beginAttempt(
  taskId: string,
  segmentNo: number,
  spec: string,
  price: Price | null
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const {
        rows: [row],
      } = await pool.query<{ id: string }>(
        `INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,price_snapshot,cost_micros,started_at)
         SELECT $1,$2,COALESCE(max(decision_no),0)+1,1,$3,'pending',$4,$5,now()
         FROM task_model_attempts WHERE task_id=$1 AND segment_no=$2 RETURNING id::text`,
        [
          taskId,
          segmentNo,
          spec,
          JSON.stringify(price),
          price?.kind === "local" ? 0 : null,
        ]
      )
      return row.id
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error
    }
  }
  throw new Error("Could not record the model request")
}

export async function finishAttempt(
  id: string,
  price: Price | null,
  usage: { input: number; output: number; cached?: number } | null,
  error?: string
) {
  const cost = usage ? callCost(price, usage) : null
  await pool.query(
    `UPDATE task_model_attempts SET status=$2,usage=$3,cost_micros=COALESCE($4,cost_micros),error=$5,finished_at=now() WHERE id=$1::bigint`,
    [
      id,
      usage ? "succeeded" : "unknown",
      usage
        ? JSON.stringify({
            input: usage.input,
            output: usage.output,
            cached: usage.cached ?? 0,
            reasoning: 0,
            missing: false,
          })
        : null,
      cost === null ? null : toMicros(cost),
      error ? error.slice(0, 2000) : null,
    ]
  )
}
