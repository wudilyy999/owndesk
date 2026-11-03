import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { listSuggestions, scanSimilar } from "@/lib/companion/memory"

// Pairs of notes that say nearly the same thing, waiting for the person's answer
export async function GET(request: Request) {
  try {
    const { agent } = await companionContext(request)
    return Response.json(await listSuggestions(agent.id), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

// Looks through the notes for new pairs (only makes suggestions, never changes a note)
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const created = await scanSimilar(agent.id)
    return Response.json({ created, suggestions: await listSuggestions(agent.id) })
  } catch (error) {
    return errorResponse(error)
  }
}
