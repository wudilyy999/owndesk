import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse, HttpError } from "@/lib/errors"
import { WorkflowValidationError } from "@/lib/workflow-schema"
import { workflowPackageMaxBytes } from "@/lib/workflow-package"
import { importWorkflowPackage } from "@/lib/workflow-packages"

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    const owner = await requireOwner(request.headers)
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      throw new HttpError(415, "Supply a JSON workflow package")
    if (!request.body) throw new HttpError(400, "Supply a JSON workflow package")
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > workflowPackageMaxBytes) {
        await reader.cancel()
        throw new HttpError(413, "Workflow import exceeds 128 KiB")
      }
      chunks.push(part.value)
    }
    let input: unknown
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new HttpError(400, "Invalid JSON workflow package")
      throw error
    }
    const result = await importWorkflowPackage(owner.userId, input)
    return Response.json(result, { status: result.reused ? 200 : 201 })
  } catch (error) {
    return errorResponse(
      error instanceof WorkflowValidationError ? new HttpError(400, error.message) : error
    )
  }
}
