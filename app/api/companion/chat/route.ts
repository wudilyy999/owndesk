import { z } from "zod"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { companionChat } from "@/lib/companion/chat"

const bodySchema = z.object({
  text: z.string().trim().min(1).max(4000),
})

// Server-sent events: user (saved message), delta (streamed text), messages (final bubbles), error
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { ownerId, agent } = await companionContext(request)
    const { text } = bodySchema.parse(await request.json())
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        try {
          await companionChat({ ownerId, agentId: agent.id, text }, {}, (event) =>
            send(event.type, event)
          )
        } catch (error) {
          console.error("Companion chat failed", error)
          send("error", {
            error: error instanceof Error ? error.message : "Request failed",
          })
        }
        controller.close()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
