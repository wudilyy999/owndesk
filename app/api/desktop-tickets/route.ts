import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { issueDesktopTicket } from "@/lib/desktop"
import { errorResponse } from "@/lib/errors"

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .object({
        agentId: z.string().min(1),
        mode: z.enum(["watch", "control"]),
        limitSeconds: z.number().int().min(5).max(300).optional(),
      })
      .parse(await request.json())
    return Response.json(
      await issueDesktopTicket(
        owner,
        input.agentId,
        input.mode,
        request.headers.get("origin"),
        input.limitSeconds
      ),
      {
        headers: { "Cache-Control": "private, no-store" },
      }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
