// Web Push: a notification on the person's phone or browser when she writes while the chat page
// is not open. Standard Web Push with VAPID (RFC 8030 / 8292) through the `web-push` package
// (MPL-2.0, used unmodified as a dependency). Only background messages notify; her replies to a
// message the person just sent are already on screen.
//
//   worker tick -> pushTick -> pending background messages -> quiet hours / viewing checks
//               -> web-push -> browser push service (FCM, Mozilla, Apple, ...) -> sw.js shows it
import { createHash } from "node:crypto"
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  min,
  notExists,
  or,
  sql,
} from "drizzle-orm"
import webpush from "web-push"
import { db } from "@/db"
import {
  agents,
  companionMessages,
  companions,
  pushDeliveries,
  pushSubscriptions,
  type Companion,
  type CompanionMessage,
  type PushSubscriptionRow,
} from "@/db/schema"
import { env } from "@/lib/env"
import { HttpError } from "@/lib/errors"
import { inQuietHours, rhythmAt } from "./rules"

// Messages she starts herself or that arrive after the person left (not replies to a message)
export const PUSH_KINDS = ["share", "errand_update", "coview"] as const
// A chat page that reported itself open this recently counts as "looking at it"
export const VIEWING_MS = 60_000
// A message nobody could be notified about for this long is not worth a late buzz
export const PUSH_EXPIRY_MS = 12 * 3600_000
// Held back by quiet hours / sleep: sent when it ends, unless it is already this old
export const QUIET_EXPIRY_MS = 6 * 3600_000
export const MAX_FAILURES = 5
const PREVIEW_CHARS = 60
const HIDDEN_BODY = "发来一条消息"

export type PushConfig = { publicKey: string; privateKey: string; subject: string }

export function pushConfig(): PushConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null
  const subject =
    env.VAPID_SUBJECT ??
    (env.APP_URL.startsWith("https:") ? env.APP_URL : "mailto:owndesk@localhost.invalid")
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject }
}

// ───────────────────────── subscriptions ─────────────────────────

export type BrowserSubscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// The server posts to this address, so it must be a public https push service, never an
// internal host (the owner is the only one who can add it, but the check is cheap).
export function checkEndpoint(endpoint: string) {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new HttpError(400, "The push address is not a valid URL")
  }
  const host = url.hostname.toLowerCase()
  const internal =
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    !host.includes(".")
  if (internal)
    throw new HttpError(400, "The push address must be a public https address")
  return url.toString()
}

export async function saveSubscription(
  agentId: string,
  subscription: BrowserSubscription,
  userAgent: string | null
) {
  const endpoint = checkEndpoint(subscription.endpoint)
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      agentId,
      endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      // The same browser subscribing again: new keys, a clean record
      set: {
        agentId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
        failures: 0,
      },
    })
    .returning()
  return row
}

export async function removeSubscription(agentId: string, endpoint: string) {
  const removed = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.agentId, agentId),
        eq(pushSubscriptions.endpoint, endpoint)
      )
    )
    .returning({ id: pushSubscriptions.id })
  return removed.length
}

export async function listSubscriptions(agentId: string) {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.agentId, agentId))
    .orderBy(asc(pushSubscriptions.createdAt))
}

// "Chrome on Linux" etc. for the device list; never the endpoint itself
export function deviceLabel(userAgent: string | null) {
  const ua = userAgent ?? ""
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "浏览器"
  const system = /iPhone|iPad/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : ""
  return system ? `${browser} · ${system}` : browser
}
export const endpointId = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex").slice(0, 12)

// ───────────────────────── presence ─────────────────────────

// Called every ~20 s by a chat page that is visible
export async function recordSeen(agentId: string, now = new Date()) {
  await db
    .update(companions)
    .set({ webSeenAt: now })
    .where(eq(companions.agentId, agentId))
}

// ───────────────────────── what the notification says ─────────────────────────

export type PushPayload = {
  title: string
  body: string
  url: string
  tag: string
}

// One line of her message: links, line breaks and long text removed
export function previewLine(content: string) {
  const text = content
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const chars = [...text]
  return chars.length > PREVIEW_CHARS
    ? `${chars.slice(0, PREVIEW_CHARS).join("")}…`
    : text
}

export function buildPayload(
  name: string,
  messages: Pick<CompanionMessage, "id" | "kind" | "content">[],
  preview: boolean
): PushPayload {
  const latest = messages[messages.length - 1]
  const line = preview ? previewLine(latest.content) : ""
  const body =
    messages.length > 1
      ? preview && line
        ? `[${messages.length}条] ${line}`
        : `发来 ${messages.length} 条消息`
      : line || HIDDEN_BODY
  return { title: name, body, url: "/companion", tag: `msg-${latest.id}` }
}

// ───────────────────────── sending ─────────────────────────

export type PushSender = (
  subscription: BrowserSubscription,
  payload: string,
  config: PushConfig
) => Promise<{ statusCode: number }>

export const sendWebPush: PushSender = async (subscription, payload, config) => {
  const response = await webpush.sendNotification(subscription, payload, {
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    },
    TTL: 3600,
    urgency: "normal",
    timeout: 15_000,
  })
  return { statusCode: response.statusCode }
}

const GONE = new Set([404, 410])

