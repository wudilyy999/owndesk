// Light chat path: one model call per message, no durable task, no workstation.
// Errands are only proposed here; the person confirms them in the UI (lib/companion/errands.ts).
import { streamText, tool, isStepCount, type LanguageModel, type ModelMessage } from "ai"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import {
  agents,
  companionMessages,
  companionUsage,
  lifeActivities,
  memories,
  type CompanionMessage,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import {
  createModel,
  getProviderCredentials,
  resolveModelSpec,
} from "@/lib/providers/registry"
import { parseModelSpec } from "@/lib/providers/catalog"
import { getSetting } from "@/lib/config"
import { getCustomPrices, monthlyBlock, monthlyUsage } from "@/lib/spend"
import { crisisReply, detectCrisis } from "./crisis"
import { addNote, deleteNote, listNotes, selectNotes, updateNote } from "./memory"
import { buildCompanionPrompt } from "./persona"
import { queueCoview } from "./coview"
import { playbackSchedule, realSleep, visibleMessage } from "./pacing"
import { rhythmAt } from "./rules"
import { ensureCompanion } from "./store"

const HISTORY = 30
const MAX_BUBBLES = 4

export type ChatEvent =
  | { type: "user"; message: CompanionMessage }
  // She is "typing": from when the model starts until the next bubble appears
  | { type: "typing"; on: boolean }
  | { type: "delta"; text: string }
  | { type: "messages"; messages: CompanionMessage[] }
  // The latest turn was redone: these messages are hidden now
  | { type: "superseded"; ids: string[] }

export type ChatDeps = {
  model?: LanguageModel
  // Spec used to price the call when a model is injected
  spec?: string
  price?: Price | null
  now?: Date
  linkCheck?: Parameters<typeof queueCoview>[3]
  // Typing rhythm. `playback` makes companionChat itself wait between bubbles and emit them one
  // by one (web); without it all bubbles are returned at once with their `schedule` (channels).
  playback?: boolean
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export const MAX_REDO = 3

// A reply with blank lines becomes separate chat bubbles, like a person sending several texts
export function splitBubbles(text: string) {
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= MAX_BUBBLES) return parts
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")]
}

export function historyMessages(rows: CompanionMessage[]): ModelMessage[] {
  return rows.map((row) => ({
    role: row.role,
    content:
      row.kind === "errand_proposal"
        ? `（我提出了一个任务，等你确认：${(row.metadata as { goal?: string }).goal}）`
        : row.content,
  }))
}

type NewMessage = Pick<
  CompanionMessage,
  "role" | "kind" | "content" | "channel" | "metadata"
> & { revealAt?: Date | null }

async function insertMessages(agentId: string, rows: NewMessage[], start = new Date()) {
  // Distinct timestamps keep bubbles in order
  return db
    .insert(companionMessages)
    .values(
      rows.map((row, index) => ({
        agentId,
        ...row,
        createdAt: new Date(start.getTime() + index),
      }))
    )
    .returning()
}

const REDOABLE_KINDS = new Set(["chat", "memory_candidate", "errand_proposal"])

// The latest turn (her last user message and what she answered) is the only one that can be
// redone: older turns have already shaped her notes and the timeline.
export async function latestRound(agentId: string) {
  const rows = await db
    .select()
    .from(companionMessages)
    // Bubbles that are still being "typed" count too, so a redo hides them as well
    .where(
      and(eq(companionMessages.agentId, agentId), isNull(companionMessages.supersededAt))
    )
    .orderBy(desc(companionMessages.createdAt), desc(companionMessages.id))
    .limit(14)
  const at = rows.findIndex((row) => row.role === "user")
  if (at === -1) throw new HttpError(409, "没有可以重来的话")
  const user = rows[at]
  const replies = rows.slice(0, at).reverse()
  if (user.kind !== "chat" || user.channel !== "web")
    throw new HttpError(409, "只能重来网页里的最后一条消息")
  for (const reply of replies) {
    if (!REDOABLE_KINDS.has(reply.kind) || reply.channel !== "web")
      throw new HttpError(409, "她后来又发了别的消息，这一轮不能再重来了")
    const status = (reply.metadata as { status?: string } | null)?.status
    if (reply.kind !== "chat" && status !== "pending")
      throw new HttpError(409, "这一轮里的确认已经处理过了，不能再重来")
  }
  const redone = Number((user.metadata as { redo?: number } | null)?.redo ?? 0)
  return { user, replies, redone }
}

// Hides messages (kept for audit); restoring undoes it if the new answer fails
async function setSuperseded(ids: string[], at: Date | null) {
  if (ids.length)
    await db
      .update(companionMessages)
      .set({ supersededAt: at })
      .where(inArray(companionMessages.id, ids))
}

export async function companionChat(
  input: {
    ownerId: string
    agentId: string
    text: string
    channel?: string
    // Things she wanted to tell the person but could not send on this channel; she works them
    // into this reply (channels that only allow replies, see lib/channels/hub.ts)
    awayDigest?: string[]
    // Web only: answer the latest message again ("regenerate", text is ignored) or replace it
    // ("edit"). Notes are not written during a regenerate, so redoing never records twice.
    redo?: "regenerate" | "edit"
  },
  deps: ChatDeps = {},
  emit: (event: ChatEvent) => void = () => {}
) {
  const redo = input.redo
  const channel = redo ? "web" : (input.channel ?? "web")
  const now = deps.now ?? new Date()
  const sleep = deps.sleep ?? realSleep
  const random = deps.random ?? Math.random
  const companion = await ensureCompanion(input.ownerId, input.agentId)
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId))

  // What is replaced by a redo; restored if the new answer cannot be produced
  const round = redo ? await latestRound(input.agentId) : null
  if (round && redo === "regenerate" && round.redone >= MAX_REDO)
    throw new HttpError(409, `这一轮已经重说 ${MAX_REDO} 次了`)
  let user: CompanionMessage
  if (round && redo === "regenerate") user = round.user
  else {
    ;[user] = await insertMessages(
      input.agentId,
      [{ role: "user", kind: "chat", content: input.text, channel, metadata: null }],
      now
    )
    emit({ type: "user", message: user })
  }
  const hidden = round
    ? [...round.replies.map((row) => row.id), ...(redo === "edit" ? [round.user.id] : [])]
    : []
  const hide = async () => {
    if (!round) return
    await setSuperseded(hidden, new Date())
    if (redo === "regenerate")
      await db
        .update(companionMessages)
        .set({
          metadata: sql`coalesce(${companionMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ redo: round.redone + 1 })}::jsonb`,
        })
        .where(eq(companionMessages.id, round.user.id))
    if (hidden.length) emit({ type: "superseded", ids: hidden })
  }
  const undo = async () => {
    if (!round) return
    await setSuperseded(hidden, null)
    if (redo === "regenerate")
      await db
        .update(companionMessages)
        .set({
          metadata: sql`coalesce(${companionMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ redo: round.redone })}::jsonb`,
        })
        .where(eq(companionMessages.id, round.user.id))
    else await db.delete(companionMessages).where(eq(companionMessages.id, user.id))
  }

  // Crisis wording gets a fixed reply before any model call
  if (detectCrisis(user.content)) {
    await hide()
    const replies = await insertMessages(input.agentId, [
      {
        role: "assistant",
        kind: "crisis",
        content: crisisReply(companion.timeZone),
        channel,
        metadata: null,
      },
    ])
    await dropCandidates(input.agentId, round?.replies ?? [])
    emit({ type: "messages", messages: replies })
    return { user, replies, schedule: replies.map(() => 0) }
  }

  const spec = deps.model
    ? (deps.spec ?? "mock/test")
    : ((await getSetting("model.chat")) ?? (await resolveModelSpec(agent.model)))
  const price =
    deps.price !== undefined
      ? deps.price
      : spec
        ? findPrice(spec, { custom: await getCustomPrices() })
        : null
  let hiddenNow = false
  try {
    if (!spec) throw new HttpError(409, "先在设置里配置模型服务和模型")
    const block = monthlyBlock(await monthlyUsage(input.ownerId), price)
    if (block) throw new HttpError(402, block)

    let model = deps.model
    if (!model) {
      const parsed = parseModelSpec(spec)
      if (!parsed) throw new HttpError(409, `不支持的模型：${spec}`)
      model = await createModel(spec, await getProviderCredentials(parsed.provider))
    }

    const link =
      redo === "regenerate"
        ? null
        : await queueCoview(input.agentId, user.content, now, deps.linkCheck)
    await hide()
    hiddenNow = true
    emit({ type: "typing", on: true })
    const [notes, activities, recent] = await Promise.all([
      listNotes(input.agentId, "active"),
      db
        .select()
        .from(lifeActivities)
        .where(eq(lifeActivities.agentId, input.agentId))
        .orderBy(desc(lifeActivities.createdAt))
        .limit(8),
      db
        .select()
        .from(companionMessages)
        .where(
          and(eq(companionMessages.agentId, input.agentId), visibleMessage(new Date()))
        )
        .orderBy(desc(companionMessages.createdAt), desc(companionMessages.id))
        .limit(HISTORY),
    ])
    const system = buildCompanionPrompt({
      name: agent.name,
      persona: companion.persona,
      mode: companion.mode,
      now: now.toISOString(),
      timeZone: companion.timeZone,
      rhythm: rhythmAt(now, companion.timeZone, companion.rhythm),
      link,
      awayDigest: input.awayDigest ?? [],
      memories: selectNotes(notes),
      recentLife: activities.reverse().map((a) => ({
        kind: a.kind,
        title: a.title,
        summary: a.summary,
        url: a.url,
        at: new Intl.DateTimeFormat("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: companion.timeZone,
        }).format(a.createdAt),
      })),
    })

    const proposals: string[] = []
    const candidates: { memoryId: string; note: string }[] = []
    // Redoing a message must not record the same thing twice: notes are read-only then
    const readOnly = redo === "regenerate"
    const frozen = { status: "这次是重说一遍，先不改记忆，下次再记" }
    const tools = {
      remember: tool({
        description:
          "记下一条关于对方的长期信息，一句话。对方明确说出的事实用 sure；你只是推测、对方顺口一提、或涉及健康、感情、钱、家人等敏感内容时用 unsure，会先让对方确认才算数。",
        inputSchema: z.object({
          note: z.string().trim().min(1).max(500),
          certainty: z.enum(["sure", "unsure"]).default("sure"),
        }),
        execute: async ({ note, certainty }) => {
          if (readOnly) return frozen
          const saved = await addNote(
            input.agentId,
            note,
            "agent",
            certainty === "sure" ? "active" : "candidate"
          )
          if (certainty === "unsure" && saved.status === "candidate")
            candidates.push({ memoryId: saved.id, note: saved.content })
          return { id: saved.id, saved: saved.content, status: saved.status }
        },
      }),
      update_memory: tool({
        description: "信息变了时，改写一条已有记忆。",
        inputSchema: z.object({ id: z.string(), note: z.string().trim().min(1).max(500) }),
        execute: async ({ id, note }) => {
          if (readOnly) return frozen
          const saved = await updateNote(input.agentId, id, note)
          return { id: saved.id, saved: saved.content }
        },
      }),
      forget: tool({
        description: "对方要求忘掉某件事，或记错了，立即删除这条记忆。",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) =>
          readOnly ? frozen : { forgotten: (await deleteNote(input.agentId, id)).id },
      }),
      propose_errand: tool({
        description:
          "对方希望你去电脑上办一件具体的事时，写清目标并发给对方确认。确认前任务不会开始。",
        inputSchema: z.object({ goal: z.string().trim().min(1).max(2000) }),
        execute: async ({ goal }) => {
          proposals.push(goal)
          return { status: "已发给对方，等对方在界面里确认后才会开始" }
        },
      }),
    }

    const provider = parseModelSpec(spec)?.provider
    const effort = await getSetting("chat.reasoningEffort")
    const started = Date.now()
    const result = streamText({
      model,
      providerOptions:
        provider === "custom" || provider === "openrouter"
          ? { [provider]: { reasoningEffort: effort ?? "low" } }
          : undefined,
      system,
      messages: historyMessages(recent.reverse()),
      tools,
      stopWhen: isStepCount(4),
      maxOutputTokens: 1200,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(120_000),
      onError: ({ error }) => {
        throw error
      },
    })
    let text = ""
    for await (const delta of result.textStream) {
      text += delta
      emit({ type: "delta", text: delta })
    }
    const usage = await result.totalUsage
    const missing = usage.inputTokens === undefined || usage.outputTokens === undefined
    const cost =
      missing && price?.kind !== "local"
        ? null
        : callCost(price, {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cached: usage.inputTokenDetails.cacheReadTokens ?? 0,
          })
    await db.insert(companionUsage).values({
      agentId: input.agentId,
      model: spec,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
      costMicros: cost === null ? null : toMicros(cost),
      durationMs: Date.now() - started,
    })

    const bubbles = splitBubbles(text)
    const rows: NewMessage[] = bubbles.map((content) => ({
      role: "assistant",
      kind: "chat",
      content,
      channel,
      metadata: null,
    }))
    for (const goal of proposals)
      rows.push({
        role: "assistant",
        kind: "errand_proposal",
        content: goal,
        channel,
        metadata: { goal, status: "pending" },
      })
    for (const candidate of candidates)
      rows.push({
        role: "assistant",
        kind: "memory_candidate",
        content: candidate.note,
        channel,
        metadata: { memoryId: candidate.memoryId, status: "pending" },
      })
    // Bubbles appear one by one; cards come with the last bubble
    const pace = companion.typingPace
    const offsets = playbackSchedule(bubbles, pace, random)
    const schedule = rows.map((_, index) =>
      pace === "off" ? 0 : (offsets[Math.min(index, offsets.length - 1)] ?? 0)
    )
    const base = new Date()
    for (const [index, row] of rows.entries())
      row.revealAt = schedule[index] ? new Date(base.getTime() + schedule[index]) : null
    const replies = rows.length ? await insertMessages(input.agentId, rows, base) : []
    await dropCandidates(input.agentId, round?.replies ?? [])

    if (deps.playback && schedule.some((ms) => ms > 0)) {
      // One event per distinct moment: typing, wait, bubble(s)
      const moments = [...new Set(schedule)]
      for (const at of moments) {
        emit({ type: "typing", on: true })
        await sleep(Math.max(0, base.getTime() + at - Date.now()))
        emit({
          type: "messages",
          messages: replies.filter((_, index) => schedule[index] === at),
        })
      }
    } else emit({ type: "messages", messages: replies })
    return { user, replies, schedule }
  } catch (error) {
    // The old answer comes back if there is no new one (budget, provider error, ...)
    if (hiddenNow) await undo()
    else if (round && redo === "edit")
      await db.delete(companionMessages).where(eq(companionMessages.id, user.id))
    throw error
  }
}

// Candidate notes she proposed in a turn that was redone no longer apply
async function dropCandidates(agentId: string, replaced: CompanionMessage[]) {
  for (const card of replaced) {
    if (card.kind !== "memory_candidate") continue
    const memoryId = (card.metadata as { memoryId?: string } | null)?.memoryId
    if (memoryId)
      await db
        .delete(memories)
        .where(
          and(
            eq(memories.agentId, agentId),
            eq(memories.id, memoryId),
            eq(memories.status, "candidate")
          )
        )
  }
}
