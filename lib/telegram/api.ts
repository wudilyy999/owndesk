// Adapted from the pinned MIT upstream lib/telegram/api.ts at 7b08375 (MIT, Sourav Bera).
// Plain fetch and Bot API shapes retained; asynchronous config and explicit uncertainty added.
import { z } from "zod"
import { getSetting } from "@/lib/config"

const user = z.object({
  id: z.number().int().safe().positive(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
})
const chat = z.object({
  id: z.number().int().safe(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
})
const message = z.object({
  message_id: z.number().int().positive(),
  from: user.optional(),
  chat,
  date: z.number().int(),
  text: z.string().optional(),
  caption: z.string().max(4096).optional(),
  // Pictures: Telegram sends several sizes; documents are pictures sent "as a file"
  photo: z
    .array(
      z.object({
        file_id: z.string().min(1).max(512),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        file_size: z.number().int().nonnegative().optional(),
      })
    )
    .max(20)
    .optional(),
  document: z
    .object({
      file_id: z.string().min(1).max(512),
      mime_type: z.string().max(128).optional(),
      file_size: z.number().int().nonnegative().optional(),
    })
    .optional(),
  reply_to_message: z
    .object({ message_id: z.number().int().positive(), from: user.optional() })
    .optional(),
})
export const telegramUpdatesSchema = z.array(
  z.object({
    update_id: z.number().int().nonnegative().max(2147483646),
    message: message.optional(),
    callback_query: z
      .object({
        id: z.string().min(1).max(256),
        from: user,
        message: message.optional(),
        data: z.string().max(64).optional(),
      })
      .optional(),
  })
)
export const telegramUserSchema = user
export type TgUpdate = z.infer<typeof telegramUpdatesSchema>[number]
export type InlineKeyboard = { text: string; callback_data: string }[][]

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    readonly code?: number,
    readonly retryAfter?: number
  ) {
    super(message)
    this.name = "TelegramError"
  }
}

async function apiBase() {
  const configuredBase = z
    .url()
    .refine((value) => {
      const url = new URL(value)
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    })
    .safeParse(await getSetting("telegram.apiUrl"))
  if (!configuredBase.success)
    throw new TelegramError(
      "Telegram API URL is invalid; configure an HTTP(S) endpoint without credentials or query parameters",
      false
    )
  return configuredBase.data.replace(/\/+$/, "")
}

export async function callTelegram<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const base = await apiBase()
  let response: Response, value: unknown
  try {
    response = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 30000),
        ...(options.signal ? [options.signal] : []),
      ]),
      cache: "no-store",
      redirect: "error",
    })
    value = await response.json()
  } catch {
    // Fetch errors/cause chains can include the token-bearing URL. Never propagate them.
    throw new TelegramError(
      `Telegram ${method}: transport interrupted; delivery may be unknown`,
      true
    )
  }
  const result = z
    .object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      description: z.string().optional(),
      error_code: z.number().int().optional(),
      parameters: z
        .object({ retry_after: z.number().int().positive().max(86400).optional() })
        .optional(),
    })
    .safeParse(value)
  if (!result.success || (result.data.ok && !Object.hasOwn(result.data, "result")))
    throw new TelegramError(
      `Telegram ${method}: invalid response; delivery may be unknown`,
      true
    )
  if (!result.data.ok) {
    const description = (result.data.description ?? `HTTP ${response.status}`)
      .replaceAll(token, "[redacted]")
      .replaceAll(encodeURIComponent(token), "[redacted]")
      .slice(0, 500)
    throw new TelegramError(
      `Telegram ${method}: ${description}`,
      false,
      result.data.error_code ?? response.status,
      result.data.parameters?.retry_after
    )
  }
  return result.data.result as T
}

// Downloads a picture the person sent: getFile, then the file itself, with a hard size limit.
// Errors never carry the token-bearing URL.
export async function downloadTelegramFile(
  token: string,
  fileId: string,
  maxBytes: number,
  options: { timeoutMs?: number } = {}
) {
  const timeoutMs = options.timeoutMs ?? 30000
  const info = await callTelegram<{ file_path?: string; file_size?: number }>(
    token,
    "getFile",
    { file_id: fileId },
    { timeoutMs }
  )
  if (
    !info.file_path ||
    !/^[\w\-./]+$/.test(info.file_path) ||
    info.file_path.includes("..")
  )
    throw new TelegramError("Telegram getFile: no usable file path", false)
  if ((info.file_size ?? 0) > maxBytes)
    throw new TelegramError("Telegram file is too large", false)
  const base = await apiBase()
  try {
    const response = await fetch(`${base}/file/bot${token}/${info.file_path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    })
    if (!response.ok || !response.body)
      throw new TelegramError(`Telegram file download: HTTP ${response.status}`, false)
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > maxBytes) throw new TelegramError("Telegram file is too large", false)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof TelegramError) throw error
    throw new TelegramError("Telegram file download: transport interrupted", true)
  }
}
