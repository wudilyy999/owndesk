import { acceptRoutineEvent } from "@/lib/routine-events"
import { HttpError, errorResponse } from "@/lib/errors"
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const header = request.headers.get("authorization") ?? ""
    if (!header.startsWith("Bearer "))
      throw new HttpError(401, "Webhook bearer token required")
    if (!request.body) throw new HttpError(400, "Event body missing")
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16000) {
        await reader.cancel()
        throw new HttpError(413, "Event body too large")
      }
      chunks.push(value)
    }
    const result = await acceptRoutineEvent(
      (await context.params).id,
      header.slice(7),
      JSON.parse(Buffer.concat(chunks).toString("utf8"))
    )
    return Response.json(result, { status: result.reused ? 200 : 202 })
  } catch (error) {
    return errorResponse(error)
  }
}
