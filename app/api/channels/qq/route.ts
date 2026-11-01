import { errorResponse } from "@/lib/errors"
import { handleQqWebhook } from "@/lib/channels/webhooks"

// QQ bot webhook (configure this URL under 开发管理 → 回调配置)
export async function POST(request: Request) {
  try {
    const result = await handleQqWebhook(await request.text(), {
      timestamp: request.headers.get("x-signature-timestamp"),
      signature: request.headers.get("x-signature-ed25519"),
    })
    return Response.json(result.body, { status: result.status })
  } catch (error) {
    return errorResponse(error)
  }
}
