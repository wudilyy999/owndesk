import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { undoChange } from "@/lib/companion/memory"

// One-click undo: the notes go back to how they were before this change
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    return Response.json(await undoChange(agent.id, (await context.params).id))
  } catch (error) {
    return errorResponse(error)
  }
}
