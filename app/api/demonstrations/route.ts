import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import {
  listDemonstrations,
  startDemonstration,
  recordDemonstration,
  finishDemonstration,
  cancelDemonstration,
  saveDemonstrationManual,
} from "@/lib/demonstrations"
import { demonstrationEventSchema } from "@/lib/demonstration-schema"
import { manualDraftSchema } from "@/lib/manual-schema"
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), agentId: z.string().min(1), name: z.string() }),
  z.object({
    action: z.literal("record"),
    id: z.uuid(),
    seq: z.number(),
    event: demonstrationEventSchema,
  }),
  z.object({ action: z.literal("finish"), id: z.uuid() }),
  z.object({ action: z.literal("cancel"), id: z.uuid() }),
  z.object({
    action: z.literal("save"),
    id: z.uuid(),
    reviewed: z.literal(true),
    draft: manualDraftSchema,
  }),
])
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(request.headers)
    return Response.json(
      await listDemonstrations(
        owner.userId,
        new URL(request.url).searchParams.get("agentId") ?? undefined
      )
    )
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers),
      input = schema.parse(await request.json())
    let result
    if (input.action === "start")
      result = await startDemonstration(owner.userId, input.agentId, input.name)
    else if (input.action === "record")
      result = await recordDemonstration(owner.userId, input.id, input)
    else if (input.action === "cancel")
      result = await cancelDemonstration(owner.userId, input.id)
    else if (input.action === "finish")
      result = await finishDemonstration(owner.userId, input.id)
    else result = await saveDemonstrationManual(owner.userId, input.id, input.draft)
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
