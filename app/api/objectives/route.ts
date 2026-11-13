import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { createObjective, listObjectives, objectiveAgents } from "@/lib/objectives"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json({
      objectives: await listObjectives(owner.userId),
      agents: await objectiveAgents(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const objective = await createObjective(owner.userId, await request.json())
    return Response.json({ objectiveId: objective.id }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
