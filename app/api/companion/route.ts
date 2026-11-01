import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { companionSettingsSchema } from "@/lib/companion/persona"
import { updateCompanion } from "@/lib/companion/store"

export async function GET(request: Request) {
  try {
    const { agent, companion } = await companionContext(request)
    return Response.json(
      { name: agent.name, ...companion },
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    const { ownerId, agent } = await companionContext(request)
    const input = companionSettingsSchema.parse(await request.json())
    return Response.json(await updateCompanion(ownerId, agent.id, input))
  } catch (error) {
    return errorResponse(error)
  }
}
