// A long-running objective: the agent works on it round after round, each round an ordinary
// task, until it reports the objective achieved, the owner pauses or stops it, or a limit the
// owner set is reached. There are no default limits; the monthly budget still applies to
// every model request. Rounds are started by the routine dispatcher (worker/routines.ts).
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { ZodError } from "zod"
import { db, pool } from "@/db"
import {
  agents,
  companionMessages,
  objectiveBudgetSchema,
  objectiveInputSchema,
  objectiveRounds,
  objectives,
  type Objective,
  type ObjectiveBudget,
  type ObjectiveInput,
  type ObjectiveRoundInput,
  type ObjectiveVerdict,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { requestCancellation } from "@/lib/task-control"
import { submitTask } from "@/lib/tasks"

export const OBJECTIVE_SOURCE = "objective"
// Rounds in a row that failed or were cancelled outside the owner's stop before it pauses
export const OBJECTIVE_MAX_FAILURES = 3
const TASK_COST_CAP = 100_000_000
const HISTORY_ROUNDS = 8
const ROUND_SUMMARY_CHARS = 500

export type ObjectiveUsage = {
  rounds: number
  steps: number
  costMicros: number
  unknownCost: number
}

export async function objectiveUsage(objectiveId: string): Promise<ObjectiveUsage> {
  const {
    rows: [row],
  } = await pool.query<{ rounds: number; steps: number; cost: string; unknown: number }>(
    `SELECT (SELECT count(*)::int FROM objective_rounds WHERE objective_id=$1) AS rounds,
      (SELECT count(*)::int FROM task_model_decisions d JOIN tasks t ON t.id=d.task_id
        WHERE t.objective_id=$1 AND d.status='succeeded') AS steps,
      COALESCE(sum(COALESCE(a.cost_micros,a.reconciled_cost_micros)),0)::text AS cost,
      count(a.*) FILTER(WHERE a.cost_micros IS NULL AND a.reconciled_cost_micros IS NULL)::int AS unknown
     FROM tasks t LEFT JOIN task_model_attempts a ON a.task_id=t.id WHERE t.objective_id=$1`,
    [objectiveId]
  )
  return {
    rounds: row?.rounds ?? 0,
    steps: row?.steps ?? 0,
    costMicros: Number(row?.cost ?? 0),
    unknownCost: row?.unknown ?? 0,
  }
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`

// Why no further round may start, or null when the owner's limits allow one
export function limitReason(
  budget: ObjectiveBudget,
  usage: ObjectiveUsage,
  now = new Date()
) {
  if (budget.deadlineAt && now >= new Date(budget.deadlineAt)) return "已到截止时间"
  if (budget.maxRounds !== undefined && usage.rounds >= budget.maxRounds)
    return `已做满 ${budget.maxRounds} 轮`
  if (budget.maxSteps !== undefined && usage.steps >= budget.maxSteps)
    return `已用完 ${budget.maxSteps} 步`
  if (budget.maxCostMicros !== undefined) {
    if (usage.unknownCost > 0)
      return "有模型调用的价格未知，设了花费上限就没法继续计算；去掉花费上限后可以继续"
    if (usage.costMicros >= budget.maxCostMicros)
      return `花费已到上限 ${usd(budget.maxCostMicros)}`
  }
  return null
}

export function roundBudget(budget: ObjectiveBudget, usage: ObjectiveUsage) {
  const maxSteps = Math.max(
    1,
    Math.min(
      budget.roundMaxSteps,
      budget.maxSteps === undefined ? Infinity : budget.maxSteps - usage.steps
    )
  )
  return budget.maxCostMicros === undefined
    ? { maxSteps }
    : {
        maxSteps,
        maxCostMicros: Math.max(
          1,
          Math.min(TASK_COST_CAP, budget.maxCostMicros - usage.costMicros)
        ),
      }
}

type RoundNote = { roundNo: number; verdict: string | null; summary: string | null }

const verdictText: Record<string, string> = {
  progress: "progress",
  achieved: "claimed achieved",
  steps: "ran out of steps",
  cost: "ran out of cost allowance",
  failed: "failed",
  cancelled: "cancelled",
}

export function roundGoal(
  objective: Pick<
    Objective,
    "title" | "objective" | "doneCriteria" | "completionContract"
  >,
  roundNo: number,
  roundSteps: number,
  previous: RoundNote[]
) {
  const contract = objective.completionContract
  const check = [
    contract.artifact &&
      `deliver the CSV ${contract.artifact.path}${contract.artifact.requiredColumns?.length ? ` with columns ${contract.artifact.requiredColumns.join(", ")}` : ""}${contract.artifact.minRows ? ` and at least ${contract.artifact.minRows} data rows` : ""}`,
    contract.directoryTree && `the directory ${contract.directoryTree.root} is checked`,
    contract.requireHumanReview && "the owner confirms the result",
  ].filter(Boolean)
  const history = previous
    .slice(-HISTORY_ROUNDS)
    .reverse()
    .map(
      (round) =>
        `- Round ${round.roundNo} (${verdictText[round.verdict ?? ""] ?? "unfinished"}): ${(round.summary ?? "").replace(/\s+/g, " ").slice(0, ROUND_SUMMARY_CHARS) || "no summary"}`
    )
  return [
    `Long-running objective "${objective.title}", round ${roundNo}.`,
    `Objective:\n${objective.objective}`,
    `Done when:\n${objective.doneCriteria || "(the owner gave no separate criteria; judge from the objective)"}`,
    check.length ? `When you report it achieved: ${check.join("; ")}.` : "",
    history.length
      ? `Earlier rounds (latest first):\n${history.join("\n")}`
      : "This is the first round.",
    'Files you made in earlier rounds are still in your workstation. Make concrete progress in this round, then call complete_task with objective.status="progress" and a summary of what you did and what remains, or with objective.status="achieved" only when the whole objective is verifiably done, delivering the evidence files.',
    `This round allows at most ${roundSteps} steps; if they run out, the round ends and the next round continues from your notes.`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

async function assertAgent(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))
  if (!agent) throw new HttpError(404, "Agent not found")
  if (agent.model === "fixture/durable-report")
    throw new HttpError(400, "这个 Agent 不能执行长期目标")
}

export async function createObjective(
  ownerId: string,
  raw: unknown,
  proposalId?: string
): Promise<Objective> {
  const input: ObjectiveInput = objectiveInputSchema.parse(raw)
  await assertAgent(input.agentId)
  const [created] = await db
    .insert(objectives)
    .values({
      ownerId,
      agentId: input.agentId,
      title: input.title,
      objective: input.objective,
      doneCriteria: input.doneCriteria,
      completionContract: input.completionContract,
      budget: input.budget,
      proposalId,
    })
    .onConflictDoNothing({ target: objectives.proposalId })
    .returning()
  if (created) return created
  const [existing] = await db
    .select()
    .from(objectives)
    .where(and(eq(objectives.proposalId, proposalId!), eq(objectives.ownerId, ownerId)))
  if (!existing) throw new HttpError(409, "This proposal was already answered")
  return existing
}

async function ownedObjective(ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(objectives)
    .where(and(eq(objectives.id, id), eq(objectives.ownerId, ownerId)))
  if (!row) throw new HttpError(404, "Objective not found")
  return row
}

export async function listObjectives(ownerId: string, agentId?: string) {
  const rows = await db
    .select()
    .from(objectives)
    .where(
      agentId
        ? and(eq(objectives.ownerId, ownerId), eq(objectives.agentId, agentId))
        : eq(objectives.ownerId, ownerId)
    )
    .orderBy(desc(objectives.createdAt))
    .limit(100)
  const ids = rows.map((row) => row.id)
  const rounds = ids.length
    ? await pool.query<{
        objective_id: string
        round_no: number
        verdict: ObjectiveVerdict | null
        summary: string | null
        task_id: string | null
        task_status: string | null
        started_at: Date
        finished_at: Date | null
      }>(
        `SELECT r.objective_id,r.round_no,r.verdict,r.summary,r.task_id,t.status AS task_status,
          r.started_at,r.finished_at FROM objective_rounds r LEFT JOIN tasks t ON t.id=r.task_id
         WHERE r.objective_id=ANY($1) ORDER BY r.round_no DESC`,
        [ids]
      )
    : { rows: [] }
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      usage: await objectiveUsage(row.id),
      rounds: rounds.rows
        .filter((round) => round.objective_id === row.id)
        .slice(0, 20)
        .map((round) => ({
          roundNo: round.round_no,
          verdict: round.verdict,
          summary: round.summary,
          taskId: round.task_id,
          taskStatus: round.task_status,
          startedAt: round.started_at,
          finishedAt: round.finished_at,
        })),
    }))
  )
}
export type ObjectiveOverview = Awaited<ReturnType<typeof listObjectives>>

export async function objectiveAgents() {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .orderBy(agents.createdAt)
}

export async function controlObjective(
  ownerId: string,
  id: string,
  action: "pause" | "resume" | "stop"
) {
  const objective = await ownedObjective(ownerId, id)
  if (objective.status === "achieved" || objective.status === "stopped")
    throw new HttpError(409, "这个目标已经结束了")
  if (action === "pause") {
    await db
      .update(objectives)
      .set({ status: "paused", statusReason: "你暂停了它", updatedAt: new Date() })
      .where(eq(objectives.id, id))
    return
  }
  if (action === "resume") {
    if (objective.status === "active") return
    const reason = limitReason(objective.budget, await objectiveUsage(id))
    if (reason) throw new HttpError(409, `${reason}，先提高上限再继续`)
    await db
      .update(objectives)
      .set({ status: "active", statusReason: null, failures: 0, updatedAt: new Date() })
      .where(eq(objectives.id, id))
    return
  }
  await db
    .update(objectives)
    .set({
      status: "stopped",
      statusReason: "你停止了它",
      updatedAt: new Date(),
      finishedAt: new Date(),
    })
    .where(eq(objectives.id, id))
  const open = await pool.query<{ task_id: string }>(
    "SELECT task_id FROM objective_rounds WHERE objective_id=$1 AND verdict IS NULL AND task_id IS NOT NULL",
    [id]
  )
  for (const row of open.rows) {
    try {
      await requestCancellation(ownerId, row.task_id)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
    }
  }
}

export async function updateObjectiveBudget(ownerId: string, id: string, raw: unknown) {
  const objective = await ownedObjective(ownerId, id)
  if (objective.status === "achieved" || objective.status === "stopped")
    throw new HttpError(409, "这个目标已经结束了")
  const budget = objectiveBudgetSchema.parse(raw)
  await db
    .update(objectives)
    .set({ budget, updatedAt: new Date() })
    .where(eq(objectives.id, id))
}

async function hasCompanion(agentId: string) {
  const { rowCount } = await pool.query("SELECT 1 FROM companions WHERE agent_id=$1", [
    agentId,
  ])
  return !!rowCount
}

async function tell(agentId: string, objectiveId: string, content: string, extra = {}) {
  if (!(await hasCompanion(agentId))) return
  await db.insert(companionMessages).values({
    agentId,
    role: "assistant",
    kind: "objective_update",
    content,
    metadata: { objectiveId, ...extra },
    channel: "web",
  })
}

// Record how each finished round ended and move its objective along
async function closeFinishedRounds() {
  const { rows } = await pool.query<{
    id: string
    objective_id: string
    round_no: number
    task_id: string
    status: string
    result: {
      summary?: string
      objective?: { status?: string; end?: "steps" | "cost" }
    } | null
    error: string | null
  }>(
    `SELECT r.id,r.objective_id,r.round_no,r.task_id,t.status,t.result,t.error
     FROM objective_rounds r JOIN tasks t ON t.id=r.task_id
     WHERE r.verdict IS NULL AND t.status IN ('completed','failed','cancelled')
     ORDER BY r.started_at`
  )
  for (const row of rows) {
    const verdict: ObjectiveVerdict =
      row.status === "failed"
        ? "failed"
        : row.status === "cancelled"
          ? "cancelled"
          : row.result?.objective?.status === "achieved"
            ? "achieved"
            : (row.result?.objective?.end ?? "progress")
    const summary =
      row.status === "completed"
        ? (row.result?.summary ?? "")
        : row.status === "failed"
          ? `出错了：${row.error ?? "未知错误"}`
          : "这一轮被停掉了"
    const {
      rows: [usage],
    } = await pool.query<{ steps: number; cost: string; unknown: number }>(
      `SELECT (SELECT count(*)::int FROM task_model_decisions WHERE task_id=$1 AND status='succeeded') AS steps,
        COALESCE(sum(COALESCE(cost_micros,reconciled_cost_micros)),0)::text AS cost,
        count(*) FILTER(WHERE cost_micros IS NULL AND reconciled_cost_micros IS NULL)::int AS unknown
       FROM task_model_attempts WHERE task_id=$1`,
      [row.task_id]
    )
    const message = await db.transaction(async (tx) => {
      const closed = await tx
        .update(objectiveRounds)
        .set({
          verdict,
          summary: summary.slice(0, 16000),
          steps: usage.steps,
          costMicros: Number(usage.cost),
          unknownCost: usage.unknown > 0,
          finishedAt: new Date(),
        })
        .where(and(eq(objectiveRounds.id, row.id), isNull(objectiveRounds.verdict)))
        .returning({ id: objectiveRounds.id })
      if (!closed.length) return null
      const [objective] = await tx
        .select()
        .from(objectives)
        .where(eq(objectives.id, row.objective_id))
        .for("update")
      if (!objective) return null
      const now = new Date()
      if (verdict === "achieved") {
        if (objective.status === "stopped") return null
        await tx
          .update(objectives)
          .set({
            status: "achieved",
            statusReason: null,
            failures: 0,
            updatedAt: now,
            finishedAt: now,
          })
          .where(eq(objectives.id, objective.id))
        return `「${objective.title}」完成了（第 ${row.round_no} 轮）。\n${summary}`.trim()
      }
      if (verdict === "failed" || verdict === "cancelled") {
        if (objective.status !== "active")
          return verdict === "cancelled"
            ? null
            : `「${objective.title}」第 ${row.round_no} 轮没做成：${summary}`
        const failures = objective.failures + 1
        const pause = failures >= OBJECTIVE_MAX_FAILURES
        await tx
          .update(objectives)
          .set({
            failures,
            ...(pause
              ? {
                  status: "paused" as const,
                  statusReason: `连续 ${failures} 轮没做成，先暂停了，看过原因后可以继续`,
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(objectives.id, objective.id))
        return pause
          ? `「${objective.title}」连续 ${failures} 轮没做成，我先停下来了。到长期目标页看一下原因再决定继续。`
          : `「${objective.title}」第 ${row.round_no} 轮没做成，下一轮再试：${summary}`
      }
      await tx
        .update(objectives)
        .set({
          failures: 0,
          ...(verdict === "cost" && objective.status === "active"
            ? {
                status: "budget_limited" as const,
                statusReason: "这一轮的花费额度用完了",
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(objectives.id, objective.id))
      return `「${objective.title}」第 ${row.round_no} 轮：${summary}`
    })
    if (message) {
      const [objective] = await db
        .select({ agentId: objectives.agentId })
        .from(objectives)
        .where(eq(objectives.id, row.objective_id))
      if (objective)
        await tell(objective.agentId, row.objective_id, message.slice(0, 4000), {
          roundNo: row.round_no,
          verdict,
          taskId: row.task_id,
        })
    }
  }
}

async function agentBusy(agentId: string) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM tasks WHERE agent_id=$1 AND status NOT IN ('completed','failed','cancelled')
     AND NOT config_snapshot ? 'lifeSession' LIMIT 1`,
    [agentId]
  )
  return !!rowCount
}

