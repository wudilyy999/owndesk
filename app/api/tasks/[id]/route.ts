import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { getTask } from "@/lib/tasks"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await getTask(owner.userId, (await context.params).id))
  } catch (error) {
    return errorResponse(error)
  }
}
