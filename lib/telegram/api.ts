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

export async function callTelegram<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
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
  const base = configuredBase.data.replace(/\/+$/, "")
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
