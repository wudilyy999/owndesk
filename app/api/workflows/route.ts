import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listWorkflowVersions } from "@/lib/workflows"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await listWorkflowVersions(owner.userId))
  } catch (error) {
    return errorResponse(error)
  }
}
