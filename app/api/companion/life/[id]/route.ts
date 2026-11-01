import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { lifeActivities } from "@/db/schema"
import { requireSameOrigin } from "@/lib/auth"
import { HttpError, errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const { starred } = z.object({ starred: z.boolean() }).parse(await request.json())
    const [row] = await db
      .update(lifeActivities)
      .set({ starred })
      .where(
        and(
          eq(lifeActivities.id, (await context.params).id),
          eq(lifeActivities.agentId, agent.id)
        )
      )
      .returning({ id: lifeActivities.id, starred: lifeActivities.starred })
    if (!row) throw new HttpError(404, "Activity not found")
    return Response.json(row)
  } catch (error) {
    return errorResponse(error)
  }
}
