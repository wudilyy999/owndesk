// QQ official bot (open platform API v2), single chat (C2C) only.
// Protocol from the official docs (https://bot.q.qq.com/wiki/develop/api-v2/); the access-token
// refresh and msg_id/msg_seq handling follow the official Python SDK tencent-connect/botpy (MIT).
// No code is copied. Webhook mode: the platform POSTs events to /api/channels/qq/webhook.
//
// Platform rules that shape her behaviour (checked against the docs on 2026-11-01):
// - Push messages are no longer offered (since 2025-04-21). She can answer a message she just
//   received (passive reply, limited time and count) and, after the person has written within the
//   last 30 days, send ONE "wake-up" message per period (same day, 1-3, 3-7, 7-30 days).
// - Anything else waits and is folded into her next reply.
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto"
import type { ChannelLink } from "@/db/schema"
import { getSetting } from "@/lib/config"
import { egressFetch } from "./egress"
import {
  ChannelSendError,
  chunkText,
  type ChannelAdapter,
  type InboundContext,
} from "./types"

export const QQ_PASSIVE_WINDOW_MS = 5 * 60_000 // docs disagree (5 vs 60 min); stay with the shorter one
export const QQ_MAX_PASSIVE_REPLIES = 4 // docs say 4 or 5 per message; stay with the smaller one
const WAKEUP_PERIODS_DAYS = [1, 3, 7, 30] // upper bounds of: today, 1-3, 3-7, 7-30 days

export type QqState = {
  msgId?: string
  msgIdAt?: string
  seq?: number
  rejected?: boolean
  anchorDay?: string
  wakeupUsed?: boolean[]
}

// ───────────────────────── signatures ─────────────────────────

// Bot Secret repeated up to 32 bytes is the Ed25519 seed (official docs, "安全和授权")
function keyPair(secret: string) {
  let seed = secret
  while (Buffer.byteLength(seed) < 32) seed += seed
  const raw = Buffer.from(seed).subarray(0, 32)
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]),
    format: "der",
    type: "pkcs8",
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

export function qqSignValidation(secret: string, eventTs: string, plainToken: string) {
  return edSign(
    null,
    Buffer.from(eventTs + plainToken),
    keyPair(secret).privateKey
  ).toString("hex")
}

