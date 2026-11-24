import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { listVersions } from "@/lib/versions"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await listVersions(owner.userId))
  } catch (error) {
    return errorResponse(error)
  }
}
