import { z } from "zod"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { reviewCandidate } from "@/lib/companion/memory"

const input = z.object({ action: z.enum(["accept", "dismiss"]) })

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const { action } = input.parse(await request.json())
    return Response.json(
      await reviewCandidate(agent.id, (await context.params).id, action)
    )
  } catch (error) {
    return errorResponse(error)
  }
}
