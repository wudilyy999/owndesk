import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import {
  cancelObjectiveProposal,
  confirmObjectiveProposal,
} from "@/lib/companion/objectives"

const bodySchema = z.object({ action: z.enum(["confirm", "cancel"]) })

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const { action } = bodySchema.parse(await request.json())
    const { id } = await context.params
    if (action === "cancel") {
      await cancelObjectiveProposal(owner.userId, id)
      return Response.json({ status: "cancelled" })
    }
    const objective = await confirmObjectiveProposal(owner.userId, id)
    return Response.json({ objectiveId: objective.id }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