async function companionTimeZone(agentId: string) {
  const { rows } = await pool.query<{ time_zone: string }>(
    "SELECT time_zone FROM companions WHERE agent_id=$1",
    [agentId]
  )
  return rows[0]?.time_zone
}

// Freeze the next round of an active objective (or return the frozen one still unsubmitted)
async function nextRound(objective: Objective, now: Date) {
  const { rows: open } = await pool.query<{
    id: string
    input: ObjectiveRoundInput
    task_id: string | null
  }>(
    "SELECT id,input,task_id FROM objective_rounds WHERE objective_id=$1 AND verdict IS NULL ORDER BY round_no",
    [objective.id]
  )
  if (open.some((round) => round.task_id)) return null
  if (open[0]) return open[0]
  const usage = await objectiveUsage(objective.id)
  const reason = limitReason(objective.budget, usage, now)
  if (reason) {
    const changed = await db
      .update(objectives)
      .set({ status: "budget_limited", statusReason: reason, updatedAt: now })
      .where(and(eq(objectives.id, objective.id), eq(objectives.status, "active")))
      .returning({ id: objectives.id })
    if (changed.length)
      await tell(
        objective.agentId,
        objective.id,
        `「${objective.title}」停在上限：${reason}。到长期目标页调高上限后可以继续。`
      )
    return null
  }
  if (await agentBusy(objective.agentId)) return null
  const previous = await db
    .select({
      roundNo: objectiveRounds.roundNo,
      verdict: objectiveRounds.verdict,
      summary: objectiveRounds.summary,
    })
    .from(objectiveRounds)
    .where(eq(objectiveRounds.objectiveId, objective.id))
    .orderBy(objectiveRounds.roundNo)
  const roundNo = (previous.at(-1)?.roundNo ?? 0) + 1
  const budget = roundBudget(objective.budget, usage)
  const timeZone = await companionTimeZone(objective.agentId)
  const input: ObjectiveRoundInput = {
    agentId: objective.agentId,
    goal: roundGoal(objective, roundNo, budget.maxSteps, previous),
    clientRequestId: `objective:${objective.id}:${roundNo}`,
    objectiveRound: { objectiveId: objective.id, roundNo },
    completionContract: objective.completionContract,
    budget,
    ...(timeZone ? { timeZone } : {}),
  }
  const [inserted] = await db
    .insert(objectiveRounds)
    .values({ objectiveId: objective.id, roundNo, input })
    .onConflictDoNothing()
    .returning({ id: objectiveRounds.id, input: objectiveRounds.input })
  return inserted ? { ...inserted, task_id: null } : null
}