async function sendToDevices(
  subscriptions: PushSubscriptionRow[],
  payload: PushPayload,
  sender: PushSender,
  config: PushConfig,
  now: Date
) {
  let sent = 0
  let gone = 0
  let failed = 0
  for (const sub of subscriptions) {
    try {
      await sender(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        config
      )
      sent++
      await db
        .update(pushSubscriptions)
        .set({ lastSentAt: now, failures: 0 })
        .where(eq(pushSubscriptions.id, sub.id))
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status !== undefined && GONE.has(status)) {
        // The browser or phone unsubscribed: forget it
        gone++
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id))
      } else {
        failed++
        console.error(
          `push to ${endpointId(sub.endpoint)} failed (${status ?? (error as Error).message})`
        )
        const failures = sub.failures + 1
        if (failures >= MAX_FAILURES)
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id))
        else
          await db
            .update(pushSubscriptions)
            .set({ failures })
            .where(eq(pushSubscriptions.id, sub.id))
      }
    }
  }
  return { sent, gone, failed }
}

// "Send a test" in settings: goes out at once, to every device of this companion
export async function sendTestPush(
  agentId: string,
  name: string,
  preview: boolean,
  sender: PushSender = sendWebPush,
  now = new Date()
) {
  const config = pushConfig()
  if (!config) throw new HttpError(409, "Notifications are not set up on this server")
  const subscriptions = await listSubscriptions(agentId)
  if (!subscriptions.length)
    throw new HttpError(409, "No device has allowed notifications")
  const payload: PushPayload = {
    title: name,
    body: preview ? "收到啦，通知是开着的" : HIDDEN_BODY,
    url: "/companion",
    tag: `test-${now.getTime()}`,
  }
  return sendToDevices(subscriptions, payload, sender, config, now)
}

// ───────────────────────── the tick ─────────────────────────

export type PushDecision =
  { action: "send" } | { action: "skip"; reason: string } | { action: "wait" }

// Pure: should this background message notify now? Quiet hours and sleep hold it back (and it
// goes out when they end); a page that is open, or was opened after the message, makes it moot.
export function decidePush(input: {
  now: Date
  message: Pick<CompanionMessage, "createdAt">
  companion: Pick<
    Companion,
    "quietStart" | "quietEnd" | "timeZone" | "rhythm" | "webSeenAt"
  >
}): PushDecision {
  const { now, message, companion } = input
  const age = now.getTime() - message.createdAt.getTime()
  if (age > PUSH_EXPIRY_MS) return { action: "skip", reason: "expired" }
  const seen = companion.webSeenAt
  if (seen && seen.getTime() >= message.createdAt.getTime())
    return { action: "skip", reason: "seen" }
  if (seen && now.getTime() - seen.getTime() < VIEWING_MS)
    return { action: "skip", reason: "viewing" }
  const quiet =
    inQuietHours(now, companion.timeZone, companion.quietStart, companion.quietEnd) ||
    rhythmAt(now, companion.timeZone, companion.rhythm).state === "asleep"
  if (quiet)
    return age > QUIET_EXPIRY_MS
      ? { action: "skip", reason: "quiet" }
      : { action: "wait" }
  return { action: "send" }
}

export type PushTickResult = {
  agentId: string
  sent: number
  skipped: number
  devices: number
}

export async function pushTick(
  now = new Date(),
  sender: PushSender = sendWebPush
): Promise<PushTickResult[]> {
  const config = pushConfig()
  if (!config) return []
  const results: PushTickResult[] = []
  const owners = await db
    .select({
      agentId: pushSubscriptions.agentId,
      since: min(pushSubscriptions.createdAt),
    })
    .from(pushSubscriptions)
    .groupBy(pushSubscriptions.agentId)
  for (const { agentId, since } of owners) {
    const [companion] = await db
      .select()
      .from(companions)
      .where(eq(companions.agentId, agentId))
    if (!companion || !since) continue
    const name = await agentName(agentId)
    const pending = await db
      .select()
      .from(companionMessages)
      .where(
        and(
          eq(companionMessages.agentId, agentId),
          eq(companionMessages.role, "assistant"),
          inArray(companionMessages.kind, [...PUSH_KINDS]),
          isNull(companionMessages.supersededAt),
          // Nothing from before the first device was added, and only what has been shown
          gt(companionMessages.createdAt, since),
          or(isNull(companionMessages.revealAt), lte(companionMessages.revealAt, now)),
          notExists(
            db
              .select({ one: sql`1` })
              .from(pushDeliveries)
              .where(eq(pushDeliveries.messageId, companionMessages.id))
          )
        )
      )
      .orderBy(asc(companionMessages.createdAt))
      .limit(10)
    const toSend: CompanionMessage[] = []
    let skipped = 0
    for (const message of pending) {
      const decision = decidePush({ now, message, companion })
      if (decision.action === "send") toSend.push(message)
      else if (decision.action === "skip") {
        skipped++
        await db
          .insert(pushDeliveries)
          .values({
            messageId: message.id,
            agentId,
            status: "skipped",
            reason: decision.reason,
          })
          .onConflictDoNothing()
      }
    }
    let devices = 0
    if (toSend.length) {
      const subscriptions = await listSubscriptions(agentId)
      const payload = buildPayload(name, toSend, companion.pushPreview)
      const outcome = await sendToDevices(subscriptions, payload, sender, config, now)
      devices = outcome.sent
      // Every device failing for a passing reason leaves the messages for the next tick
      if (outcome.sent > 0 || outcome.failed === 0) {
        await db
          .insert(pushDeliveries)
          .values(
            toSend.map((message) => ({
              messageId: message.id,
              agentId,
              status: outcome.sent > 0 ? ("sent" as const) : ("skipped" as const),
              reason: outcome.sent > 0 ? null : "no device",
              devices: outcome.sent,
            }))
          )
          .onConflictDoNothing()
      }
    }
    const sentCount = devices > 0 ? toSend.length : 0
    if (sentCount || skipped) results.push({ agentId, sent: sentCount, skipped, devices })
  }
  return results
}

async function agentName(agentId: string) {
  const [row] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
  return row?.name ?? "她"
}
