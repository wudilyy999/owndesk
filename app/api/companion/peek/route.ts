import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { issueDesktopTicket } from "@/lib/desktop"
import { HttpError, errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { peekState } from "@/lib/companion/peek"

const noStore = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  try {
    const { companion } = await companionContext(request)
    return Response.json(await peekState(companion), { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}

// Opens a read-only desktop connection that the gateway closes after `seconds`
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const { agent, companion } = await companionContext(request)
    const { seconds } = z
      .object({ seconds: z.number().int().min(10).max(120).default(60) })
      .parse(await request.json())
    const state = await peekState(companion)
    if (!state.live) throw new HttpError(409, state.caption)
    return Response.json(
      {
        ...(await issueDesktopTicket(
          owner,
          agent.id,
          "watch",
          request.headers.get("origin"),
          seconds
        )),
        caption: state.caption,
      },
      { headers: noStore }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
