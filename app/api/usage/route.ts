import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { monthlyBudgetSchema } from "@/db/schema"
import { setSetting } from "@/lib/config"
import {
  usageOverview,
  usageIdSchema,
  priceMutationSchema,
  reconciliationSchema,
  setCustomPrice,
  reconcileUsage,
} from "@/lib/spend"

const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("budget"), value: monthlyBudgetSchema }),
  priceMutationSchema.extend({ action: z.literal("price") }),
  reconciliationSchema.extend({ action: z.literal("reconcile") }),
])
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    const before = usageIdSchema
      .optional()
      .parse(new URL(request.url).searchParams.get("before") ?? undefined)
    return Response.json(await usageOverview(owner.userId, before), {
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
    const input = mutation.parse(await request.json())
    if (input.action === "budget")
      await setSetting("usage.monthlyBudget", input.value || null)
    else if (input.action === "price") await setCustomPrice(input.model, input.rate)
    else await reconcileUsage(owner.userId, input)
    return Response.json(await usageOverview(owner.userId), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
