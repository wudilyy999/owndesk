import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { requestCancellation } from "@/lib/task-control"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    return Response.json(
      await requestCancellation(owner.userId, (await context.params).id),
      { status: 202 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
