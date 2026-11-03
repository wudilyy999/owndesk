import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { listChanges } from "@/lib/companion/memory"

// What changed her notes (hers and the person's), newest first
export async function GET(request: Request) {
  try {
    const { agent } = await companionContext(request)
    return Response.json(await listChanges(agent.id), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
