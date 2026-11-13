import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { controlObjective, updateObjectiveBudget } from "@/lib/objectives"

const bodySchema = z.union([
  z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict(),
  z.object({ budget: z.unknown() }).strict(),
])

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const body = bodySchema.parse(await request.json())
    const { id } = await context.params
    if ("action" in body) await controlObjective(owner.userId, id, body.action)
    else await updateObjectiveBudget(owner.userId, id, body.budget)
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