export function qqVerifyCallback(
  secret: string,
  timestamp: string | null,
  signatureHex: string | null,
  rawBody: string
) {
  if (!timestamp || !signatureHex || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false
  const signature = Buffer.from(signatureHex, "hex")
  // Same malleability check as the official Go sample: sig[63]&224 must be 0
  if (signature[63] & 224) return false
  try {
    return edVerify(
      null,
      Buffer.from(timestamp + rawBody),
      keyPair(secret).publicKey,
      signature
    )
  } catch {
    return false
  }
}

// ───────────────────────── api client ─────────────────────────

type Credentials = { appId: string; appSecret: string; apiBase: string }
const tokens = new Map<string, { token: string; expiresAt: number }>()

export async function qqCredentials(): Promise<Credentials | null> {
  const [appId, appSecret, apiBase] = await Promise.all([
    getSetting("qq.appId"),
    getSetting("qq.appSecret"),
    getSetting("qq.apiBase"),
  ])
  return appId && appSecret
    ? { appId, appSecret, apiBase: (apiBase ?? "https://api.bot.qq.com").replace(/\/+$/, "") }
    : null
}

export async function qqAccessToken(creds: Credentials, now = Date.now()) {
  const cached = tokens.get(creds.appId)
  // The platform hands out a fresh token during the last 60 s of the old one; renew a bit early
  if (cached && cached.expiresAt - 90_000 > now) return cached.token
  const response = await egressFetch(`${creds.apiBase}/app/getAppAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }),
  })
  const body = (await response.json().catch(() => null)) as {
    access_token?: string
    expires_in?: string | number
    message?: string
  } | null
  if (!response.ok || !body?.access_token)
    throw new ChannelSendError(`QQ token request failed (${response.status})`, {
      retryable: response.status >= 500 || response.status === 429,
    })
  tokens.set(creds.appId, {
    token: body.access_token,
    expiresAt: now + Number(body.expires_in ?? 7200) * 1000,
  })
  return body.access_token
}

export function resetQqTokenCache() {
  tokens.clear()
}

// Error codes seen in the docs: 22009 too fast, 40034005 msg_id expired
const EXPIRED = new Set([40034005, 40034006])
const TOO_FAST = new Set([22009])

export async function qqRequest(
  creds: Credentials,
  path: string,
  body: Record<string, unknown>
) {
  const token = await qqAccessToken(creds)
  const response = await egressFetch(`${creds.apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `QQBot ${token}`,
      "X-Union-Appid": creds.appId,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => null)) as {
    id?: string
    err_code?: number
    code?: number
    message?: string
  } | null
  const code = data?.err_code ?? data?.code ?? 0
  if (response.ok && !code) return data
  if (response.status === 401) tokens.delete(creds.appId)
  throw new ChannelSendError(
    `QQ send failed: ${response.status} ${code} ${data?.message ?? ""}`.trim(),
    {
      code,
      retryable:
        response.status >= 500 ||
        response.status === 401 ||
        response.status === 429 ||
        TOO_FAST.has(code),
      hold: EXPIRED.has(code),
    }
  )
}

// ───────────────────────── routing rules ─────────────────────────

const dayKey = (date: Date, offsetMs = 8 * 3600_000) =>
  new Date(date.getTime() + offsetMs).toISOString().slice(0, 10)

// Which wake-up period the person's last message puts us in; null = past 30 days
export function wakeupPeriod(lastInboundAt: Date | null, now: Date) {
  if (!lastInboundAt) return null
  // Periods count whole days in the platform's time zone (UTC+8)
  const days = Math.floor(
    (Date.parse(dayKey(now) + "T00:00:00Z") -
      Date.parse(dayKey(lastInboundAt) + "T00:00:00Z")) /
      86_400_000
  )
  if (days < 0) return 0
  if (days === 0) return 0
  const index = WAKEUP_PERIODS_DAYS.findIndex((bound, i) => i > 0 && days < bound)
  return index === -1 ? null : index
}

export type QqRoute =
  | { type: "passive"; msgId: string; seq: number }
  | { type: "wakeup"; period: number }
  | { type: "none"; reason: string }

export function qqRoute(
  link: Pick<ChannelLink, "state" | "lastInboundAt">,
  now: Date
): QqRoute {
  const state = link.state as QqState
  // A reply goes to the person's latest message while it is fresh and has replies left
  if (
    state.msgId &&
    state.msgIdAt &&
    now.getTime() - Date.parse(state.msgIdAt) < QQ_PASSIVE_WINDOW_MS &&
    (state.seq ?? 0) < QQ_MAX_PASSIVE_REPLIES
  )
    return { type: "passive", msgId: state.msgId, seq: (state.seq ?? 0) + 1 }
  if (state.rejected) return { type: "none", reason: "对方关闭了机器人的主动消息" }
  const period = wakeupPeriod(link.lastInboundAt, now)
  if (period === null) return { type: "none", reason: "对方超过 30 天没有说话" }
  const used = wakeupUsed(link)
  if (used[period]) return { type: "none", reason: "这个时段的召回消息已用过" }
  return { type: "wakeup", period }
}

function wakeupUsed(link: Pick<ChannelLink, "state" | "lastInboundAt">) {
  const state = link.state as QqState
  return link.lastInboundAt && state.anchorDay === dayKey(link.lastInboundAt)
    ? [...(state.wakeupUsed ?? [false, false, false, false])]
    : [false, false, false, false]
}

// QQ rejects messages that contain a link whose host is not registered in the bot's
// "消息URL配置"; replace such links so the rest of the message still goes out.
export function sanitizeQqText(text: string, allowedHosts: string[]) {
  const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))
  return text
    .replace(/https?:\/\/[^\s)）]+/gi, (url) => {
      try {
        return allowed.has(new URL(url).hostname.toLowerCase()) ? url : "（链接在网页里）"
      } catch {
        return "（链接在网页里）"
      }
    })
    .replace(/\n（链接在网页里）/g, " （链接在网页里）")
}

