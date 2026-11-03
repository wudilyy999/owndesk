import { memoryInputSchema } from "@/db/schema"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { addNote, listNotes, suggestMerge } from "@/lib/companion/memory"

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
    const note = await addNote(agent.id, input.content, "user")
    // The note is saved as written; a similar older one only produces a card to confirm
    const similar = await suggestMerge(agent.id, note)
    return Response.json(
      { ...note, suggestionId: similar?.suggestion.id ?? null },
      { status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
