import { isDeepStrictEqual } from "node:util"
import { and, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { routineCommands, routines, companions } from "@/db/schema"
import {
  saveRoutine,
  setRoutineEnabled,
  deleteRoutine,
  routinePlanSchema,
} from "@/lib/routines"
import { HttpError } from "@/lib/errors"
const id = z.string().min(1).max(100),
  version = z.number().int().positive()
const fields = z.object({
  name: routinePlanSchema.shape.name,
  prompt: routinePlanSchema.shape.prompt,
  schedule: routinePlanSchema.shape.schedule,
  enabled: routinePlanSchema.shape.enabled,
  eventTrigger: routinePlanSchema.shape.eventTrigger,
  timeZone: routinePlanSchema.shape.timeZone.optional(),
})
export const chatRoutineSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("create"), plan: fields }),
  z.object({ action: z.literal("update"), id, version, plan: fields }),
  z.object({ action: z.enum(["pause", "resume", "delete"]), id, version }),
])
export async function manageChatRoutine(
  ownerId: string,
  agentId: string,
  key: string,
  raw: unknown
) {
  const input = chatRoutineSchema.parse(raw)
  const [companion] = await db
    .select()
    .from(companions)
    .where(and(eq(companions.agentId, agentId), eq(companions.ownerId, ownerId)))
  if (!companion) throw new HttpError(404, "Companion not found")
  if (input.action === "list")
    return {
      routines: await db
        .select({
          id: routines.id,
          name: routines.name,
          prompt: routines.prompt,
          schedule: routines.schedule,
          eventTrigger: routines.eventTrigger,
          enabled: routines.enabled,
          version: routines.planVersion,
          timeZone: routines.timeZone,
          lastStatus: routines.lastStatus,
          lastError: routines.lastError,
        })
        .from(routines)
        .where(and(eq(routines.agentId, agentId), isNull(routines.deletedAt))),
    }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`)
    const [previous] = await tx
      .select()
      .from(routineCommands)
      .where(eq(routineCommands.key, key))
    if (previous) {
      if (
        previous.ownerId !== ownerId ||
        previous.agentId !== agentId ||
        !isDeepStrictEqual(previous.input, input)
      )
        throw new HttpError(409, "Command key already used")
      return previous.result
    }
    let result
    if (input.action === "create") {
      const saved = await saveRoutine(
        {
          ...input.plan,
          agentId,
          timeZone: input.plan.timeZone ?? companion.timeZone,
          completionContract: { requireHumanReview: false },
          budget: { maxSteps: 40 },
        },
        undefined,
        undefined,
        tx
      )
      result = {
        id: saved.id,
        name: saved.name,
        version: saved.planVersion,
        enabled: saved.enabled,
      }
    } else {
      const [old] = await tx
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.id, input.id),
            eq(routines.agentId, agentId),
            isNull(routines.deletedAt)
          )
        )
        .for("update")
      if (!old) throw new HttpError(404, "Routine does not belong to this agent")
      if (old.planVersion !== input.version)
        throw new HttpError(409, "Routine changed; list it again")
      if (input.action === "delete") {
        await deleteRoutine(input.id, input.version, tx)
        result = { id: input.id, deleted: true }
      } else {
        const saved =
          input.action === "update"
            ? await saveRoutine(
                {
                  ...old,
                  ...input.plan,
                  agentId,
                  squadId: undefined,
                  timeZone: input.plan.timeZone ?? old.timeZone,
                },
                input.id,
                input.version,
                tx
              )
            : await setRoutineEnabled(
                input.id,
                input.version,
                input.action === "resume",
                tx
              )
        result = {
          id: saved.id,
          name: saved.name,
          version: saved.planVersion,
          enabled: saved.enabled,
        }
      }
    }
    await tx.insert(routineCommands).values({ key, ownerId, agentId, input, result })
    return result
  })
}
