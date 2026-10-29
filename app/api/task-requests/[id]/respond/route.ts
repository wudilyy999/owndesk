import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { respondToRequest } from "@/lib/task-control"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .object({
        decision: z.string().min(1),
        payloadVersion: z.number().int().min(1),
        response: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await request.json())
    return Response.json(
      await respondToRequest(
        owner.userId,
        (await context.params).id,
        input.decision,
        input.payloadVersion,
        input.response
      ),
      { status: 202 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
