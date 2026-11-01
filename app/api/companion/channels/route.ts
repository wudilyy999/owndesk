import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { channelAction, channelActionSchema, channelStatus } from "@/lib/channels/manage"

export async function GET(request: Request) {
  try {
    const { ownerId, agent } = await companionContext(request)
    return Response.json(await channelStatus(ownerId, agent.id), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { ownerId, agent } = await companionContext(request)
    const input = channelActionSchema.parse(await request.json())
    return Response.json(await channelAction(ownerId, agent.id, input), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
