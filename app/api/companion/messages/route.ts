import { desc, eq } from "drizzle-orm"
import { db } from "@/db"
import { companionMessages } from "@/db/schema"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"

export async function GET(request: Request) {
  try {
    const { agent } = await companionContext(request)
    const rows = await db
      .select()
      .from(companionMessages)
      .where(eq(companionMessages.agentId, agent.id))
      .orderBy(desc(companionMessages.createdAt), desc(companionMessages.id))
      .limit(100)
    return Response.json(rows.reverse(), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
