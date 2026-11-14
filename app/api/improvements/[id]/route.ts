import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { abandonImprovement, reviseImprovement } from "@/lib/evolution/improvements"
import { workerRequest } from "@/lib/worker-request"

const bodySchema = z.union([
  z.object({ action: z.literal("adopt") }),
  z.object({ action: z.literal("revise"), note: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("abandon") }),
])

// The report card's buttons: 采用 (worker starts the updater), 再改改, 放弃
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const body = bodySchema.parse(await request.json())
    const { id } = await context.params
    if (body.action === "adopt")
      return Response.json(
        await workerRequest(request, "/internal/improvements", {
          action: "adopt",
          objectiveId: id,
        }),
        { status: 202 }
      )
    if (body.action === "revise") await reviseImprovement(owner.userId, id, body.note)
    else await abandonImprovement(owner.userId, id)
    return Response.json({ status: body.action })
  } catch (error) {
    return errorResponse(error)
  }
}
