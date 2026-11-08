import { rotateRoutineWebhook } from "@/lib/routine-events"
import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import {
  deleteRoutine,
  routineOverview,
  routinePlanSchema,
  runRoutineNow,
  saveRoutine,
  setRoutineEnabled,
} from "@/lib/routines"

const id = z.string().min(1).max(100),
  version = z.number().int().positive()
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("webhook"), id }),
  z.object({ action: z.literal("create"), input: routinePlanSchema }),
  z.object({ action: z.literal("save"), id, version, input: routinePlanSchema }),
  z.object({ action: z.literal("enabled"), id, version, enabled: z.boolean() }),
  z.object({ action: z.literal("delete"), id, version }),
  z.object({ action: z.literal("run"), id, version, requestId: z.uuid() }),
])
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await routineOverview(owner.userId), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = mutation.parse(await request.json())
    if (input.action === "webhook")
      return Response.json(await rotateRoutineWebhook(input.id))
    if (input.action === "create") await saveRoutine(input.input)
    else if (input.action === "save")
      await saveRoutine(input.input, input.id, input.version)
    else if (input.action === "enabled")
      await setRoutineEnabled(input.id, input.version, input.enabled)
    else if (input.action === "delete") await deleteRoutine(input.id, input.version)
    else await runRoutineNow(owner.userId, input.id, input.requestId, input.version)
    return Response.json(await routineOverview(owner.userId), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
