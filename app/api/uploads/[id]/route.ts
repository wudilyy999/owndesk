import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { readUpload } from "@/lib/uploads"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    const file = await readUpload(owner.userId, (await context.params).id)
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.mediaType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
