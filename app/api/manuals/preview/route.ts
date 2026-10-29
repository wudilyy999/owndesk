import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { manualCompilationInputSchema } from "@/lib/manual-schema"
import { freezeManualCompilation } from "@/lib/manuals"

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = manualCompilationInputSchema.parse(await request.json())
    return Response.json(await freezeManualCompilation(owner.userId, input), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
