// Every model request the lab makes (the reformer, the reviewer, and the candidate stack
// through the lab gateway) is recorded on the improvement round's task, so it counts
// toward the improvement's own limits (if the owner set any) and the monthly budget.
import { pool } from "@/db"
import type { PoolClient } from "pg"
import { setTimeout as delay } from "node:timers/promises"
import type { Objective } from "@/db/schema"
import { limitReason, objectiveUsage } from "@/lib/objectives"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import { getCustomPrices, monthlyBlock, monthlyUsage } from "@/lib/spend"

export const SEGMENT = { reformer: 1, reviewer: 2, gateway: 3 } as const

export class LabBudgetError extends Error {
  name = "LabBudgetError"
  constructor(
    message: string,
    readonly end: "steps" | "cost" = "cost"
  ) {
    super(message)
  }
}

// Why no more lab model requests may be made for this improvement, or null
export async function spendBlock(
  objective: Objective,
  spec: string,
  client?: PoolClient
) {
  // The dispatcher already admitted this round. Its round count must not prevent
  // work inside it (including the last round the owner allowed).
  const reason = limitReason(
    { ...objective.budget, maxRounds: undefined },
    await objectiveUsage(objective.id, client)
  )
  if (reason) return reason
  const price = findPrice(spec, { custom: await getCustomPrices(client) })
  return monthlyBlock(await monthlyUsage(objective.ownerId, client), price)
}

export async function beginAttempt(taskId: string, segmentNo: number, spec: string) {
  while (true) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT pg_advisory_xact_lock(71261206)")
      const {
        rows: [task],
      } = await client.query<{
        status: string
        cancel_requested_at: Date | null
        objective: Objective
        roundSteps: number
        roundMaxSteps: number | null
      }>(
        `SELECT t.status,t.cancel_requested_at,
          (SELECT count(*)::int FROM task_model_attempts a WHERE a.task_id=t.id) AS "roundSteps",
          (t.budget->>'maxSteps')::int AS "roundMaxSteps",
          jsonb_build_object('id',o.id,'ownerId',o.owner_id,'budget',o.budget,'status',o.status) AS objective
         FROM tasks t JOIN objectives o ON o.id=t.objective_id WHERE t.id=$1 FOR UPDATE OF t`,
        [taskId]
      )
      if (
        !task ||
        task.status !== "running" ||
        task.cancel_requested_at ||
        task.objective.status === "stopped"
      )
        throw new LabBudgetError("改进已停止")
      if (task.roundSteps >= (task.roundMaxSteps ?? task.objective.budget.roundMaxSteps))
        throw new LabBudgetError("这一轮已达到步数上限", "steps")
      const price = findPrice(spec, { custom: await getCustomPrices(client) })
      const month = await monthlyUsage(task.objective.ownerId, client)
      const {
        rows: [pending],
      } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id
         WHERE t.objective_id=$1 AND a.status='pending'`,
        [task.objective.id]
      )
      // Same admission lock as ordinary tasks. A pending receipt is published before
      // releasing it, so concurrent gateway calls cannot all pass the same cap.
      if (
        (month.budgetMicros !== null &&
          price?.kind !== "local" &&
          month.pendingPaid > 0) ||
        ((task.objective.budget.maxCostMicros !== undefined ||
          task.objective.budget.maxSteps !== undefined) &&
          pending.n > 0)
      ) {
        await client.query("COMMIT")
      } else {
        const reason = await spendBlock(task.objective, spec, client)
        if (reason) throw new LabBudgetError(reason)
        const {
          rows: [row],
        } = await client.query<{ id: string }>(
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
        await client.query("COMMIT")
        return {
          id: row.id,
          price,
          remainingSteps:
            (task.roundMaxSteps ?? task.objective.budget.roundMaxSteps) -
            task.roundSteps -
            1,
        }
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    await delay(250)
  }
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
