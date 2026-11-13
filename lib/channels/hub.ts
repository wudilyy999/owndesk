// The channel layer: every channel (web, Telegram, QQ, WeChat) reads and writes the same
// companion_messages and memories through companionChat, so she is one person everywhere.
//
//   inbound   adapter/webhook -> channel_inbound -> processInbound -> companionChat -> channel_outbox
//   outbound  background messages (shares, errand updates, co-view) -> channel_outbox per link
//   delivery  deliverOutbox sends what the platform allows now; the rest is `held` and is folded
//             into her next reply (awayDigest), so passive-only channels still hear everything
import { and, asc, eq, gt, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm"
import { db, pool } from "@/db"
import {
  channelInbound,
  channelLinks,
  channelOutbox,
  companionMessages,
  companions,
  type ChannelInbound,
  type ChannelLink,
  type CompanionMessage,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { receiveImage } from "./media"
import { companionChat, type ChatDeps } from "@/lib/companion/chat"
import { realSleep } from "@/lib/companion/pacing"
import { PAIR_PATTERN, bindChannel, redeemPairCode } from "./pairing"
import { adapters } from "./registry"
import { ChannelSendError, type OutboundKind } from "./types"

const MAX_ATTEMPTS = 5
const MAX_INBOUND_ATTEMPTS = 3
const FOLDED_LIMIT = 6

export const UNBOUND_TEXT =
  "还没认出你。到网页聊天页的「聊天软件」里生成绑定码，然后发给我：绑定 + 空格 + 绑定码"
export const BOUND_TEXT = "绑定好了，以后在这里也能找到我。"
export const FAILED_TEXT = "我这边卡了一下，等会儿再说一次好吗？"

// What a companion_messages row looks like as plain text on a channel; null = web only
export function renderMessage(
  message: Pick<CompanionMessage, "kind" | "content" | "metadata">
) {
  switch (message.kind) {
    case "errand_proposal": {
      const goal = (message.metadata as { goal?: string } | null)?.goal ?? message.content
      return `要我去电脑上办「${goal}」的话，在网页聊天页点一下确认就开始。`
    }
    case "objective_proposal":
      return `要我长期去做「${message.content}」的话，在网页聊天页点一下确认就开始。`
    case "memory_candidate":
    case "memory_merge":
      return null
    default:
      return message.content
  }
}

// "正在输入" on a channel: best effort, short, and never in the way of her answer
async function showTyping(
  link: ChannelLink,
  context: Record<string, unknown>,
  now: Date,
  used: { count: number }
) {
  const adapter = adapters[link.channel]
  if (!adapter.typing || used.count >= (adapter.typingBudget ?? Infinity)) return
  used.count++
  try {
    const patch = await adapter.typing((await getLink(link.id)) ?? link, context, now)
    if (patch && Object.keys(patch).length) await setLinkState(link.id, patch)
  } catch (error) {
    console.error(`${link.channel} typing failed`, (error as Error).message)
  }
}

const kindOf = (message: Pick<CompanionMessage, "kind">): OutboundKind =>
  message.kind === "share" || message.kind === "coview" ? "share" : "update"

async function setLinkState(linkId: string, patch: Record<string, unknown>, extra = {}) {
  await db
    .update(channelLinks)
    .set({
      state: sql`${channelLinks.state} || ${JSON.stringify(patch)}::jsonb`,
      ...extra,
    })
    .where(eq(channelLinks.id, linkId))
}

async function getLink(id: string) {
  const [link] = await db.select().from(channelLinks).where(eq(channelLinks.id, id))
  return link as ChannelLink | undefined
}

// ───────────────────────── outbound ─────────────────────────

// Queues her background messages for every linked channel (idempotent)
export async function routeBackgroundMessages() {
  const links = await db.select().from(channelLinks)
  let queued = 0
  for (const link of links) {
    const rows = await db
      .select()
      .from(companionMessages)
      .where(
        and(
          eq(companionMessages.agentId, link.agentId),
          eq(companionMessages.role, "assistant"),
          inArray(companionMessages.kind, ["share", "errand_update", "coview"]),
          gt(companionMessages.createdAt, link.createdAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(channelOutbox)
              .where(
                and(
                  eq(channelOutbox.linkId, link.id),
                  eq(channelOutbox.messageId, companionMessages.id)
                )
              )
          )
        )
      )
      .orderBy(asc(companionMessages.createdAt))
      .limit(20)
    for (const message of rows) {
      const text = renderMessage(message)
      if (!text) continue
      const inserted = await db
        .insert(channelOutbox)
        .values({ linkId: link.id, messageId: message.id, kind: kindOf(message), text })
        .onConflictDoNothing()
        .returning({ id: channelOutbox.id })
      queued += inserted.length
    }
  }
  return queued
}

// Sends what is pending; returns how many were sent. A failed item blocks the later items of the
// same person so her messages stay in order.
// Paced replies are sent by the process that answered and by the tick; one delivery at a
// time per process keeps a due bubble from going out twice.
let deliveryQueue: Promise<unknown> = Promise.resolve()
export function deliverOutbox(now = new Date(), limit = 50) {
  const run = deliveryQueue.then(() => deliverDue(now, limit))
  deliveryQueue = run.catch(() => {})
  return run
}

async function deliverDue(now: Date, limit: number) {
  const rows = await db
    .select()
    .from(channelOutbox)
    .where(
      and(
        eq(channelOutbox.status, "pending"),
        or(isNull(channelOutbox.notBefore), lte(channelOutbox.notBefore, now))
      )
    )
    .orderBy(asc(channelOutbox.createdAt))
    .limit(limit)
  const blocked = new Set<string>()
  let sent = 0
  for (const row of rows) {
    if (blocked.has(row.linkId)) continue
    const link = await getLink(row.linkId)
    if (!link) continue
    const adapter = adapters[link.channel]
    const hold = async (reason: string) => {
      // A reply that cannot be sent is lost; anything else waits for her next reply
      await db
        .update(channelOutbox)
        .set(
          row.kind === "reply"
            ? { status: "failed", lastError: reason }
            : { status: "held", lastError: reason }
        )
        .where(eq(channelOutbox.id, row.id))
    }
    const plan = adapter.plan(link, row.kind, now, row.context)
    if (plan.mode === "hold") {
      await hold(plan.reason)
      continue
    }
    try {
      const patch = await adapter.send(
        link,
        { id: row.id, kind: row.kind, text: row.text, context: row.context },
        now
      )
      if (patch && Object.keys(patch).length) await setLinkState(link.id, patch)
      await db
        .update(channelOutbox)
        .set({ status: "sent", sentAt: now, lastError: null })
        .where(eq(channelOutbox.id, row.id))
      sent++
    } catch (error) {
      const failure =
        error instanceof ChannelSendError
          ? error
          : new ChannelSendError((error as Error).message, { retryable: true })
      if (failure.hold) {
        await hold(failure.message)
      } else if (failure.retryable && row.attempts + 1 < MAX_ATTEMPTS) {
        await db
          .update(channelOutbox)
          .set({
            attempts: row.attempts + 1,
            lastError: failure.message,
            notBefore: new Date(now.getTime() + 5_000 * 2 ** row.attempts),
          })
          .where(eq(channelOutbox.id, row.id))
        blocked.add(row.linkId)
      } else {
        await db
          .update(channelOutbox)
          .set({
            status: "failed",
            attempts: row.attempts + 1,
            lastError: failure.message,
          })
          .where(eq(channelOutbox.id, row.id))
      }
    }
  }
  return sent
}

// ───────────────────────── inbound ─────────────────────────

export async function claimInbound(limit = 5) {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE channel_inbound SET status='processing',attempts=attempts+1
     WHERE id IN (SELECT id FROM channel_inbound WHERE status='pending'
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING id`,
    [limit]
  )
  if (!rows.length) return []
  return db
    .select()
    .from(channelInbound)
    .where(
      inArray(
        channelInbound.id,
        rows.map((row) => row.id)
      )
    )
    .orderBy(asc(channelInbound.createdAt))
}

// A message that was being processed when the worker died is tried again
export async function recoverInbound(olderThanMs = 5 * 60_000) {
  await pool.query(
    `UPDATE channel_inbound SET status='pending'
     WHERE status='processing' AND created_at < now() - ($1 || ' milliseconds')::interval`,
    [olderThanMs]
  )
}

async function reply(inbound: ChannelInbound, text: string) {
  try {
    await adapters[inbound.channel].sendUnlinked(
      inbound.externalId,
      inbound.context,
      text
    )
  } catch (error) {
    console.error(`${inbound.channel} reply failed`, (error as Error).message)
  }
}

export async function processInbound(
  inbound: ChannelInbound,
  deps: ChatDeps = {},
  now = new Date()
) {
  const finish = (status: "done" | "failed", lastError: string | null = null) =>
    db
      .update(channelInbound)
      .set({ status, lastError, processedAt: new Date() })
      .where(eq(channelInbound.id, inbound.id))
  const trusted = inbound.context as {
    trusted?: boolean
    agentId?: string
    ownerId?: string
  }
  let [link] = await db
    .select()
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, inbound.channel),
        eq(channelLinks.externalId, inbound.externalId)
      )
    )
  // The Telegram bridge has already paired this chat with the owner
  if (!link && trusted.trusted && trusted.agentId && trusted.ownerId)
    link = await bindChannel({
      channel: inbound.channel,
      externalId: inbound.externalId,
      agentId: trusted.agentId,
      ownerId: trusted.ownerId,
    })
  if (!link) {
    const code = PAIR_PATTERN.exec(inbound.text)?.[1]
    const bound = code
      ? await redeemPairCode(inbound.channel, inbound.externalId, code, now)
      : null
    if (bound) {
      const patch = adapters[bound.channel].onInbound(bound, inbound.context, now)
      await setLinkState(bound.id, patch, { lastInboundAt: now })
      // Through the outbox so reply numbering (QQ msg_seq) stays in order
      await db.insert(channelOutbox).values({
        linkId: bound.id,
        kind: "reply",
        text: BOUND_TEXT,
        context: inbound.context,
      })
      await deliverOutbox(now)
    } else
      await reply(
        inbound,
        code ? "绑定码不对或已过期，请在网页重新生成一个。" : UNBOUND_TEXT
      )
    await finish("done")
    return "unbound" as const
  }

  const adapter = adapters[link.channel]
  // Remember how to answer (QQ msg_id, WeChat context_token) before anything slow happens
  const patch = adapter.onInbound(link, inbound.context, now)
  await setLinkState(link.id, patch, { lastInboundAt: now })
  link = (await getLink(link.id))!

  const held = await db
    .select()
    .from(channelOutbox)
    .where(and(eq(channelOutbox.linkId, link.id), eq(channelOutbox.status, "held")))
    .orderBy(asc(channelOutbox.createdAt))
  const [{ pace }] = await db
    .select({ pace: companions.typingPace })
    .from(companions)
    .where(eq(companions.agentId, link.agentId))
    .then((rows) => (rows.length ? rows : [{ pace: "natural" as const }]))
  const typingUsed = { count: 0 }
  // Shown while the model works; the bubbles below are paced by their schedule
  if (pace !== "off") await showTyping(link, inbound.context, now, typingUsed)
  try {
    // A picture that came with the message (Telegram photo, QQ image)
    const picture = await receiveImage(link.agentId, inbound.context)
    const { replies, schedule } = await companionChat(
      {
        ownerId: link.ownerId,
        agentId: link.agentId,
        imageId: picture.imageId,
        text: picture.failed
          ? [inbound.text, "（发来了一张图片，但没能收下来，你看不到）"]
              .filter(Boolean)
              .join("\n")
          : inbound.text,
        channel: link.channel,
        awayDigest: held.slice(-FOLDED_LIMIT).map((item) => item.text),
      },
      deps,
      undefined
    )
    if (held.length)
      await db
        .update(channelOutbox)
        .set({ status: "bundled", sentAt: now })
        .where(
          inArray(
            channelOutbox.id,
            held.map((item) => item.id)
          )
        )
    for (const [index, message] of replies.entries()) {
      const text = renderMessage(message)
      if (!text) continue
      await db
        .insert(channelOutbox)
        .values({
          linkId: link.id,
          messageId: message.id,
          kind: "reply",
          text,
          context: inbound.context,
          // Bubbles of one reply are 1 ms apart; keeping that order makes delivery order stable
          createdAt: message.createdAt,
          // Later bubbles wait for their turn; the tick sends them if this process dies
          notBefore: schedule[index] ? new Date(now.getTime() + schedule[index]) : null,
        })
        .onConflictDoNothing()
    }
    await finish("done")
    await deliverOutbox(now)
    await playBubbles(link, inbound.context, now, schedule, typingUsed, deps)
    return "answered" as const
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Budget or configuration problems will not fix themselves: say so once, do not retry
    const final = error instanceof HttpError || inbound.attempts >= MAX_INBOUND_ATTEMPTS
    if (!final) {
      await db
        .update(channelInbound)
        .set({ status: "pending", lastError: message })
        .where(eq(channelInbound.id, inbound.id))
      return "retry" as const
    }
    await reply(inbound, error instanceof HttpError ? message : FAILED_TEXT)
    await finish("failed", message)
    return "failed" as const
  }
}

// Waits for each moment of the reply schedule, shows typing, then sends what is due
async function playBubbles(
  link: ChannelLink,
  context: Record<string, unknown>,
  now: Date,
  schedule: number[],
  typingUsed: { count: number },
  deps: ChatDeps
) {
  const sleep = deps.sleep ?? realSleep
  const moments = [...new Set(schedule.filter((ms) => ms > 0))].sort((a, b) => a - b)
  let elapsed = 0
  for (const at of moments) {
    await showTyping(link, context, new Date(now.getTime() + elapsed), typingUsed)
    await sleep(at - elapsed)
    elapsed = at
    await deliverOutbox(new Date(now.getTime() + at))
  }
  const adapter = adapters[link.channel]
  if (moments.length && adapter.stopTyping)
    await adapter
      .stopTyping((await getLink(link.id)) ?? link, context, now)
      .catch(() => {})
}

export async function processPendingInbound(deps: ChatDeps = {}, now = new Date()) {
  const rows = await claimInbound()
  const results = await Promise.all(
    rows.map((row) =>
      processInbound(row, deps, now).catch(async (error) => {
        console.error("channel inbound failed", error)
        await db
          .update(channelInbound)
          .set({
            status: row.attempts >= MAX_INBOUND_ATTEMPTS ? "failed" : "pending",
            lastError: (error as Error).message,
          })
          .where(eq(channelInbound.id, row.id))
        return "failed" as const
      })
    )
  )
  return results.length
}

// Called by the worker every few seconds
export async function channelTick(now = new Date()) {
  await recoverInbound()
  await processPendingInbound({}, now)
  await routeBackgroundMessages()
  await deliverOutbox(now)
}
