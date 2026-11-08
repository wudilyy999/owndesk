import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { HttpError, errorResponse } from "@/lib/errors"
import { MAX_FILE_BYTES, saveUpload } from "@/lib/uploads"

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    const agentId = new URL(request.url).searchParams.get("agentId")
    if (!agentId) throw new HttpError(400, "请选择 Agent")
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 65536)
      throw new HttpError(413, "文件最大 20 MB")
    if (!request.body) throw new HttpError(400, "没有收到文件")
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_FILE_BYTES + 65536) {
        await reader.cancel()
        throw new HttpError(413, "文件最大 20 MB")
      }
      chunks.push(value)
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData()
    const file = form.get("file")
    if (!(file instanceof File)) throw new HttpError(400, "没有收到文件")
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "文件最大 20 MB")
    return Response.json(
      await saveUpload(
        owner.userId,
        agentId,
        file.name,
        Buffer.from(await file.arrayBuffer())
      ),
      { status: 201 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
