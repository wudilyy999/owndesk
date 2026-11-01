import type { ChannelId } from "@/db/schema"
import { telegramAdapter } from "./adapters/telegram"
import { qqAdapter } from "./qq"
import type { ChannelAdapter } from "./types"
import { wechatAdapter } from "./wechat"
import { wechatOaAdapter } from "./wechat-oa"

export const adapters: Record<ChannelId, ChannelAdapter> = {
  telegram: telegramAdapter,
  qq: qqAdapter,
  wechat: wechatAdapter,
  wechat_oa: wechatOaAdapter,
}
