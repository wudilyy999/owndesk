import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { cancelImprovementProposal } from "@/lib/evolution/improvements"
import { workerRequest } from "@/lib/worker-request"

const bodySchema = z.union([
  z.object({
    action: z.literal("confirm"),
    checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(12).optional(),
  }),
  z.object({ action: z.literal("cancel") }),
])

// The improvement proposal card: confirming starts the lab (in the worker, which holds the
// version repository); the owner may edit the checklist first.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const body = bodySchema.parse(await request.json())
    const { id } = await context.params
    if (body.action === "cancel") {
      await cancelImprovementProposal(owner.userId, id)
      return Response.json({ status: "cancelled" })
    }
    return Response.json(
      await workerRequest(request, "/internal/improvements", {
        action: "confirm",
        messageId: id,
        checklist: body.checklist,
      }),
      { status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
