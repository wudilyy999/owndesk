// A long-running objective she proposed in chat. Like an errand, nothing starts until the
// person confirms the card; confirming twice creates one objective.
import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { companionMessages, companions, objectives } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { createObjective } from "@/lib/objectives"

export type ObjectiveProposal = {
  title: string
  objective: string
  doneCriteria: string
  completionContract: { requireHumanReview: boolean }
  budget: {
    roundMaxSteps: number
    maxCostMicros?: number
    maxRounds?: number
    deadlineAt?: string
  }
}

async function ownedProposal(ownerId: string, messageId: string) {
  const [row] = await db
    .select({ message: companionMessages })
    .from(companionMessages)
    .innerJoin(companions, eq(companions.agentId, companionMessages.agentId))
    .where(
      and(
        eq(companionMessages.id, messageId),
        eq(companionMessages.kind, "objective_proposal"),
        eq(companions.ownerId, ownerId)
      )
    )
  if (!row) throw new HttpError(404, "Objective proposal not found")
  return row.message
}

export async function confirmObjectiveProposal(ownerId: string, messageId: string) {
  const message = await ownedProposal(ownerId, messageId)
  const meta = message.metadata as { proposal: ObjectiveProposal; status: string }
  if (meta.status === "confirmed") {
    const [existing] = await db
      .select()
      .from(objectives)
      .where(eq(objectives.proposalId, messageId))
    if (existing) return existing
  }
  if (meta.status !== "pending" || message.supersededAt)
    throw new HttpError(409, "This proposal was already answered")
  const objective = await createObjective(
    ownerId,
    { ...meta.proposal, agentId: message.agentId },
    messageId
  )
  await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "confirmed", objectiveId: objective.id })}::jsonb`,
    })
    .where(eq(companionMessages.id, messageId))
  return objective
}

export async function cancelObjectiveProposal(ownerId: string, messageId: string) {
  await ownedProposal(ownerId, messageId)
  const rows = await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "cancelled" })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.id, messageId),
        sql`${companionMessages.metadata}->>'status' = 'pending' AND ${companionMessages.supersededAt} IS NULL`
      )
    )
    .returning({ id: companionMessages.id })
  if (!rows.length) throw new HttpError(409, "This proposal was already answered")
}
