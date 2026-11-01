// One-time codes: the owner creates one on the web page and sends it to the bot from QQ or
// the official account; WeChat ClawBot is bound by the QR login instead.
import { createHash, randomBytes } from "node:crypto"
import { and, eq, gt, isNull } from "drizzle-orm"
import { db } from "@/db"
import {
  channelLinks,
  channelPairCodes,
  companions,
  type ChannelId,
  type ChannelLink,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const hash = (code: string) =>
  createHash("sha256").update(code.trim().toUpperCase()).digest("hex")

// "绑定 ABCD2345" or "/bind ABCD2345"; the keyword is required so an ordinary word is never taken for a code
export const PAIR_PATTERN = /^\s*\/?(?:bind|pair|绑定)\s*[:：]?\s*([A-Za-z2-9]{8})\s*$/i

export async function createPairCode(ownerId: string, agentId: string, now = new Date()) {
  const [companion] = await db
    .select({ agentId: companions.agentId })
    .from(companions)
    .where(and(eq(companions.agentId, agentId), eq(companions.ownerId, ownerId)))
  if (!companion) throw new HttpError(404, "Companion not found")
  // Only the newest code works
  await db
    .update(channelPairCodes)
    .set({ usedAt: now })
    .where(and(eq(channelPairCodes.agentId, agentId), isNull(channelPairCodes.usedAt)))
  const code = [...randomBytes(8)].map((byte) => ALPHABET[byte % ALPHABET.length]).join("")
  const expiresAt = new Date(now.getTime() + 10 * 60_000)
  await db
    .insert(channelPairCodes)
    .values({ agentId, ownerId, codeHash: hash(code), expiresAt })
  return { code, expiresAt }
}

// Binds the sender to the companion the code was made for. Returns null for a wrong,
// used or expired code.
export async function redeemPairCode(
  channel: ChannelId,
  externalId: string,
  code: string,
  now = new Date()
): Promise<ChannelLink | null> {
  const [row] = await db
    .update(channelPairCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(channelPairCodes.codeHash, hash(code)),
        isNull(channelPairCodes.usedAt),
        gt(channelPairCodes.expiresAt, now)
      )
    )
    .returning()
  if (!row) return null
  return bindChannel({ channel, externalId, agentId: row.agentId, ownerId: row.ownerId })
}

// One person per companion per channel: binding again replaces the earlier account
export async function bindChannel(input: {
  channel: ChannelId
  externalId: string
  agentId: string
  ownerId: string
}) {
  return db.transaction(async (tx) => {
    await tx
      .delete(channelLinks)
      .where(
        and(eq(channelLinks.channel, input.channel), eq(channelLinks.externalId, input.externalId))
      )
    await tx
      .delete(channelLinks)
      .where(and(eq(channelLinks.channel, input.channel), eq(channelLinks.agentId, input.agentId)))
    const [link] = await tx.insert(channelLinks).values(input).returning()
    return link
  })
}

export async function unbindChannel(ownerId: string, agentId: string, channel: ChannelId) {
  const rows = await db
    .delete(channelLinks)
    .where(
      and(
        eq(channelLinks.ownerId, ownerId),
        eq(channelLinks.agentId, agentId),
        eq(channelLinks.channel, channel)
      )
    )
    .returning({ id: channelLinks.id })
  return rows.length > 0
}
