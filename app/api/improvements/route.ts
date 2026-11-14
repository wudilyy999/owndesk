import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { improvementOverview } from "@/lib/evolution/improvements"
import { setEvolutionEnabled } from "@/lib/evolution/store"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await improvementOverview(owner.userId))
  } catch (error) {
    return errorResponse(error)
  }
}

// Settings → 自我改进: the feature is off until the owner turns it on
export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json())
    await setEvolutionEnabled(enabled)
    return Response.json({ enabled })
  } catch (error) {
    return errorResponse(error)
  }
}
