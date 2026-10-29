// Adapted from the pinned MIT upstream lib/routines.ts (MIT): plan types, manual runs and history.
// Scheduling and execution use the existing DBOS worker and durable task entrance.
import { randomUUID } from "node:crypto"
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { db, pool } from "@/db"
import {
  agents,
  owners,
  routines,
  routineRuns,
  routineInputSchema,
  taskInputSchema,
  type Routine,
  type RoutineSchedule,
  type RoutineRunSnapshot,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { assertDelegationRoster } from "@/lib/agent/roster"
import type { ComparisonResult } from "@/lib/report-comparison"

export const routinePlanSchema = z
  .object({
    ...routineInputSchema.shape,
    agentId: z.string().min(1).max(100),
    squadId: z.null().optional(),
    timeZone: taskInputSchema.shape.timeZone.unwrap(),
    missedRunPolicy: z.enum(["latest", "skip"]).default("latest"),
    dateRange: z.enum(["none", "previous_week"]).default("none"),
    completionContract: taskInputSchema.shape.completionContract,
    budget: taskInputSchema.shape.budget,
    delegateAgentIds: taskInputSchema.shape.delegateAgentIds.default([]),
  })
  .refine(
    (plan) =>
      !plan.completionContract.comparison ||
      (plan.dateRange === "previous_week" &&
        !!plan.completionContract.artifact?.dateColumn &&
        !!plan.completionContract.comparison.baseline.dateColumn),
    {
      message:
        "Periodic comparison requires previous_week and date columns in both CSV contracts",
      path: ["completionContract", "comparison"],
    }
  )
export type RoutinePlan = z.infer<typeof routinePlanSchema>

// PostgreSQL owns wall-time conversion: DST gaps move forward, folds use the later
// standard-time instant. Search adjacent dates, never depend on process TZ.
export async function calendarWindow(schedule: RoutineSchedule, zone: string, at: Date) {
  if (schedule.kind === "hourly")
    throw new Error("Hourly recurrence requires its persisted interval anchor")
  if (schedule.kind === "once") {
    const {
      rows: [row],
    } = await pool.query<{ instant: Date }>(
      "SELECT $1::timestamp AT TIME ZONE $2 AS instant",
      [schedule.at, zone]
    )
    return {
      previous: row.instant <= at ? row.instant : null,
      next: row.instant > at ? row.instant : null,
    }
  }
  const {
    rows: [row],
  } = await pool.query<{ previous: Date; next: Date }>(
    `
    WITH dates AS (
      SELECT ($1::timestamptz AT TIME ZONE $2)::date + n AS day
      FROM generate_series(-8,8) AS n
    ), instants AS (
      SELECT (day + $3::time) AT TIME ZONE $2 AS instant FROM dates
      WHERE $4='daily' OR ($4='weekdays' AND extract(isodow FROM day)<6)
        OR ($4='weekly' AND extract(dow FROM day)=$5)
    ) SELECT max(instant) FILTER(WHERE instant <= $1) AS previous,
      min(instant) FILTER(WHERE instant > $1) AS next FROM instants`,
    [
      at,
      zone,
      schedule.time,
      schedule.kind,
      schedule.kind === "weekly" ? schedule.day : null,
    ]
  )
  return row
}

export async function initialRun(
  plan: Pick<Routine, "schedule" | "timeZone">,
  now: Date
) {
  return plan.schedule.kind === "hourly"
    ? new Date(Math.floor(now.getTime() / 60000) * 60000 + plan.schedule.every * 3600000)
    : (await calendarWindow(plan.schedule, plan.timeZone, now)).next
}

export async function freezeRoutine(
  routine: Routine,
  ownerId: string,
  due: Date,
  key: string
): Promise<RoutineRunSnapshot> {
  let range: RoutineRunSnapshot["range"] = null
  if (routine.dateRange === "previous_week") {
    const {
      rows: [row],
    } = await pool.query<NonNullable<RoutineRunSnapshot["range"]>>(
      `
      WITH bounds AS (SELECT date_trunc('week',$1::timestamptz AT TIME ZONE $2) AS finish)
      SELECT to_char(finish-interval '7 days','YYYY-MM-DD') AS "from",
        to_char(finish-interval '1 day','YYYY-MM-DD') AS "to",
        to_char((finish-interval '7 days') AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startsAt",
        to_char(finish AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endsAt" FROM bounds`,
      [due, routine.timeZone]
    )
    range = row
  }
  const contract = structuredClone(routine.completionContract)
  if (range && contract.artifact?.dateColumn) {
    contract.artifact.dateFrom = range.from
    contract.artifact.dateTo = range.to
  }
  if (range && contract.comparison) {
    const {
      rows: [previous],
    } = await pool.query<{ from: string; to: string }>(
      "SELECT to_char($1::date-7,'YYYY-MM-DD') AS \"from\",to_char($2::date-7,'YYYY-MM-DD') AS \"to\"",
      [range.from, range.to]
    )
    contract.comparison.baseline.dateFrom = previous.from
    contract.comparison.baseline.dateTo = previous.to
  }
  const input = taskInputSchema.parse({
    agentId: routine.agentId,
    ...(routine.delegateAgentIds.length
      ? { delegateAgentIds: routine.delegateAgentIds }
      : {}),
    timeZone: routine.timeZone,
    clientRequestId: key,
    goal: `${routine.prompt}\n\n[例程 ${routine.id} / 计划 v${routine.planVersion}]\n预定时刻：${due.toISOString()}；时区：${routine.timeZone}。${range ? `\n本次上一完整自然周固定为 ${range.from} 至 ${range.to}（含首尾日期）；时间区间 [${range.startsAt}, ${range.endsAt})。恢复和重试继续使用此范围。` : ""}`,
    completionContract: contract,
    budget: routine.budget,
  })
  return { ownerId, input, timeZone: routine.timeZone, range }
}

export async function saveRoutine(
  raw: z.input<typeof routinePlanSchema>,
  id?: string,
  expectedVersion?: number
) {
  const input = routinePlanSchema.parse(raw)
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId))
  if (!agent || agent.model === "fixture/durable-report")
    throw new HttpError(400, "Choose a real single-agent runtime for this routine")
  await assertDelegationRoster(input.delegateAgentIds)
  const zone = await pool.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [
    input.timeZone,
  ])
  if (!zone.rowCount)
    throw new HttpError(400, "The database does not support this time zone")
  return db.transaction(async (tx) => {
    if (id) {
      const [old] = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, id), isNull(routines.deletedAt)))
        .for("update")
      if (!old) throw new HttpError(404, "Routine not found")
      if (old.planVersion !== expectedVersion)
        throw new HttpError(409, "The plan changed; refresh before editing")
    }
    const nextRunAt = input.enabled ? await initialRun(input, new Date()) : null
    if (input.enabled && !nextRunAt)
      throw new HttpError(400, "An enabled one-time plan must be in the future")
    const values = {
      ...input,
      squadId: null,
      nextRunAt,
      planVersion: id ? expectedVersion! + 1 : 1,
    }
    const [saved] = id
      ? await tx.update(routines).set(values).where(eq(routines.id, id)).returning()
      : await tx.insert(routines).values(values).returning()
    return saved
  })
}

