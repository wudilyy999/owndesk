// Pictures that arrive on a channel: fetched on the worker (never inside a webhook), checked and
// stored by lib/companion/images.ts, then handed to her with the message.
import { getSetting } from "@/lib/config"
import { HttpError } from "@/lib/errors"
import { MAX_UPLOAD_BYTES, saveImage } from "@/lib/companion/images"
import { qqImageUrl } from "./qq"
import { TelegramError, downloadTelegramFile } from "@/lib/telegram/api"

async function fetchLimited(url: string, maxBytes: number) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
    redirect: "error",
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, "图片太大")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export type ReceivedImage = { imageId?: string; failed?: string }

// `failed` is a note for her ("a picture came but could not be taken"); transient network errors
// are thrown so the hub's retry runs.
export async function receiveImage(
  agentId: string,
  context: Record<string, unknown>
): Promise<ReceivedImage> {
  const fileId =
    typeof context.telegramFileId === "string" ? context.telegramFileId : null
  const url = qqImageUrl(context.imageUrl)
  if (!fileId && !url) return {}
  try {
    let data: Buffer
    if (fileId) {
      const token = await getSetting("telegram.botToken")
      if (!token) throw new HttpError(409, "Telegram 没有配置")
      data = await downloadTelegramFile(token, fileId, MAX_UPLOAD_BYTES)
    } else data = await fetchLimited(url!, MAX_UPLOAD_BYTES)
    const row = await saveImage(agentId, data, fileId ? "telegram" : "qq")
    return { imageId: row.id }
  } catch (error) {
    if (error instanceof TelegramError && error.uncertain) throw error
    if (error instanceof HttpError || error instanceof TelegramError)
      return { failed: error.message }
    if (!fileId) return { failed: "没能把图片取下来" }
    throw error
  }
}