export const qqAdapter: ChannelAdapter = {
  id: "qq",
  label: "QQ",
  maxLength: 1800,
  proactive: "limited",
  plan(link, _kind, now) {
    const route = qqRoute(link, now)
    return route.type === "none" ? { mode: "hold", reason: route.reason } : { mode: "send" }
  },
  onInbound(link, context, now) {
    const state = link.state as QqState
    const day = dayKey(now)
    return {
      msgId: context.msgId,
      msgIdAt: now.toISOString(),
      seq: 0,
      // A message on a new day restarts the wake-up periods
      ...(state.anchorDay !== day
        ? { anchorDay: day, wakeupUsed: [false, false, false, false] }
        : {}),
    }
  },
  async send(link, item, now) {
    const creds = await qqCredentials()
    if (!creds) throw new ChannelSendError("QQ 机器人还没有配置", { retryable: false })
    const route = qqRoute(link, now)
    if (route.type === "none")
      throw new ChannelSendError(route.reason, { hold: true })
    const hosts = ((await getSetting("qq.allowedUrlHosts")) ?? "").split(",")
    let parts = chunkText(sanitizeQqText(item.text, hosts), this.maxLength)
    if (route.type === "passive") {
      // Never go past the per-message reply limit: fold the overflow into the last part
      const room = Math.max(1, QQ_MAX_PASSIVE_REPLIES - route.seq + 1)
      if (parts.length > room) parts = [...parts.slice(0, room - 1), parts.slice(room - 1).join("\n")]
      let seq = route.seq
      for (const part of parts) {
        await qqRequest(creds, `/v2/users/${link.externalId}/messages`, {
          content: part,
          msg_type: 0,
          msg_id: route.msgId,
          msg_seq: seq++,
        })
      }
      return { seq: seq - 1 }
    }
    // Wake-up: one message per period, so only the first part goes out
    await qqRequest(creds, `/v2/users/${link.externalId}/messages`, {
      content: parts[0],
      msg_type: 0,
      is_wakeup: true,
    })
    const used = wakeupUsed(link)
    used[route.period] = true
    return { wakeupUsed: used, anchorDay: dayKey(link.lastInboundAt!) }
  },
  async sendUnlinked(externalId, context, text) {
    const creds = await qqCredentials()
    if (!creds || !context.msgId) return
    await qqRequest(creds, `/v2/users/${externalId}/messages`, {
      content: text,
      msg_type: 0,
      msg_id: context.msgId,
      msg_seq: 1,
    })
  },
}

// ───────────────────────── webhook ─────────────────────────

export type WebhookResult = { status: number; body: unknown }
export type QqEvent =
  | { type: "message"; eventKey: string; openid: string; text: string; context: InboundContext }
  | { type: "reject" | "receive"; openid: string }
  | { type: "friend_add"; openid: string }

// Parses a verified callback; returns the normalised event or a response for the platform
export function parseQqPayload(payload: {
  id?: string
  op?: number
  t?: string
  d?: Record<string, unknown>
}): QqEvent | null {
  const d = payload.d ?? {}
  if (payload.op !== 0) return null
  if (payload.t === "C2C_MESSAGE_CREATE") {
    const author = d.author as { user_openid?: string; id?: string } | undefined
    const openid = author?.user_openid ?? author?.id
    const text = typeof d.content === "string" ? d.content.trim() : ""
    if (!openid || typeof d.id !== "string") return null
    const attachments = Array.isArray(d.attachments) ? d.attachments.length : 0
    return {
      type: "message",
      eventKey: payload.id ?? d.id,
      openid,
      text: text || (attachments ? "[发来了一张图片或文件，你看不到内容]" : ""),
      context: { msgId: d.id },
    }
  }
  const openid = typeof d.openid === "string" ? d.openid : undefined
  if (!openid) return null
  if (payload.t === "C2C_MSG_REJECT") return { type: "reject", openid }
  if (payload.t === "C2C_MSG_RECEIVE") return { type: "receive", openid }
  if (payload.t === "FRIEND_ADD") return { type: "friend_add", openid }
  return null
}