export async function setRoutineEnabled(id: string, version: number, enabled: boolean) {
  const [routine] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), isNull(routines.deletedAt)))
  if (!routine) throw new HttpError(404, "Routine not found")
  return saveRoutine(
    { ...routine, agentId: routine.agentId!, squadId: undefined, enabled },
    id,
    version
  )
}

export async function deleteRoutine(id: string, version: number) {
  const changed = await db
    .update(routines)
    .set({
      enabled: false,
      nextRunAt: null,
      deletedAt: new Date(),
      planVersion: version + 1,
    })
    .where(
      and(
        eq(routines.id, id),
        eq(routines.planVersion, version),
        isNull(routines.deletedAt)
      )
    )
    .returning({ id: routines.id })
  if (!changed.length)
    throw new HttpError(409, "The plan changed or was removed; refresh before editing")
}

export async function runRoutineNow(
  ownerId: string,
  id: string,
  requestId: string,
  expectedVersion: number
) {
  const key = `routine:${id}:manual:${requestId}`
  return db.transaction(async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .for("update")
    if (!routine) throw new HttpError(404, "Routine not found")
    const [previous] = await tx
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.requestKey, key))
    if (previous) return previous.id
    if (routine.deletedAt) throw new HttpError(404, "Routine was removed")
    if (routine.planVersion !== expectedVersion)
      throw new HttpError(409, "The plan changed; refresh before running it")
    const due = new Date()
    const snapshot = await freezeRoutine(routine, ownerId, due, key)
    const [run] = await tx
      .insert(routineRuns)
      .values({
        routineId: id,
        id: randomUUID(),
        trigger: "manual",
        status: "queued",
        requestKey: key,
        planVersion: routine.planVersion,
        snapshot,
        startedAt: due,
      })
      .returning()
    return run.id
  })
}

