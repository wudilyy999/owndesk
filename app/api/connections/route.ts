import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listConnections, saveConnection } from "@/lib/connections"
export async function GET(request: Request) {
  try {
    return Response.json(
      await listConnections((await requireOwner(request.headers)).userId)
    )
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    return Response.json(await saveConnection(owner.userId, await request.json()), {
      status: 201,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
