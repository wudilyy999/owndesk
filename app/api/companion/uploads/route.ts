import { requireSameOrigin } from "@/lib/auth"
import { HttpError, errorResponse } from "@/lib/errors"
import { companionContext } from "@/lib/companion/api"
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES, saveImage } from "@/lib/companion/images"

// A picture to send her: multipart form with one `file`. It is checked, shrunk and stored
// privately; the returned id goes into the next chat message.
export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const { agent } = await companionContext(request)
    // Refuse early by the declared size; the real size is checked again on the bytes
    const declared = Number(request.headers.get("content-length") ?? 0)
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024)
      throw new HttpError(413, `图片太大了，最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
    const form = await request.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) throw new HttpError(400, "没有收到图片")
    if (file.type && !ACCEPTED_TYPES.includes(file.type))
      throw new HttpError(415, "只支持 JPEG、PNG、WebP、GIF 图片")
    const row = await saveImage(agent.id, Buffer.from(await file.arrayBuffer()), "web")
    return Response.json(
      { id: row.id, width: row.width, height: row.height, bytes: row.bytes },
      { status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
