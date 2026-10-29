import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listTasks, submitTask } from "@/lib/tasks"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await listTasks(owner.userId))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const result = await submitTask(owner.userId, "web", await request.json())
    return Response.json(result, { status: result.reused ? 200 : 202 })
  } catch (error) {
    return errorResponse(error)
  }
}
