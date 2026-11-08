import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { appendTaskSupplement } from "@/lib/task-supplements"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    return Response.json(
      await appendTaskSupplement(
        owner.userId,
        (await context.params).id,
        await request.json()
      ),
      { status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
