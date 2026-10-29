import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { agents, memories, memoryInputSchema } from "@/db/schema"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse, HttpError } from "@/lib/errors"

type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try {
    await requireOwner(request.headers)
    const { id } = await context.params
    return Response.json(
      await db
        .select()
        .from(memories)
        .where(eq(memories.agentId, id))
        .orderBy(desc(memories.createdAt), desc(memories.id)),
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(request: Request, context: Context) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { id } = await context.params
    const input = memoryInputSchema.parse(await request.json())
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, id))
    if (!agent) throw new HttpError(404, "Agent not found")
    const [note] = await db
      .insert(memories)
      .values({ agentId: id, content: input.content })
      .returning()
    return Response.json(note, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const { id } = await context.params
    const input = z.object({ id: z.string().min(1).max(200) }).parse(await request.json())
    const [removed] = await db
      .delete(memories)
      .where(and(eq(memories.agentId, id), eq(memories.id, input.id)))
      .returning({ id: memories.id })
    if (!removed) throw new HttpError(404, "Note not found for this agent")
    return Response.json(removed)
  } catch (error) {
    return errorResponse(error)
  }
}
