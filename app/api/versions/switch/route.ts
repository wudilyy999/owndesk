import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { workerRequest } from "@/lib/worker-request"

// One-click switch to a kept version; the worker starts the updater from its own image.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { versionId } = z
      .object({ versionId: z.string().min(1).max(64) })
      .parse(await request.json())
    return Response.json(
      await workerRequest(request, "/internal/versions/switch", { versionId }),
      { status: 202 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
