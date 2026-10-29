import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listThreads } from "@/lib/threads"
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await listThreads(owner.userId), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
