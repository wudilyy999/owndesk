// Telegram companion route. Pairing, polling and the delivery journal belong to the existing
// bridge (lib/telegram); this adapter only puts her messages into its outbox, so a message is
// sent once and a crash never causes a blind resend.
import { pool } from "@/db"
import { ensureTelegramConnection } from "@/lib/telegram/state"
import { queueTelegram } from "@/lib/telegram/notifications"
import { ChannelSendError, type ChannelAdapter } from "../types"

export const telegramAdapter: ChannelAdapter = {
  id: "telegram",
  label: "Telegram",
  maxLength: 3800,
  proactive: "free",
  plan() {
    return { mode: "send" }
  },
  onInbound() {
    return {}
  },
  async send(link, item) {
    const state = await ensureTelegramConnection()
    if (!state?.user_id || state.chat_id !== link.externalId)
      throw new ChannelSendError("Telegram 已解除配对", { hold: true })
    const client = await pool.connect()
    try {
      await queueTelegram(client, state, `companion:${item.id}`, item.text)
    } finally {
      client.release()
    }
  },
  async sendUnlinked() {
    // Unpaired chats are ignored by the bridge
  },
}