// Called only by the DBOS dispatcher. Runs and the recurrence cursor commit
// together; task submission can then replay its original frozen source key.
export async function stageDueRoutines(now = new Date()) {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(owners)
    const due = await tx
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.enabled, true),
          isNull(routines.deletedAt),
          lte(routines.nextRunAt, now)
        )
      )
      .orderBy(routines.nextRunAt)
      .limit(50)
      .for("update")
    for (const routine of due) {
      const first = routine.nextRunAt!
      let latest: Date, next: Date | null
      if (routine.schedule.kind === "hourly") {
        const every = routine.schedule.every * 3600000
        latest = new Date(
          first.getTime() + Math.floor((now.getTime() - first.getTime()) / every) * every
        )
        next = new Date(latest.getTime() + every)
      } else {
        const window = await calendarWindow(routine.schedule, routine.timeZone, now)
        latest = window.previous!
        next = window.next
      }
      const skipLatest =
        routine.missedRunPolicy === "skip" && now.getTime() - latest.getTime() > 60000
      if (first < latest || skipLatest) {
        const key = `routine:${routine.id}:v${routine.planVersion}:skipped:${first.toISOString()}`
        const snapshot = await freezeRoutine(routine, owner.userId, first, key)
        snapshot.coalesced = { from: first.toISOString(), before: latest.toISOString() }
        await tx
          .insert(routineRuns)
          .values({
            id: randomUUID(),
            routineId: routine.id,
            trigger: "schedule",
            status: "skipped",
            requestKey: key,
            planVersion: routine.planVersion,
            snapshot,
            dueAt: first,
            startedAt: now,
            finishedAt: now,
            detail: `停机或调度延迟：${first.toISOString()} 起至 ${latest.toISOString()}${skipLatest ? "（包含末次），按跳过策略登记。" : "（不含末次）的旧触发合并登记；只补末次。"}`,
          })
          .onConflictDoNothing({ target: routineRuns.requestKey })
      }
      if (!skipLatest) {
        const key = `routine:${routine.id}:v${routine.planVersion}:${latest.toISOString()}`
        await tx
          .insert(routineRuns)
          .values({
            id: randomUUID(),
            routineId: routine.id,
            trigger: "schedule",
            status: "queued",
            requestKey: key,
            planVersion: routine.planVersion,
            snapshot: await freezeRoutine(routine, owner.userId, latest, key),
            dueAt: latest,
            startedAt: now,
          })
          .onConflictDoNothing({ target: routineRuns.requestKey })
      }
      await tx
        .update(routines)
        .set({
          nextRunAt: next,
          enabled: next !== null,
          lastRunAt: now,
          lastStatus: skipLatest ? "skipped" : "running",
          lastError: null,
        })
        .where(eq(routines.id, routine.id))
    }
    return due.length
  })
}

export async function routineOverview(ownerId: string) {
  const [owner] = await db.select().from(owners).where(eq(owners.userId, ownerId))
  const plans = await db
    .select({ routine: routines, agentName: agents.name })
    .from(routines)
    .leftJoin(agents, eq(agents.id, routines.agentId))
    .where(isNull(routines.deletedAt))
    .orderBy(desc(routines.createdAt))
  const history = await pool.query<{
    id: string
    routine_id: string
    plan_version: number | null
    trigger: string
    status: string
    detail: string | null
    due_at: Date | null
    started_at: Date
    task_id: string | null
    task_status: string | null
    name: string
    time_zone: string | null
    range: RoutineRunSnapshot["range"]
    comparison: ComparisonResult | null
  }>(`SELECT rr.id,rr.routine_id,rr.plan_version,rr.trigger,rr.status,
    rr.detail,rr.due_at,rr.started_at,rr.task_id, t.status AS task_status,r.name,
    rr.snapshot->>'timeZone' AS time_zone,rr.snapshot->'range' AS range,t.result->'comparison' AS comparison
    FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id
    LEFT JOIN tasks t ON t.id=rr.task_id ORDER BY rr.started_at DESC,rr.id DESC LIMIT 50`)
  return {
    ownerTimeZone: owner.timeZone,
    agents: await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(sql`${agents.model} IS DISTINCT FROM 'fixture/durable-report'`),
    routines: plans.map(({ routine, agentName }) => ({
      ...routine,
      agentName,
      createdAt: routine.createdAt.toISOString(),
      nextRunAt: routine.nextRunAt?.toISOString() ?? null,
      lastRunAt: routine.lastRunAt?.toISOString() ?? null,
      deletedAt: null,
    })),
    runs: history.rows.map((run) => ({
      ...run,
      due_at: run.due_at?.toISOString() ?? null,
      started_at: run.started_at.toISOString(),
    })),
  }
}
