import { eq } from "drizzle-orm"
import { db } from "@/db"
import { agents, agentInputSchema } from "@/db/schema"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse, HttpError } from "@/lib/errors"
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const input = agentInputSchema.parse(await request.json())
    const [agent] = await db
      .update(agents)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(agents.id, (await context.params).id))
      .returning()
    if (!agent) throw new HttpError(404, "Agent not found")
    return Response.json(agent)
  } catch (error) {
    return errorResponse(error)
  }
}
