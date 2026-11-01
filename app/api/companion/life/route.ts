import { desc, eq } from "drizzle-orm"
import { db } from "@/db"
import { lifeActivities, lifeShares } from "@/db/schema"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { lifeSpentToday } from "@/lib/companion/life"
import { peekState } from "@/lib/companion/peek"
import { rhythmAt } from "@/lib/companion/rules"

export async function GET(request: Request) {
  try {
    const { agent, companion } = await companionContext(request)
    const [activities, shares, today] = await Promise.all([
      db
        .select()
        .from(lifeActivities)
        .where(eq(lifeActivities.agentId, agent.id))
        .orderBy(desc(lifeActivities.createdAt))
        .limit(200),
      db
        .select()
        .from(lifeShares)
        .where(eq(lifeShares.agentId, agent.id))
        .orderBy(desc(lifeShares.createdAt))
        .limit(50),
      lifeSpentToday(agent.id, companion.timeZone, new Date()),
    ])
    const now = new Date()
    return Response.json(
      {
        // The image file stays on the server; the page asks for it by activity id
        activities: activities.map(({ imagePath, ...activity }) => ({
          ...activity,
          hasImage: imagePath !== null,
        })),
        shares,
        spentTodayMicros: today.spent,
        unknownCostRequests: today.unknown,
        dailyBudgetMicros: companion.lifeDailyBudgetMicros,
        rhythm: rhythmAt(now, companion.timeZone, companion.rhythm),
        peek: await peekState(companion, now),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