// Dispatcher tick: close finished rounds, then start the next round of each active objective
export async function advanceObjectives(now = new Date()) {
  const lock = await pool.connect()
  try {
    const {
      rows: [{ locked }],
    } = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('owndesk-objectives')) AS locked"
    )
    if (!locked) return 0
    try {
      await closeFinishedRounds()
      const active = await db
        .select()
        .from(objectives)
        .where(inArray(objectives.status, ["active"]))
      let started = 0
      for (const objective of active) {
        const round = await nextRound(objective, now)
        if (!round) continue
        try {
          const task = await submitTask(objective.ownerId, OBJECTIVE_SOURCE, round.input)
          await pool.query("UPDATE objective_rounds SET task_id=$2 WHERE id=$1", [
            round.id,
            task.taskId,
          ])
          started++
        } catch (error) {
          if (!(error instanceof HttpError) && !(error instanceof ZodError)) throw error
          const reasonText =
            error instanceof ZodError ? "任务参数无效" : (error as HttpError).message
          // The frozen round can never start (agent gone, model missing): record and count it
          await pool.query(
            "UPDATE objective_rounds SET verdict='failed',summary=$2,finished_at=now() WHERE id=$1",
            [round.id, `没能开始：${reasonText}`.slice(0, 4000)]
          )
          await pool.query(
            `UPDATE objectives SET failures=failures+1,updated_at=now(),
              status=CASE WHEN failures+1>=$2 THEN 'paused' ELSE status END,
              status_reason=CASE WHEN failures+1>=$2 THEN $3 ELSE status_reason END
             WHERE id=$1`,
            [
              objective.id,
              OBJECTIVE_MAX_FAILURES,
              `连续 ${OBJECTIVE_MAX_FAILURES} 轮没能开始：${reasonText}`.slice(0, 1000),
            ]
          )
        }
      }
      return started
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('owndesk-objectives'))")
    }
  } finally {
    lock.release()
  }
}

// What she can say about the owner's objectives in chat
export async function objectiveBrief(ownerId: string, agentId: string) {
  return (await listObjectives(ownerId, agentId)).slice(0, 20).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    statusReason: row.statusReason,
    rounds: row.usage.rounds,
    spentUsd: Number((row.usage.costMicros / 1_000_000).toFixed(4)),
    lastRound: row.rounds[0]
      ? {
          roundNo: row.rounds[0].roundNo,
          verdict: row.rounds[0].verdict,
          summary: (row.rounds[0].summary ?? "").slice(0, 300),
        }
      : null,
  }))
}
