// Webhook entry points for QQ and the WeChat official account. They verify the platform's
// signature, save the message and answer right away; the reply is sent by the worker (hub.ts),
// so the 3 s (QQ) and 5 s (WeChat) response limits never depend on the model.
import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { channelLinks } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { enqueueInbound } from "./inbound"
import { parseQqPayload, qqSignValidation, qqVerifyCallback } from "./qq"
import { oaDecrypt, oaVerifySignature, parseOaMessage } from "./wechat-oa"

export type WebhookResponse = { status: number; body: unknown; contentType?: string }

// ───────────────────────── QQ ─────────────────────────

export async function handleQqWebhook(
  rawBody: string,
  headers: { timestamp: string | null; signature: string | null }
): Promise<WebhookResponse> {
  const secret = await getSetting("qq.appSecret")
  if (!secret) return { status: 404, body: { error: "QQ not configured" } }
  let payload: { id?: string; op?: number; t?: string; d?: Record<string, unknown> }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: "bad body" } }
  }
  // Address validation (op 13) is signed by us; it is not signed by the platform
  if (payload.op === 13) {
    const plainToken = payload.d?.plain_token
    const eventTs = payload.d?.event_ts
    if (typeof plainToken !== "string" || typeof eventTs !== "string")
      return { status: 400, body: { error: "bad validation" } }
    return {
      status: 200,
      body: {
        plain_token: plainToken,
        signature: qqSignValidation(secret, eventTs, plainToken),
      },
    }
  }
  if (!qqVerifyCallback(secret, headers.timestamp, headers.signature, rawBody))
    return { status: 401, body: { error: "bad signature" } }

  const event = parseQqPayload(payload)
  if (event?.type === "message") {
    if (event.text || event.context.imageUrl)
      await enqueueInbound({
        channel: "qq",
        eventKey: event.eventKey,
        externalId: event.openid,
        text: event.text,
        context: event.context,
      })
  } else if (event?.type === "reject" || event?.type === "receive") {
    // The person switched proactive messages off/on in QQ
    await db
      .update(channelLinks)
      .set({
        state: sql`${channelLinks.state} || ${JSON.stringify({ rejected: event.type === "reject" })}::jsonb`,
      })
      .where(
        and(eq(channelLinks.channel, "qq"), eq(channelLinks.externalId, event.openid))
      )
  }
  // Acknowledge (op 12) so the platform does not redeliver
  return { status: 200, body: { op: 12 } }
}

// ───────────────────────── WeChat official account ─────────────────────────

export type OaQuery = {
  signature: string | null
  timestamp: string | null
  nonce: string | null
  echostr?: string | null
  msg_signature?: string | null
}

export async function handleOaVerify(query: OaQuery): Promise<WebhookResponse> {
  const token = await getSetting("wechatOa.token")
  if (
    !token ||
    !query.echostr ||
    !oaVerifySignature(token, query.signature, query.timestamp, query.nonce)
  )
    return { status: 403, body: "forbidden", contentType: "text/plain" }
  return { status: 200, body: query.echostr, contentType: "text/plain" }
}

export async function handleOaMessage(
  rawBody: string,
  query: OaQuery
): Promise<WebhookResponse> {
  const [token, aesKey, appId] = await Promise.all([
    getSetting("wechatOa.token"),
    getSetting("wechatOa.aesKey"),
    getSetting("wechatOa.appId"),
  ])
  const forbidden = { status: 403, body: "forbidden", contentType: "text/plain" }
  if (!token) return forbidden
  let xml = rawBody
  const encrypted = /<Encrypt>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/Encrypt>/.exec(
    rawBody
  )
  if (encrypted) {
    const cipherText = encrypted[1] ?? encrypted[2]
    if (!aesKey || !appId) return forbidden
    if (
      !oaVerifySignature(
        token,
        query.msg_signature ?? null,
        query.timestamp,
        query.nonce,
        cipherText
      )
    )
      return forbidden
    try {
      xml = oaDecrypt(aesKey, cipherText, appId)
    } catch {
      return forbidden
    }
  } else if (!oaVerifySignature(token, query.signature, query.timestamp, query.nonce))
    return forbidden

  const message = parseOaMessage(xml)
  if (message?.text)
    await enqueueInbound({
      channel: "wechat_oa",
      eventKey: message.eventKey,
      externalId: message.openid,
      text: message.text,
    })
  // The answer goes out through the customer-service API; "success" tells WeChat not to retry
  return { status: 200, body: "success", contentType: "text/plain" }
}
