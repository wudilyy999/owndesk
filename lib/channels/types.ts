import type { ChannelId, ChannelLink } from "@/db/schema"

export type { ChannelId }
export type OutboundKind = "reply" | "share" | "update"
export type SendPlan = { mode: "send" } | { mode: "hold"; reason: string }
export type OutboundItem = {
  id: string
  kind: OutboundKind
  text: string
  context: Record<string, unknown> | null
}

// `hold` means the platform does not allow this send now: the item waits and is
// folded into her next reply instead. `retryable` errors are tried again later.
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly options: { retryable?: boolean; hold?: boolean; code?: string | number } = {}
  ) {
    super(message)
    this.name = "ChannelSendError"
  }
  get retryable() {
    return this.options.retryable ?? false
  }
  get hold() {
    return this.options.hold ?? false
  }
}

export type InboundContext = Record<string, unknown>

export interface ChannelAdapter {
  id: ChannelId
  label: string
  // Longest text one message may carry; longer texts are cut at line breaks
  maxLength: number
  // Whether she may reach out when the person has not just written
  proactive: "free" | "limited" | "never"
  plan(
    link: ChannelLink,
    kind: OutboundKind,
    now: Date,
    context?: Record<string, unknown> | null
  ): SendPlan
  // Returns a patch for channel_links.state
  send(
    link: ChannelLink,
    item: OutboundItem,
    now: Date
  ): Promise<Record<string, unknown> | void>
  // Reply context to remember from an inbound message (msg_id, context_token, ...)
  onInbound(
    link: ChannelLink,
    context: InboundContext,
    now: Date
  ): Record<string, unknown>
  // Answer someone who has not been bound yet
  sendUnlinked(externalId: string, context: InboundContext, text: string): Promise<void>
}

export function chunkText(text: string, max: number) {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max)
    if (cut < max / 2) cut = rest.lastIndexOf("。", max)
    if (cut < max / 2) cut = max
    else cut += 1
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}
