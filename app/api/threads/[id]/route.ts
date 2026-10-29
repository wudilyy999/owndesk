import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { getThread, renameThread } from "@/lib/threads"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try {
    const owner = await requireOwner(request.headers)
    const before = new URL(request.url).searchParams.get("before")
    const result = await getThread(
      owner.userId,
      (await context.params).id,
      before === null
        ? undefined
        : z.coerce.number().int().min(1).max(2_147_483_647).parse(before)
    )
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const input = z
      .object({ title: z.string().trim().min(1).max(80) })
      .parse(await request.json())
    return Response.json(
      await renameThread(owner.userId, (await context.params).id, input.title)
    )
  } catch (error) {
    return errorResponse(error)
  }
}
