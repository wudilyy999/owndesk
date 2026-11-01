// An errand is a task the companion proposed in chat. Nothing starts until the person
// confirms the card in the UI; typing "ok" in chat does not count.
import { and, eq, sql } from "drizzle-orm"
import { db, pool } from "@/db"
import { companionMessages, companions } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { submitTask } from "@/lib/tasks"

async function ownedProposal(ownerId: string, messageId: string) {
  const [row] = await db
    .select({ message: companionMessages, timeZone: companions.timeZone })
    .from(companionMessages)
    .innerJoin(companions, eq(companions.agentId, companionMessages.agentId))
    .where(
      and(
        eq(companionMessages.id, messageId),
        eq(companionMessages.kind, "errand_proposal"),
        eq(companions.ownerId, ownerId)
      )
    )
  if (!row) throw new HttpError(404, "Errand proposal not found")
  return row
}

// Status moves pending → confirmed / cancelled exactly once
async function claim(messageId: string, status: "confirmed" | "cancelled") {
  const rows = await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.id, messageId),
        sql`${companionMessages.metadata}->>'status' = 'pending'`
      )
    )
    .returning({ id: companionMessages.id })
  if (!rows.length) throw new HttpError(409, "This proposal was already answered")
}

export async function confirmErrand(ownerId: string, messageId: string) {
  const { message, timeZone } = await ownedProposal(ownerId, messageId)
  await claim(messageId, "confirmed")
  const goal = (message.metadata as { goal: string }).goal
  try {
    const task = await submitTask(ownerId, "companion", {
      agentId: message.agentId,
      goal,
      clientRequestId: `errand:${messageId}`,
      timeZone,
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 40 },
    })
    await db
      .update(companionMessages)
      .set({
        metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ taskId: task.taskId })}::jsonb`,
      })
      .where(eq(companionMessages.id, messageId))
    return task
  } catch (error) {
    // The task never started, so the card can be answered again
    await db
      .update(companionMessages)
      .set({
        metadata: sql`${companionMessages.metadata} || '{"status":"pending"}'::jsonb`,
      })
      .where(eq(companionMessages.id, messageId))
    throw error
  }
}

export async function cancelErrand(ownerId: string, messageId: string) {
  await ownedProposal(ownerId, messageId)
  await claim(messageId, "cancelled")
}

// Worker tick: when a confirmed errand's task ends, say so in the chat
export async function syncErrands() {
  const { rows } = await pool.query<{
    id: string
    agent_id: string
    status: string
    summary: string | null
    error: string | null
    task_id: string
  }>(
    `SELECT m.id,m.agent_id,t.status,t.result->>'summary' AS summary,t.error,t.id AS task_id
     FROM companion_messages m JOIN tasks t ON t.id=m.metadata->>'taskId'
     WHERE m.kind='errand_proposal' AND m.metadata->>'status'='confirmed'
     AND t.status IN ('completed','failed','cancelled')`
  )
  for (const row of rows) {
    const text =
      row.status === "completed"
        ? `办完了。\n${row.summary ?? ""}`.trim()
        : row.status === "cancelled"
          ? "这件事被停掉了，没有做完。"
          : `这件事没办成：${row.error ?? "出错了"}`
    await db.transaction(async (tx) => {
      await tx
        .update(companionMessages)
        .set({
          metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "done" })}::jsonb`,
        })
        .where(eq(companionMessages.id, row.id))
      await tx.insert(companionMessages).values({
        agentId: row.agent_id,
        role: "assistant",
        kind: "errand_update",
        content: text,
        metadata: { taskId: row.task_id, proposalId: row.id, outcome: row.status },
        channel: "web",
      })
    })
  }
  return rows.length
}
