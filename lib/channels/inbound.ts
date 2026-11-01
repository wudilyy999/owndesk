import { db } from "@/db"
import { channelInbound, type ChannelId } from "@/db/schema"

// Saves a received message; returns false when this event was already received.
// Adapters call this from webhooks and pollers and return to the platform right away.
export async function enqueueInbound(input: {
  channel: ChannelId
  eventKey: string
  externalId: string
  text: string
  context?: Record<string, unknown>
}) {
  const rows = await db
    .insert(channelInbound)
    .values({
      channel: input.channel,
      eventKey: input.eventKey,
      externalId: input.externalId,
      text: input.text.slice(0, 4000),
      context: input.context ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: channelInbound.id })
  return rows.length > 0
}
