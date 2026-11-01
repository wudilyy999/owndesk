// WeChat via the official ClawBot plugin (iLink bot protocol, https://ilinkai.weixin.qq.com).
// Protocol reference: Tencent's own MIT plugin https://github.com/Tencent/openclaw-weixin
// (docs/protocol.md); behaviour such as the -14 session pause follows that plugin.
// No code is copied. One ClawBot belongs to one WeChat user.
//
// Platform rules that shape her behaviour: the bot cannot start a conversation. Every message
// must carry the context_token of something the person just sent. So she only answers, and what
// she did in the meantime is folded into the next reply (see hub.ts).
import { randomBytes, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { getSetting, setSetting } from "@/lib/config"
import { egressFetch } from "./egress"
import { enqueueInbound } from "./inbound"
import {
  ChannelSendError,
  chunkText,
  type ChannelAdapter,
  type InboundContext,
} from "./types"

const CHANNEL_VERSION = "1.0.0"
// The context_token is only good for a limited time; its exact lifetime is not published
export const WECHAT_CONTEXT_WINDOW_MS = 24 * 3600_000
const baseInfo = { channel_version: CHANNEL_VERSION, bot_agent: "OwnDesk/0.1" }

export type WechatState = { contextToken?: string; contextAt?: string }

type Session = { baseUrl: string; token: string }

export async function wechatSession(): Promise<Session | null> {
  const [token, baseUrl] = await Promise.all([
    getSetting("wechat.botToken"),
    getSetting("wechat.baseUrl"),
  ])
  return token ? { token, baseUrl: (baseUrl ?? "").replace(/\/+$/, "") } : null
}

function headers(token?: string) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function ilinkPost<T>(
  session: Session,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
  signal?: AbortSignal
) {
  const response = await egressFetch(
    `${session.baseUrl}${path}`,
    {
      method: "POST",
      headers: headers(session.token),
      body: JSON.stringify({ ...body, base_info: baseInfo }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : undefined,
    },
    timeoutMs
  )
  if (!response.ok)
    throw new ChannelSendError(`WeChat ${path} failed (${response.status})`, {
      retryable: response.status >= 500 || response.status === 429,
    })
  return (await response.json()) as T
}

// ───────────── login (QR code scanned by the person in WeChat) ─────────────

export async function startWechatLogin() {
  const baseUrl = ((await getSetting("wechat.baseUrl")) ?? "").replace(/\/+$/, "")
  const response = await egressFetch(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ local_token_list: [] }),
  })
  const body = (await response.json().catch(() => null)) as {
    qrcode?: string
    qrcode_img_content?: string
  } | null
  if (!response.ok || !body?.qrcode)
    throw new ChannelSendError(`WeChat QR request failed (${response.status})`)
  return { qrcode: body.qrcode, content: body.qrcode_img_content ?? "" }
}

export type WechatLoginStatus =
  | { status: "wait" | "scaned" | "expired" | "need_verifycode" | "verify_code_blocked" }
  | { status: "confirmed"; userId: string }

export async function pollWechatLogin(
  qrcode: string,
  agentId: string,
  verifyCode?: string,
  signal?: AbortSignal
): Promise<WechatLoginStatus> {
  let baseUrl = ((await getSetting("wechat.baseUrl")) ?? "").replace(/\/+$/, "")
  const query = `qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`
  for (let hop = 0; hop < 3; hop++) {
    const response = await egressFetch(
      `${baseUrl}/ilink/bot/get_qrcode_status?${query}`,
      { headers: { "iLink-App-ClientVersion": "1" }, signal },
      35_000
    ).catch(() => null)
    const body = (await response?.json().catch(() => null)) as {
      status?: string
      bot_token?: string
      baseurl?: string
      ilink_user_id?: string
      redirect_host?: string
    } | null
    if (!body?.status) return { status: "wait" }
    if (body.status === "scaned_but_redirect" && body.redirect_host) {
      baseUrl = `https://${body.redirect_host}`
      continue
    }
    if (body.status === "confirmed") {
      if (!body.bot_token || !body.ilink_user_id)
        throw new ChannelSendError("WeChat login confirmed without credentials")
      await completeWechatLogin({
        token: body.bot_token,
        baseUrl: body.baseurl,
        userId: body.ilink_user_id,
        agentId,
      })
      return { status: "confirmed", userId: body.ilink_user_id }
    }
    if (body.status === "binded_redirect") return { status: "wait" }
    if (
      ["wait", "scaned", "expired", "need_verifycode", "verify_code_blocked"].includes(
        body.status
      )
    )
      return { status: body.status as "wait" }
    return { status: "wait" }
  }
  return { status: "wait" }
}

export async function completeWechatLogin(input: {
  token: string
  baseUrl?: string
  userId: string
  agentId: string
}) {
  await setSetting("wechat.botToken", input.token)
  if (input.baseUrl) await setSetting("wechat.baseUrl", input.baseUrl)
  await setSetting("wechat.userId", input.userId)
  await setSetting("wechat.agentId", input.agentId)
  await setSetting("wechat.cursor", null)
  await setSetting("wechat.status", "ok")
}

export async function disconnectWechat() {
  for (const key of [
    "wechat.botToken",
    "wechat.userId",
    "wechat.agentId",
    "wechat.cursor",
    "wechat.status",
  ] as const)
    await setSetting(key, null)
}

// ───────────────────────── adapter ─────────────────────────

