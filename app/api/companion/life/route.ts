import { desc, eq } from "drizzle-orm"
import { db } from "@/db"
import { lifeActivities, lifeShares } from "@/db/schema"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { lifeSpentToday } from "@/lib/companion/life"

export async function GET(request: Request) {
  try {
    const { agent, companion } = await companionContext(request)
    const [activities, shares, today] = await Promise.all([
      db
        .select()
        .from(lifeActivities)
        .where(eq(lifeActivities.agentId, agent.id))
        .orderBy(desc(lifeActivities.createdAt))
        .limit(100),
      db
        .select()
        .from(lifeShares)
        .where(eq(lifeShares.agentId, agent.id))
        .orderBy(desc(lifeShares.createdAt))
        .limit(50),
      lifeSpentToday(agent.id, companion.timeZone, new Date()),
    ])
    return Response.json(
      {
        activities,
        shares,
        spentTodayMicros: today.spent,
        unknownCostRequests: today.unknown,
        dailyBudgetMicros: companion.lifeDailyBudgetMicros,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
