import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { changeTelegram, telegramStatus } from "@/lib/telegram/state"
import { taskInputSchema } from "@/db/schema"

const mutation = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("token"),
    token: z
      .string()
      .trim()
      .regex(/^\d+:[A-Za-z0-9_-]{20,}$/)
      .max(256)
      .nullable(),
  }),
  z.object({ action: z.enum(["rotate", "unpair"]) }),
  z.object({ action: z.literal("agent"), agentId: z.string().min(1).max(100) }),
  z.object({
    action: z.literal("roster"),
    generation: z.uuid(),
    agentId: z.string().min(1).max(100),
    delegateAgentIds: taskInputSchema.shape.delegateAgentIds.unwrap(),
  }),
  z.object({
    action: z.literal("retry"),
    id: z.uuid(),
    acknowledgeDuplicate: z.literal(true),
  }),
])
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(await telegramStatus(owner.userId), {
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
    return Response.json(await changeTelegram(owner.userId, input), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
