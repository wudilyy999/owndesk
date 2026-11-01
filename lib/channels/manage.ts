// What the channel settings page shows and changes. Secrets are write-only: the page learns
// whether one is set, never its value.
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { channelLinks, channelOutbox, type ChannelId } from "@/db/schema"
import { getSetting, setSettings, type SettingKey } from "@/lib/config"
import { ensureTelegramConnection } from "@/lib/telegram/state"
import { HttpError } from "@/lib/errors"
import { env } from "@/lib/env"
import { adapters } from "./registry"
import { bindChannel, createPairCode, unbindChannel } from "./pairing"
import { pollWechatLogin, startWechatLogin, disconnectWechat } from "./wechat"

const has = async (key: SettingKey) => !!(await getSetting(key))

export async function channelStatus(ownerId: string, agentId: string) {
  const links = await db
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.agentId, agentId), eq(channelLinks.ownerId, ownerId)))
  const held = await db
    .select({ id: channelOutbox.id, linkId: channelOutbox.linkId })
    .from(channelOutbox)
    .where(eq(channelOutbox.status, "held"))
  const base = env.APP_URL.replace(/\/$/, "")
  const telegram = await ensureTelegramConnection(ownerId).catch(() => null)
  const view = (channel: ChannelId) => {
    const link = links.find((item) => item.channel === channel)
    return {
      channel,
      label: adapters[channel].label,
      proactive: adapters[channel].proactive,
      linked: !!link,
      lastInboundAt: link?.lastInboundAt ?? null,
      heldCount: link ? held.filter((item) => item.linkId === link.id).length : 0,
    }
  }
  return {
    channels: {
      telegram: {
        ...view("telegram"),
        paired: !!telegram?.user_id,
        // The Telegram bot itself is set up on the Telegram page; this only decides who answers plain text
        usesThisCompanion: telegram?.agent_id === agentId,
      },
      qq: {
        ...view("qq"),
        configured: (await has("qq.appId")) && (await has("qq.appSecret")),
        webhookUrl: `${base}/api/channels/qq`,
      },
      wechat: {
        ...view("wechat"),
        connected: !!(await getSetting("wechat.botToken")),
        status: (await getSetting("wechat.status")) ?? null,
      },
      wechat_oa: {
        ...view("wechat_oa"),
        configured:
          (await has("wechatOa.appId")) &&
          (await has("wechatOa.appSecret")) &&
          (await has("wechatOa.token")),
        encrypted: await has("wechatOa.aesKey"),
        webhookUrl: `${base}/api/channels/wechat-oa`,
      },
    },
    relay: { configured: await has("channel.relayUrl") },
  }
}

const text = z.string().trim().max(400)
export const channelActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pair-code"), channel: z.enum(["qq", "wechat_oa"]) }),
  z.object({
    action: z.literal("unbind"),
    channel: z.enum(["telegram", "qq", "wechat", "wechat_oa"]),
  }),
  z.object({ action: z.literal("telegram-link") }),
  z.object({
    action: z.literal("configure"),
    channel: z.enum(["qq", "wechat_oa", "relay"]),
    values: z.record(z.string(), text),
  }),
  z.object({ action: z.literal("wechat-login-start") }),
  z.object({
    action: z.literal("wechat-login-poll"),
    qrcode: text,
    verifyCode: text.optional(),
  }),
  z.object({ action: z.literal("wechat-disconnect") }),
])

const FIELDS: Record<"qq" | "wechat_oa" | "relay", Record<string, SettingKey>> = {
  qq: {
    appId: "qq.appId",
    appSecret: "qq.appSecret",
    allowedUrlHosts: "qq.allowedUrlHosts",
  },
  wechat_oa: {
    appId: "wechatOa.appId",
    appSecret: "wechatOa.appSecret",
    token: "wechatOa.token",
    aesKey: "wechatOa.aesKey",
  },
  relay: { url: "channel.relayUrl", key: "channel.relayKey" },
}

export async function channelAction(
  ownerId: string,
  agentId: string,
  input: z.infer<typeof channelActionSchema>
) {
  switch (input.action) {
    case "pair-code":
      return createPairCode(ownerId, agentId)
    case "unbind":
      return { unbound: await unbindChannel(ownerId, agentId, input.channel) }
    case "telegram-link": {
      const state = await ensureTelegramConnection(ownerId)
      if (!state?.user_id || !state.chat_id)
        throw new HttpError(409, "先在 Telegram 设置里完成配对")
      const link = await bindChannel({
        channel: "telegram",
        externalId: state.chat_id,
        agentId,
        ownerId,
      })
      return { linked: true, linkId: link.id }
    }
    case "configure": {
      const fields = FIELDS[input.channel]
      const updates: { key: SettingKey; value: string | null }[] = []
      for (const [name, value] of Object.entries(input.values)) {
        const key = fields[name]
        if (!key) throw new HttpError(400, `未知字段 ${name}`)
        // An empty string clears the value; a missing field stays as it is
        updates.push({ key, value: value || null })
      }
      if (input.channel === "relay") {
        const url = updates.find((item) => item.key === "channel.relayUrl")?.value
        if (url && !/^https?:\/\//.test(url))
          throw new HttpError(400, "中转地址需要以 http(s):// 开头")
      }
      await setSettings(updates)
      return { saved: updates.length }
    }
    case "wechat-login-start":
      return startWechatLogin()
    case "wechat-login-poll": {
      const result = await pollWechatLogin(input.qrcode, agentId, input.verifyCode)
      if (result.status === "confirmed")
        await bindChannel({
          channel: "wechat",
          externalId: result.userId,
          agentId,
          ownerId,
        })
      return result
    }
    case "wechat-disconnect":
      await disconnectWechat()
      await unbindChannel(ownerId, agentId, "wechat")
      return { disconnected: true }
  }
}
