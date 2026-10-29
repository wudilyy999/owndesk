import { requireOwner } from "@/lib/auth"
import { errorResponse, HttpError } from "@/lib/errors"
import { WorkflowValidationError } from "@/lib/workflow-schema"
import { exportWorkflowPackage } from "@/lib/workflow-packages"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    const pack = await exportWorkflowPackage(owner.userId, (await params).id)
    return Response.json(pack, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(
      error instanceof WorkflowValidationError ? new HttpError(409, error.message) : error
    )
  }
}
