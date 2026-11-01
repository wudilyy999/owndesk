import { errorResponse } from "@/lib/errors"
import { handleOaMessage, handleOaVerify, type OaQuery } from "@/lib/channels/webhooks"

function query(request: Request): OaQuery {
  const url = new URL(request.url)
  return {
    signature: url.searchParams.get("signature"),
    timestamp: url.searchParams.get("timestamp"),
    nonce: url.searchParams.get("nonce"),
    echostr: url.searchParams.get("echostr"),
    msg_signature: url.searchParams.get("msg_signature"),
  }
}

function respond(result: { status: number; body: unknown; contentType?: string }) {
  return new Response(String(result.body), {
    status: result.status,
    headers: { "Content-Type": result.contentType ?? "text/plain" },
  })
}

// Official account server URL: GET verifies the address, POST delivers messages
export async function GET(request: Request) {
  try {
    return respond(await handleOaVerify(query(request)))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    return respond(await handleOaMessage(await request.text(), query(request)))
  } catch (error) {
    return errorResponse(error)
  }
}
