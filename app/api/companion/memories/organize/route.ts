import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { organizeNow } from "@/lib/companion/consolidate"

export const maxDuration = 300

// "整理一下": she tidies her notes into topic summaries now. Every change can be undone.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    return Response.json(await organizeNow(agent.id))
  } catch (error) {
    return errorResponse(error)
  }
}
