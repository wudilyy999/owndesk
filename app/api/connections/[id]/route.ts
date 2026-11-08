import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import {
  setConnectionEnabled,
  disconnectConnection,
  discoverConnection,
  authorizeConnection,
} from "@/lib/connections"
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), enabled: z.boolean() }),
  z.object({ action: z.enum(["discover", "authorize", "disconnect", "delete"]) }),
])
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers),
      id = (await context.params).id,
      input = command.parse(await request.json())
    if (input.action === "discover")
      return Response.json(await discoverConnection(owner.userId, id))
    if (input.action === "authorize")
      return Response.json(await authorizeConnection(owner.userId, id))
    if (input.action === "enable")
      await setConnectionEnabled(owner.userId, id, input.enabled)
    else await disconnectConnection(owner.userId, id, input.action === "delete")
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
