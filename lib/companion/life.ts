// A companion's own daily life: scheduled browsing sessions that log what was done, plus a
// share queue that decides what actually reaches the person (daily limit, quiet hours, pause).
import { and, desc, eq } from "drizzle-orm"
import { db, pool } from "@/db"
import {
  agents,
  companionMessages,
  companions,
  lifeActivities,
  lifeShares,
  type Companion,
} from "@/db/schema"
import { findPrice } from "@/lib/providers/pricing"
import { resolveModelSpec } from "@/lib/providers/registry"
import { getCustomPrices } from "@/lib/spend"
import { submitTask } from "@/lib/tasks"
import { listNotes, selectNotes } from "./memory"
import { decideShare, dueLifeSlots, lifeBudgetForSession, rhythmAt } from "./rules"

export async function lifeSpentToday(agentId: string, timeZone: string, now: Date) {
  const { rows } = await pool.query<{ spent: string; unknown: number }>(
    `SELECT COALESCE(sum(COALESCE(a.cost_micros,a.reconciled_cost_micros)),0)::text AS spent,
     count(*) FILTER(WHERE a.status<>'pending' AND a.cost_micros IS NULL AND a.reconciled_cost_micros IS NULL)::int AS unknown
     FROM task_model_attempts a JOIN tasks t ON t.id=a.task_id
     WHERE t.agent_id=$1 AND t.config_snapshot ? 'lifeSession' AND NOT (t.config_snapshot->'lifeSession' ? 'coview')
     AND (a.started_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`,
    [agentId, timeZone, now]
  )
  return { spent: Number(rows[0].spent), unknown: rows[0].unknown }
}

// Prompt ideas: SillyTavern-style character fields drive what she is curious about; recent
// log titles stop repeats; notes about the person shape what she might want to tell them.
export async function lifePrompt(companion: Companion, name: string, now: Date) {
  const recent = await db
    .select()
    .from(lifeActivities)
    .where(eq(lifeActivities.agentId, companion.agentId))
    .orderBy(desc(lifeActivities.createdAt))
    .limit(12)
  const notes = selectNotes(await listNotes(companion.agentId)).slice(0, 15)
  return `你是${name}。${companion.persona.background}
性格：${companion.persona.personality}；兴趣：${companion.persona.interests}。
现在是你自己的时间（${now.toISOString()}），没人在等你回复。像平时一样用自己的电脑：随便逛逛感兴趣的网站，读一两篇文章或看看新闻，也可以把想法写几句日记，存到 /home/agent/Life/diary/ 下（文件名用日期）。
每做完一件事，用 life_log 记下真实的标题、一两句你自己的感受和真实网址。如果有哪件事你真想告诉对方，用 life_share 写一句像发微信一样的话（带上真实链接）。没有就不分享，不要硬凑。

最近做过的事（别重复）：
${recent.map((a) => `- ${a.title}`).join("\n") || "（还没有）"}
你记得的关于对方的事（可以让分享更贴心，但不要在日记或分享里写出隐私细节）：
${notes.map((n) => `- ${n.content}`).join("\n") || "（还没有）"}`
}

// Starts at most one session per companion per slot (the request key makes retries harmless).
export async function startLifeSessions(now = new Date()) {
  const started: string[] = []
  const skipped: { agentId: string; reason: string }[] = []
  const rows = await db
    .select({ companion: companions, name: agents.name, model: agents.model })
    .from(companions)
    .innerJoin(agents, eq(agents.id, companions.agentId))
    .where(eq(companions.lifeEnabled, true))
  for (const { companion, name, model } of rows) {
    const due = dueLifeSlots(now, companion.timeZone, companion.lifeTimes)
    if (!due.length) continue
    const rhythm = rhythmAt(now, companion.timeZone, companion.rhythm)
    if (rhythm.state !== "online") {
      skipped.push({ agentId: companion.agentId, reason: `rhythm: ${rhythm.state}` })
      continue
    }
    const busy = await pool.query(
      "SELECT 1 FROM tasks WHERE agent_id=$1 AND status NOT IN ('completed','failed','cancelled') LIMIT 1",
      [companion.agentId]
    )
    if (busy.rowCount) {
      skipped.push({ agentId: companion.agentId, reason: "agent busy" })
      continue
    }
    const spec = await resolveModelSpec(model)
    // A model without a price cannot be capped, so it does not get life sessions
    if (!spec || !findPrice(spec, { custom: await getCustomPrices() })) {
      skipped.push({ agentId: companion.agentId, reason: "model has no price" })
      continue
    }
    const { spent, unknown } = await lifeSpentToday(
      companion.agentId,
      companion.timeZone,
      now
    )
    const budget = unknown
      ? null
      : lifeBudgetForSession({
          sessionMaxSteps: companion.lifeSessionMaxSteps,
          dailyBudgetMicros: companion.lifeDailyBudgetMicros,
          spentTodayMicros: spent,
        })
    if (!budget) {
      skipped.push({ agentId: companion.agentId, reason: "daily life budget used" })
      continue
    }
    const { date, slot } = due[due.length - 1]
    const result = await submitTask(companion.ownerId, "life", {
      agentId: companion.agentId,
      goal: "开始你自己的时间。",
      clientRequestId: `life:${companion.agentId}:${date}:${slot}`,
      timeZone: companion.timeZone,
      completionContract: { requireHumanReview: false },
      budget,
      lifeSession: { prompt: await lifePrompt(companion, name, now) },
    })
    if (!result.reused) started.push(result.taskId)
  }
  return { started, skipped }
}

export async function deliverShares(now = new Date()) {
  const delivered: string[] = []
  const rows = await db.select().from(companions)
  for (const companion of rows) {
    const [pending] = await db
      .select()
      .from(lifeShares)
      .where(
        and(eq(lifeShares.agentId, companion.agentId), eq(lifeShares.status, "pending"))
      )
      .orderBy(lifeShares.createdAt)
      .limit(1)
    if (!pending) continue
    const {
      rows: [stats],
    } = await pool.query<{ sent: number; last: Date | null }>(
      `SELECT count(*) FILTER(WHERE (sent_at AT TIME ZONE $2)::date=($3::timestamptz AT TIME ZONE $2)::date)::int AS sent,max(sent_at) AS last
       FROM life_shares WHERE agent_id=$1 AND status='sent'`,
      [companion.agentId, companion.timeZone, now]
    )
    const decision = decideShare({
      now,
      companion,
      createdAt: pending.createdAt,
      sentToday: stats.sent,
      lastSentAt: stats.last,
    })
    if (!decision.send) {
      if (decision.skip)
        await db
          .update(lifeShares)
          .set({ status: "skipped", skipReason: decision.skip })
          .where(eq(lifeShares.id, pending.id))
      continue
    }
    const [activity] = await db
      .select()
      .from(lifeActivities)
      .where(eq(lifeActivities.id, pending.activityId))
    await db.transaction(async (tx) => {
      await tx
        .update(lifeShares)
        .set({ status: "sent", sentAt: now })
        .where(eq(lifeShares.id, pending.id))
      await tx.insert(companionMessages).values({
        agentId: companion.agentId,
        role: "assistant",
        kind: "share",
        content: activity.url ? `${pending.text}\n${activity.url}` : pending.text,
        metadata: {
          shareId: pending.id,
          activityId: activity.id,
          title: activity.title,
          hasImage: activity.imagePath !== null,
        },
        channel: "web",
      })
    })
    delivered.push(pending.id)
  }
  return delivered
}
