import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { requestTakeover } from "@/lib/task-control"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .object({
        requestId: z.uuid(),
        reason: z.string().min(1).max(2000).default("Owner requested desktop control"),
      })
      .parse(await request.json())
    return Response.json(
      await requestTakeover(
        (await context.params).id,
        input.reason,
        input.requestId,
        owner.userId
      ),
      { status: 202 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
