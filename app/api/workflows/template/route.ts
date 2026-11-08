import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { workerRequest } from "@/lib/worker-request"
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    return Response.json(
      await workerRequest(request, "/internal/workflows/template", await request.json())
    )
  } catch (error) {
    return errorResponse(error)
  }
}
