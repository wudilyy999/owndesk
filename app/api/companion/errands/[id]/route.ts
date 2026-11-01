import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { cancelErrand, confirmErrand } from "@/lib/companion/errands"

const bodySchema = z.object({ action: z.enum(["confirm", "cancel"]) })

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const { action } = bodySchema.parse(await request.json())
    const { id } = await context.params
    if (action === "cancel") {
      await cancelErrand(owner.userId, id)
      return Response.json({ status: "cancelled" })
    }
    return Response.json(await confirmErrand(owner.userId, id), { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
