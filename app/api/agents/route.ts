import { db } from "@/db"
import { listAgents } from "@/lib/agents"
import { agents, agentInputSchema } from "@/db/schema"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
export async function GET(request: Request) {
  try {
    await requireOwner(request.headers)
    return Response.json(await listAgents())
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const input = agentInputSchema.parse(await request.json())
    const [agent] = await db.insert(agents).values(input).returning()
    return Response.json(agent, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
