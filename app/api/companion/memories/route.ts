import { memoryInputSchema } from "@/db/schema"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { addNote, listNotes } from "@/lib/companion/memory"

export async function GET(request: Request) {
  try {
    const { agent } = await companionContext(request)
    return Response.json(await listNotes(agent.id), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const input = memoryInputSchema.parse(await request.json())
    return Response.json(await addNote(agent.id, input.content, "user"), { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
