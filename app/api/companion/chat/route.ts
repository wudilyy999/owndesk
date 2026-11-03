import { z } from "zod"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { companionChat } from "@/lib/companion/chat"

// A new message, or a redo of the latest turn: regenerate her answer, or edit your message
const bodySchema = z.union([
  z.object({
    text: z.string().trim().max(4000),
    imageId: z.uuid().optional(),
    redo: z.literal("edit").optional(),
  }),
  z.object({ redo: z.literal("regenerate") }),
])

// Server-sent events: user (saved message), typing (she is typing), delta (streamed text),
// messages (bubbles, one event per bubble while she "types"), superseded (hidden by a redo), error
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { ownerId, agent } = await companionContext(request)
    const body = bodySchema.parse(await request.json())
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        try {
          await companionChat(
            {
              ownerId,
              agentId: agent.id,
              text: "text" in body ? body.text : "",
              imageId: "imageId" in body ? body.imageId : undefined,
              redo: body.redo,
            },
            { playback: true },
            (event) => send(event.type, event)
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
