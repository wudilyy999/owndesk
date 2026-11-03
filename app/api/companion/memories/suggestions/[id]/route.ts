import { z } from "zod"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { resolveSuggestion } from "@/lib/companion/memory"

const bodySchema = z.object({
  action: z.enum(["merge", "keep", "drop"]),
  // The person may reword the merged note before confirming
  mergedText: z.string().trim().min(1).max(2000).optional(),
})

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const body = bodySchema.parse(await request.json())
    return Response.json(
      await resolveSuggestion(
        agent.id,
        (await context.params).id,
        body.action,
        body.mergedText
      )
    )
  } catch (error) {
    return errorResponse(error)
  }
}
