// Adapted from the pinned MIT upstream lib/spend.ts (pinned v0.6.0, MIT, Sourav Bera).
// Keeps custom rates and monthly budget concepts; replaces turn totals with attempt receipts.
import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { z } from "zod"
import { pool } from "@/db"
import { monthlyBudgetSchema, modelSpecSchema } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { appendEventInTransaction } from "@/lib/task-events"
import type { Price, CustomPrices } from "@/lib/providers/pricing"

export const usageIdSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const rate = z
  .object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cached: z.number().finite().nonnegative().optional(),
  })
  .strict()
const pricesSchema = z.record(modelSpecSchema, rate)
export const priceMutationSchema = z.object({
  model: modelSpecSchema.max(200),
  rate: rate.nullable(),
})
export async function getCustomPrices(client?: PoolClient): Promise<CustomPrices> {
  const {
    rows: [row],
  } = await (client ?? pool).query(
    "SELECT value FROM settings WHERE key='pricing.custom'"
  )
  return row ? pricesSchema.parse(JSON.parse(row.value)) : {}
}
export async function setCustomPrice(model: string, value: z.infer<typeof rate> | null) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(71261206)")
    const prices = await getCustomPrices(client)
    if (value) prices[model] = value
    else delete prices[model]
    await client.query(
      `INSERT INTO settings(key,value,updated_at) VALUES('pricing.custom',$1,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
      [JSON.stringify(prices)]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export type MonthlyUsage = {
  month: string
  timeZone: string
  startsAt: Date
  endsAt: Date
  budgetMicros: number | null
  knownCostMicros: string
  unknown: number
  pendingPaid: number
  attempts: number
  legacy: number
}
export async function monthlyUsage(
  ownerId: string,
  client?: PoolClient,
  at?: Date
): Promise<MonthlyUsage> {
  const query = client ?? pool
  const {
    rows: [period],
  } = await query.query(
    `SELECT time_zone AS "timeZone",to_char(COALESCE($2::timestamptz,now()) AT TIME ZONE time_zone,'YYYY-MM') AS month,
    date_trunc('month',COALESCE($2::timestamptz,now()) AT TIME ZONE time_zone) AT TIME ZONE time_zone AS "startsAt",
    (date_trunc('month',COALESCE($2::timestamptz,now()) AT TIME ZONE time_zone)+interval '1 month') AT TIME ZONE time_zone AS "endsAt"
    FROM owners WHERE user_id=$1`,
    [ownerId, at ?? null]
  )
  if (!period) throw new HttpError(403, "Owner access required")
  const {
    rows: [row],
  } = await query.query(
    `SELECT COALESCE(sum(COALESCE(a.cost_micros,a.reconciled_cost_micros)),0)::text AS "knownCostMicros",
    count(*) FILTER(WHERE a.status<>'pending' AND a.cost_micros IS NULL AND a.reconciled_cost_micros IS NULL)::int AS unknown,
    count(*) FILTER(WHERE a.status='pending' AND COALESCE(a.price_snapshot->>'kind','priced')<>'local')::int AS "pendingPaid",
    count(*)::int AS attempts,count(*) FILTER(WHERE a.legacy)::int AS legacy
    FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=$1 AND a.started_at >= $2 AND a.started_at < $3`,
    [ownerId, period.startsAt, period.endsAt]
  )
  const settings = await query.query(
    "SELECT value FROM settings WHERE key='usage.monthlyBudget'"
  )
  const budget = monthlyBudgetSchema.parse(
    settings.rows[0]?.value ?? process.env.OWNDESK_MONTHLY_BUDGET ?? ""
  )
  return {
    ...period,
    ...row,
    budgetMicros: budget === "" ? null : Math.round(Number(budget) * 1000000),
  }
}
export function monthlyBlock(usage: MonthlyUsage, price: Price | null): string | null {
  if (usage.budgetMicros === null || price?.kind === "local") return null
  if (!price) return "此模型没有可用定价。先设置自定义单价，或明确移除月预算后再继续。"
  if (usage.unknown)
    return "本月有尚未核对的请求费用。请在用量页核对实际账单，或明确移除月预算。"
  if (BigInt(usage.knownCostMicros) >= BigInt(usage.budgetMicros))
    return "本月已知费用已达到月预算。请提高/移除预算，或等待下一个自然月。"
  return null
}
export async function usageOverview(ownerId: string, before?: string) {
  const month = await monthlyUsage(ownerId)
  const [prices, recent, models] = await Promise.all([
    getCustomPrices(),
    pool.query(
      `SELECT a.id::text,a.task_id AS "taskId",a.model,a.status,a.attempt_no AS "attemptNo",a.cost_micros::text AS "costMicros",a.reconciled_cost_micros::text AS "reconciledCostMicros",a.reconciliation_note AS "reconciliationNote",a.price_snapshot AS "priceSnapshot",a.usage,a.error,a.legacy,a.started_at AS "startedAt",a.finished_at AS "finishedAt"
      FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=$1 AND ($2::bigint IS NULL OR a.id<$2) ORDER BY a.id DESC LIMIT 51`,
      [ownerId, before ?? null]
    ),
    pool.query(
      `SELECT a.model,count(*)::int AS attempts,COALESCE(sum(COALESCE(a.cost_micros,a.reconciled_cost_micros)),0)::text AS "costMicros",
      count(*) FILTER(WHERE a.status<>'pending' AND a.cost_micros IS NULL AND a.reconciled_cost_micros IS NULL)::int AS unknown
      FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=$1 AND a.started_at >= $2 AND a.started_at < $3 GROUP BY a.model ORDER BY a.model`,
      [ownerId, month.startsAt, month.endsAt]
    ),
  ])
  return {
    month,
    prices,
    models: models.rows,
    attempts: recent.rows.slice(0, 50),
    hasMore: recent.rows.length > 50,
  }
}
export const reconciliationSchema = z.object({
  id: usageIdSchema,
  costMicros: z.number().int().safe().nonnegative(),
  note: z.string().trim().min(1).max(1000),
})
export async function reconcileUsage(
  ownerId: string,
  input: z.infer<typeof reconciliationSchema>
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(71261206)")
    const {
      rows: [candidate],
    } = await client.query(
      "SELECT a.task_id FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 AND t.owner_id=$2",
      [input.id, ownerId]
    )
    if (!candidate) throw new HttpError(404, "Usage record not found")
    await client.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [candidate.task_id])
    const {
      rows: [attempt],
    } = await client.query("SELECT * FROM task_model_attempts WHERE id=$1 FOR UPDATE", [
      input.id,
    ])
    if (attempt.status === "pending" || attempt.cost_micros !== null)
      throw new HttpError(409, "Only an unknown cost may be reconciled")
    await client.query(
      "UPDATE task_model_attempts SET reconciled_cost_micros=$2,reconciliation_note=$3,reconciled_at=now() WHERE id=$1",
      [input.id, input.costMicros, input.note]
    )
    await appendEventInTransaction(
      client,
      candidate.task_id,
      `usage-reconciled:${input.id}:${randomUUID()}`,
      "usage_reconciled",
      {
        attemptId: input.id,
        previousCostMicros: attempt.reconciled_cost_micros,
        costMicros: input.costMicros,
        note: input.note,
        source: "owner",
      }
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
