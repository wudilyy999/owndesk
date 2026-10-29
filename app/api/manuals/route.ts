import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { manualDraftSchema } from "@/lib/manual-schema"
import { listManuals, saveManual, setManualEnabled } from "@/lib/manuals"

export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await listManuals(owner.userId), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .strictObject({
        draftTaskId: z.uuid(),
        reviewed: z.literal(true),
        draft: manualDraftSchema,
      })
      .parse(await request.json())
    return Response.json(await saveManual(owner.userId, input.draftTaskId, input.draft))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .strictObject({ id: z.uuid(), enabled: z.boolean() })
      .parse(await request.json())
    return Response.json(await setManualEnabled(owner.userId, input.id, input.enabled))
  } catch (error) {
    return errorResponse(error)
  }
}
