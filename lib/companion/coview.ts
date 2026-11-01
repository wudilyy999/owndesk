// Link co-viewing: the person sends a link in chat; she opens it on her own computer
// (in her own browser profile), reads it and answers like a friend would. The request waits
// here while she is asleep or away or the desktop is busy, and expires after a day.
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { and, eq, gt, sql } from "drizzle-orm"
import { db, pool } from "@/db"
import {
  agents,
  companionMessages,
  companions,
  coviewRequests,
  tasks,
  type Companion,
} from "@/db/schema"
import { findPrice } from "@/lib/providers/pricing"
import { resolveModelSpec } from "@/lib/providers/registry"
import { getCustomPrices } from "@/lib/spend"
import { submitTask } from "@/lib/tasks"
import { rhythmAt } from "./rules"

const EXPIRY_MS = 24 * 3600_000
const DAILY_LIMIT = 10
const SESSION_STEPS = 12

export function extractLink(text: string) {
  const match = text.match(/https?:\/\/[^\s<>"'“”‘’，。！？、）)]+/i)
  return match ? match[0].replace(/[.,;:!?]+$/, "") : null
}

// A link the box must not open: other protocols, credentials in the address, and anything
// that names this machine or a private network
export function isPrivateAddress(address: string) {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7))
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    )
  }
  const [a, b] = address.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

export function isPublicUrl(raw: string) {
  const url = new URL(raw)
  if (!["http:", "https:"].includes(url.protocol)) return false
  if (url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (isIP(host)) return !isPrivateAddress(host)
  return (
    host.includes(".") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal") &&
    !host.endsWith(".localhost") &&
    host !== "localhost"
  )
}

// Names that resolve to a private address are refused too
export async function linkIsOpenable(raw: string, resolve = lookup) {
  if (!isPublicUrl(raw)) return false
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "")
  if (isIP(host)) return true
  try {
    return !(await resolve(host, { all: true })).some((a) => isPrivateAddress(a.address))
  } catch {
    return false
  }
}

export type CoviewOffer = { url: string; queued: boolean }

export async function queueCoview(
  agentId: string,
  text: string,
  now = new Date(),
  check = linkIsOpenable
): Promise<CoviewOffer | null> {
  const url = extractLink(text)
  if (!url) return null
  if (!(await check(url))) return { url, queued: false }
  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(coviewRequests)
    .where(
      and(
        eq(coviewRequests.agentId, agentId),
        gt(coviewRequests.createdAt, new Date(now.getTime() - EXPIRY_MS))
      )
    )
  if (recent.count >= DAILY_LIMIT) return { url, queued: false }
  await db.insert(coviewRequests).values({ agentId, url, createdAt: now })
  return { url, queued: true }
}

export function coviewPrompt(companion: Companion, name: string, url: string, now: Date) {
  return `你是${name}。${companion.persona.background}
性格：${companion.persona.personality}；说话方式：${companion.persona.speakingStyle}。
现在是 ${now.toISOString()}。对方刚刚发给你一个链接：${url}
在你自己的电脑上打开它，认真看一看（读文字，需要时往下翻或点进去）。然后只调用一次 coview_reply，像微信回复朋友那样说你真实的看法：一两句，口语，只讲你在页面上真的看到的内容。页面有值得给对方看的画面时，可以带上 screenshotPageId 附一张截图；页面里有个人信息或登录内容就不要附。
如果页面打不开或要登录才能看，如实说看不了，不要编。`
}

// Expired requests are dropped; requests whose session ended without a reply say so once
export async function syncCoviews(now = new Date()) {
  await db
    .update(coviewRequests)
    .set({ status: "skipped" })
    .where(
      and(
        eq(coviewRequests.status, "pending"),
        sql`${coviewRequests.createdAt} < ${new Date(now.getTime() - EXPIRY_MS)}`
      )
    )
  const open = await db
    .select({ request: coviewRequests, taskStatus: tasks.status })
    .from(coviewRequests)
    .innerJoin(tasks, eq(tasks.id, coviewRequests.taskId))
    .where(eq(coviewRequests.status, "started"))
  for (const { request, taskStatus } of open) {
    if (!["completed", "failed", "cancelled"].includes(taskStatus)) continue
    // A session cut short by the person's own errand tries again later
    if (taskStatus === "cancelled") {
      await db
        .update(coviewRequests)
        .set({ status: "pending", taskId: null })
        .where(eq(coviewRequests.id, request.id))
      continue
    }
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(coviewRequests)
        .set({ status: "skipped" })
        .where(
          and(eq(coviewRequests.id, request.id), eq(coviewRequests.status, "started"))
        )
        .returning({ id: coviewRequests.id })
      if (!claimed.length) return
      await tx.insert(companionMessages).values({
        agentId: request.agentId,
        role: "assistant",
        kind: "coview",
        content:
          "刚才那个链接我没能看成。你可以直接告诉我里面讲了什么，或者过会儿再发一次。",
        metadata: { url: request.url, failed: true },
        channel: "web",
      })
    })
  }
}

export async function startCoviews(now = new Date()) {
  const started: string[] = []
  const rows = await db
    .select({ companion: companions, name: agents.name, model: agents.model })
    .from(companions)
    .innerJoin(agents, eq(agents.id, companions.agentId))
  for (const { companion, name, model } of rows) {
    const [request] = await db
      .select()
      .from(coviewRequests)
      .where(
        and(
          eq(coviewRequests.agentId, companion.agentId),
          eq(coviewRequests.status, "pending")
        )
      )
      .orderBy(coviewRequests.createdAt)
      .limit(1)
    if (!request) continue
    if (rhythmAt(now, companion.timeZone, companion.rhythm).state !== "online") continue
    const busy = await pool.query(
      "SELECT 1 FROM tasks WHERE agent_id=$1 AND status NOT IN ('completed','failed','cancelled') LIMIT 1",
      [companion.agentId]
    )
    if (busy.rowCount) continue
    const spec = await resolveModelSpec(model)
    if (!spec || !findPrice(spec, { custom: await getCustomPrices() })) continue
    const result = await submitTask(companion.ownerId, "life", {
      agentId: companion.agentId,
      goal: "看一下对方发来的链接。",
      // A session cancelled by an errand is retried, so each start needs its own key
      clientRequestId: `coview:${request.id}:${now.getTime()}`,
      timeZone: companion.timeZone,
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: SESSION_STEPS, maxCostMicros: companion.lifeDailyBudgetMicros },
      lifeSession: {
        prompt: coviewPrompt(companion, name, request.url, now),
        coview: { requestId: request.id, url: request.url },
      },
    })
    await db
      .update(coviewRequests)
      .set({ status: "started", taskId: result.taskId })
      .where(eq(coviewRequests.id, request.id))
    started.push(result.taskId)
  }
  return started
}
