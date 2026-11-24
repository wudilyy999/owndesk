import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { trialCommand } from "@/lib/evolution/trial-input"
import { workerRequest } from "@/lib/worker-request"

const bodySchema = z.union([
  z.object({ action: z.literal("trial"), command: trialCommand }),
  z.object({
    action: z.literal("adopt"),
    versionId: z.string().min(1).max(100).optional(),
  }),
  z.object({ action: z.literal("revise"), note: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("abandon") }),
  z.object({
    action: z.literal("fork"),
    roundNo: z.number().int().positive(),
    note: z.string().trim().min(1).max(4000),
    requestId: z.string().uuid(),
  }),
])

// The report card's buttons: 采用 (worker starts the updater), 再改改, 放弃
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const body = bodySchema.parse(await request.json())
    const { id } = await context.params
    if (body.action === "trial")
      return Response.json(
        await workerRequest(
          request,
          "/internal/improvement-trial",
          {
            objectiveId: id,
            command: body.command,
          },
          body.command.action === "close" ? 600000 : 30000
        ),
        { headers: { "Cache-Control": "no-store" } }
      )
    return Response.json(
      await workerRequest(
        request,
        "/internal/improvements",
        {
          ...body,
          objectiveId: id,
        },
        600000
      ),
      { status: body.action === "adopt" ? 202 : 200 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
