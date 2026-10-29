import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { getTask, listTaskEvents } from "@/lib/tasks"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    const { id } = await context.params
    await getTask(owner.userId, id)
    let after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(
        request.headers.get("Last-Event-ID") ??
          new URL(request.url).searchParams.get("after") ??
          0
      )
    const cancelled = new AbortController()
    const signal = AbortSignal.any([request.signal, cancelled.signal])
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let heartbeat = Date.now()
        try {
          controller.enqueue(encoder.encode("retry: 1500\n\n"))
          while (!signal.aborted) {
            const events = await listTaskEvents(id, after)
            for (const event of events) {
              controller.enqueue(
                encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
              )
              after = event.seq
            }
            if (Date.now() - heartbeat > 10000) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"))
              heartbeat = Date.now()
            }
            await delay(750, undefined, { signal })
          }
          controller.close()
        } catch (error) {
          if (!signal.aborted) {
            console.error("Task event stream failed", error)
            controller.error(error)
          }
        }
      },
      cancel() {
        cancelled.abort()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
