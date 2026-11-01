import { memoryInputSchema } from "@/db/schema"
import { requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { deleteNote, updateNote } from "@/lib/companion/memory"

type Context = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, context: Context) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const input = memoryInputSchema.parse(await request.json())
    return Response.json(
      await updateNote(agent.id, (await context.params).id, input.content)
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    return Response.json(await deleteNote(agent.id, (await context.params).id))
  } catch (error) {
    return errorResponse(error)
  }
}
