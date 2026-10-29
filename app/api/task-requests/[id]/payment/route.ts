import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { paymentChoiceSchema } from "@/lib/payment-schema"
import { choosePayment } from "@/lib/payments"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    return Response.json(
      await choosePayment(
        owner.userId,
        (await context.params).id,
        paymentChoiceSchema.parse(await request.json())
      ),
      { status: 202, headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
