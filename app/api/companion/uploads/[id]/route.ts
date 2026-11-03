import { requireSameOrigin } from "@/lib/auth"
import { HttpError, errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { deleteImageFile, getImage, readImage } from "@/lib/companion/images"

// A picture the person sent; only the owner can read it
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { agent } = await companionContext(request)
    const row = await getImage(agent.id, (await context.params).id)
    const data = row ? await readImage(row) : null
    if (!data) throw new HttpError(404, "这张图片已经过期或被删除了")
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

// Deletes the file now; her one-line description of it stays in the conversation
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    const row = await getImage(agent.id, (await context.params).id)
    if (!row) throw new HttpError(404, "找不到这张图片")
    await deleteImageFile(row)
    return Response.json({ deleted: true })
  } catch (error) {
    return errorResponse(error)
  }
}
