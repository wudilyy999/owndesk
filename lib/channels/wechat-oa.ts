// WeChat official account (customer-service messages) as the fallback route to WeChat.
// Protocol from the official docs (developers.weixin.qq.com/doc/offiaccount): server verification
// by SHA1 signature, XML messages (optionally AES-encrypted), customer-service send API.
// Passive only: a customer-service message can only be sent within 48 hours after the person's
// last message and at most 5 times, so she never reaches out first on this channel either.
import { createDecipheriv, createCipheriv, createHash, randomBytes } from "node:crypto"
import { getSetting } from "@/lib/config"
import { egressFetch } from "./egress"
import { ChannelSendError, chunkText, type ChannelAdapter } from "./types"

export const OA_WINDOW_MS = 48 * 3600_000
export const OA_MAX_MESSAGES = 5
type OaState = { sent?: number; windowAt?: string }

const sha1 = (parts: string[]) =>
  createHash("sha1")
    .update([...parts].sort().join(""))
    .digest("hex")

export function oaVerifySignature(
  token: string,
  signature: string | null,
  timestamp: string | null,
  nonce: string | null,
  encrypted?: string
) {
  if (!signature || !timestamp || !nonce) return false
  return sha1([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])]) === signature
}

// ───── security mode: AES-256-CBC, key = base64(EncodingAESKey + "="), iv = key[0..16] ─────

function aes(encodingKey: string) {
  const key = Buffer.from(encodingKey + "=", "base64")
  return { key, iv: key.subarray(0, 16) }
}

export function oaDecrypt(encodingKey: string, encrypted: string, appId: string) {
  const { key, iv } = aes(encodingKey)
  const decipher = createDecipheriv("aes-256-cbc", key, iv)
  decipher.setAutoPadding(false)
  let plain = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ])
  plain = plain.subarray(0, plain.length - plain[plain.length - 1]) // PKCS#7 with 32-byte blocks
  const length = plain.readUInt32BE(16)
  const message = plain.subarray(20, 20 + length).toString("utf8")
  if (plain.subarray(20 + length).toString("utf8") !== appId)
    throw new Error("WeChat OA message belongs to another app")
  return message
}

export function oaEncrypt(encodingKey: string, message: string, appId: string) {
  const { key, iv } = aes(encodingKey)
  const body = Buffer.from(message)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  let plain = Buffer.concat([randomBytes(16), length, body, Buffer.from(appId)])
  const pad = 32 - (plain.length % 32)
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)])
  const cipher = createCipheriv("aes-256-cbc", key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64")
}

// ───────────────────────── XML (flat messages only) ─────────────────────────

export function oaField(xml: string, name: string) {
  const match = new RegExp(
    `<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`
  ).exec(xml)
  return match ? (match[1] ?? match[2] ?? "") : null
}

export type OaMessage = {
  openid: string
  eventKey: string
  text: string
  event?: string
}

export function parseOaMessage(xml: string): OaMessage | null {
  const openid = oaField(xml, "FromUserName")
  const type = oaField(xml, "MsgType")
  if (!openid || !type) return null
  if (type === "event")
    return {
      openid,
      eventKey: `event:${openid}:${oaField(xml, "CreateTime")}:${oaField(xml, "Event")}`,
      text: "",
      event: oaField(xml, "Event") ?? undefined,
    }
  const id = oaField(xml, "MsgId") ?? `${openid}:${oaField(xml, "CreateTime")}`
  if (type === "text")
    return { openid, eventKey: id, text: (oaField(xml, "Content") ?? "").trim() }
  if (type === "voice") {
    const text = oaField(xml, "Recognition")?.trim()
    return { openid, eventKey: id, text: text || "[发来了一段语音，你听不清内容]" }
  }
  return { openid, eventKey: id, text: "[发来了一张图片或其他内容，你看不到]" }
}

// ───────────────────────── api ─────────────────────────

const tokens = new Map<string, { token: string; expiresAt: number }>()
export function resetOaTokenCache() {
  tokens.clear()
}

async function oaBase() {
  return ((await getSetting("wechatOa.apiBase")) ?? "").replace(/\/+$/, "")
}

async function oaToken(now = Date.now()) {
  const [appId, secret] = await Promise.all([
    getSetting("wechatOa.appId"),
    getSetting("wechatOa.appSecret"),
  ])
  if (!appId || !secret) throw new ChannelSendError("公众号还没有配置")
  const cached = tokens.get(appId)
  if (cached && cached.expiresAt - 300_000 > now) return cached.token
  const response = await egressFetch(
    `${await oaBase()}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
  )
  const body = (await response.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
    errcode?: number
    errmsg?: string
  } | null
  if (!response.ok || !body?.access_token)
    throw new ChannelSendError(
      `WeChat OA token failed: ${body?.errcode ?? response.status}`,
      {
        retryable: !body?.errcode,
      }
    )
  tokens.set(appId, {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 7200) * 1000,
  })
  return body.access_token
}

async function sendCustom(openid: string, text: string) {
  const response = await egressFetch(
    `${await oaBase()}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(await oaToken())}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ touser: openid, msgtype: "text", text: { content: text } }),
    }
  )
  const body = (await response.json().catch(() => null)) as {
    errcode?: number
    errmsg?: string
  } | null
  if (response.ok && !body?.errcode) return
  const code = body?.errcode ?? response.status
  // 40001/42001 token invalid or expired; 45015 outside the 48 h window; 45047 over the count limit
  if (code === 40001 || code === 42001) tokens.clear()
  throw new ChannelSendError(`WeChat OA send failed: ${code} ${body?.errmsg ?? ""}`, {
    code,
    retryable: code === 40001 || code === 42001 || response.status >= 500,
    hold: code === 45015 || code === 45047,
  })
}

export const wechatOaAdapter: ChannelAdapter = {
  id: "wechat_oa",
  label: "微信公众号",
  maxLength: 600,
  proactive: "never",
  plan(link, kind, now) {
    const state = link.state as OaState
    if (kind !== "reply")
      return {
        mode: "hold",
        reason: "公众号客服消息只能在对方发话后回复，等对方下次开口时一起说",
      }
    if (!state.windowAt || now.getTime() - Date.parse(state.windowAt) > OA_WINDOW_MS)
      return { mode: "hold", reason: "超过 48 小时" }
    if ((state.sent ?? 0) >= OA_MAX_MESSAGES)
      return { mode: "hold", reason: "回复条数已用完" }
    return { mode: "send" }
  },
  onInbound(_link, _context, now) {
    return { sent: 0, windowAt: now.toISOString() }
  },
  async send(link, item) {
    const state = link.state as OaState
    let sent = state.sent ?? 0
    for (const part of chunkText(item.text, this.maxLength)) {
      if (sent >= OA_MAX_MESSAGES)
        throw new ChannelSendError("回复条数已用完", { hold: true })
      await sendCustom(link.externalId, part)
      sent++
    }
    return { sent }
  },
  async sendUnlinked(externalId, _context, text) {
    await sendCustom(externalId, text)
  },
}
