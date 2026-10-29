import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { getWorkflowVersion } from "@/lib/workflows"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await getWorkflowVersion(owner.userId, (await params).id))
  } catch (error) {
    return errorResponse(error)
  }
}
