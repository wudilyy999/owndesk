import { readFile } from "node:fs/promises"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { db } from "@/db"
import { lifeActivities } from "@/db/schema"
import { artifactDir } from "@/lib/env"
import { HttpError, errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"

// A page screenshot she kept; only the owner can read it
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { agent } = await companionContext(request)
    const [row] = await db
      .select({ imagePath: lifeActivities.imagePath })
      .from(lifeActivities)
      .where(
        and(
          eq(lifeActivities.id, (await context.params).id),
          eq(lifeActivities.agentId, agent.id)
        )
      )
    if (!row?.imagePath) throw new HttpError(404, "No image for this activity")
    const file = path.resolve(artifactDir, row.imagePath)
    if (!file.startsWith(`${artifactDir}${path.sep}`))
      throw new HttpError(404, "No image for this activity")
    return new Response(await readFile(file), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