export const wechatAdapter: ChannelAdapter = {
  id: "wechat",
  label: "微信",
  maxLength: 1800,
  proactive: "never",
  plan(link, kind, now) {
    const state = link.state as WechatState
    if (kind !== "reply")
      return { mode: "hold", reason: "微信不能主动发消息，等对方下次开口时一起说" }
    if (
      !state.contextToken ||
      !state.contextAt ||
      now.getTime() - Date.parse(state.contextAt) > WECHAT_CONTEXT_WINDOW_MS
    )
      return { mode: "hold", reason: "没有可用的回复凭证" }
    return { mode: "send" }
  },
  onInbound(_link, context, now) {
    return context.contextToken
      ? { contextToken: context.contextToken, contextAt: now.toISOString() }
      : {}
  },
  async send(link, item) {
    const session = await wechatSession()
    if (!session) throw new ChannelSendError("微信还没有连接", { retryable: false })
    const token = (link.state as WechatState).contextToken
    if (!token) throw new ChannelSendError("没有可用的回复凭证", { hold: true })
    for (const part of chunkText(item.text, this.maxLength)) {
      const result = await ilinkPost<{ ret?: number; errcode?: number; errmsg?: string }>(
        session,
        "/ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: link.externalId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: token,
            item_list: [{ type: 1, text_item: { text: part } }],
          },
        }
      )
      if (result.ret || result.errcode)
        throw new ChannelSendError(
          `WeChat send failed: ${result.ret ?? result.errcode} ${result.errmsg ?? ""}`,
          { code: result.ret ?? result.errcode, retryable: false }
        )
    }
  },
  async sendUnlinked(externalId, context, text) {
    const session = await wechatSession()
    if (!session || !context.contextToken) return
    await ilinkPost(session, "/ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: externalId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: context.contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    })
  },
}

// ───────────────────────── receiving ─────────────────────────

type IlinkMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  message_type?: number
  context_token?: string
  create_time_ms?: number
  item_list?: {
    type?: number
    text_item?: { text?: string }
    voice_item?: { text?: string }
  }[]
}

export function wechatMessageText(message: IlinkMessage) {
  const items = message.item_list ?? []
  const text = items
    .map((item) =>
      item.type === 1
        ? item.text_item?.text
        : item.type === 3
          ? item.voice_item?.text
          : undefined
    )
    .filter(Boolean)
    .join("\n")
    .trim()
  if (text) return text
  if (items.some((i) => i.type === 2)) return "[发来了一张图片，你看不到内容]"
  if (items.some((i) => i.type === 3)) return "[发来了一段语音，你听不清内容]"
  if (items.length) return "[发来了一个文件或视频，你看不到内容]"
  return ""
}

// Stores the messages of one getupdates response; returns how many were new
export async function storeWechatMessages(messages: IlinkMessage[], userId: string) {
  let stored = 0
  for (const message of messages) {
    if (message.message_type !== 1 || message.from_user_id !== userId) continue
    const text = wechatMessageText(message)
    if (!text || !message.context_token) continue
    const key = String(message.message_id ?? message.seq ?? message.create_time_ms)
    if (
      await enqueueInbound({
        channel: "wechat",
        eventKey: key,
        externalId: userId,
        text,
        context: { contextToken: message.context_token },
      })
    )
      stored++
  }
  return stored
}

// Long-polls for messages until aborted. A -14 answer means the login is no longer valid:
// pause for an hour like the official plugin, and show it in the status.
export async function runWechat(signal: AbortSignal) {
  let paused = 0
  while (!signal.aborted) {
    try {
      const session = await wechatSession()
      const userId = await getSetting("wechat.userId")
      if (!session || !userId || Date.now() < paused) {
        await delay(2000, undefined, { signal })
        continue
      }
      const cursor = (await getSetting("wechat.cursor")) ?? ""
      const result = await ilinkPost<{
        ret?: number
        errcode?: number
        errmsg?: string
        msgs?: IlinkMessage[]
        get_updates_buf?: string
        longpolling_timeout_ms?: number
      }>(
        session,
        "/ilink/bot/getupdates",
        { get_updates_buf: cursor },
        (await Promise.resolve(40_000)) as number,
        signal
      ).catch((error) => {
        if (signal.aborted) throw error
        // A timed-out long poll is an empty answer
        if (
          (error as Error).name === "TimeoutError" ||
          (error as Error).name === "AbortError"
        )
          return {
            msgs: [] as IlinkMessage[],
            ret: undefined,
            errcode: undefined,
            errmsg: undefined,
            get_updates_buf: undefined,
          }
        throw error
      })
      if (result.ret === -14 || result.errcode === -14) {
        paused = Date.now() + 3600_000
        await setSetting("wechat.status", "expired")
        continue
      }
      if (result.ret || result.errcode)
        throw new Error(result.errmsg ?? "getupdates failed")
      await storeWechatMessages(result.msgs ?? [], userId)
      if (result.get_updates_buf && result.get_updates_buf !== cursor)
        await setSetting("wechat.cursor", result.get_updates_buf)
      await setSetting("wechat.status", "ok")
    } catch (error) {
      if (signal.aborted) return
      console.error("WeChat poll failed", (error as Error).message)
      await delay(5000, undefined, { signal }).catch(() => {})
    }
  }
}

export function wechatContext(contextToken: string): InboundContext {
  return { contextToken }
}
