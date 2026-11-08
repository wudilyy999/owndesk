// Light chat path: one model call per message, no durable task, no workstation.
// Errands are only proposed here; the person confirms them in the UI (lib/companion/errands.ts).
import { streamText, tool, isStepCount, type LanguageModel, type ModelMessage } from "ai"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import {
  agents,
  companionMessages,
  companionImages,
  companionUsage,
  lifeActivities,
  memories,
  type CompanionImage,
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
import { createModelWithFallback, isRetriableModelError } from "@/lib/providers/fallback"
import { getSetting } from "@/lib/config"
import { getCustomPrices, monthlyBlock, monthlyUsage } from "@/lib/spend"
import { crisisReply, detectCrisis } from "./crisis"
import { memoryView, recallNotes, rememberDecided } from "./memory"
import { decideMemoryOps } from "./memory-update"
import { getImage, readImage, seeImage } from "./images"
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

// Pictures only reach the model in the turn they were sent; later turns keep her one-line
// description of them (`pictures`: image id → description)
export function historyMessages(
  rows: CompanionMessage[],
  pictures: Map<string, string | null> = new Map(),
  current?: { id: string; image: Buffer | null }
): ModelMessage[] {
  return rows.map((row): ModelMessage => {
    const imageId = (row.metadata as { imageId?: string } | null)?.imageId
    if (row.role === "user" && imageId) {
      if (current?.id === row.id && current.image)
        return {
          role: "user",
          content: [
            { type: "text", text: row.content || "（发来一张图片）" },
            {
              type: "image",
              image: new Uint8Array(current.image),
              mediaType: "image/jpeg",
            },
          ],
        }
      const description = pictures.get(imageId)
      const note =
        current?.id === row.id
          ? "（发来一张图片，但你这次看不到内容）"
          : description
            ? `（发来一张图片：${description}）`
            : "（发来一张图片，内容没看清）"
      return { role: "user", content: [row.content, note].filter(Boolean).join("\n") }
    }
    return {
      role: row.role,
      content:
        row.kind === "errand_proposal"
          ? `（我提出了一个任务，等你确认：${(row.metadata as { goal?: string }).goal}）`
          : row.content,
    }
  })
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

const REDOABLE_KINDS = new Set([
  "chat",
  "memory_candidate",
  "memory_merge",
  "errand_proposal",
])

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

type Usage = Awaited<ReturnType<typeof streamText>["totalUsage"]>

export async function recordUsage(
  agentId: string,
  spec: string,
  price: Price | null,
  usage: Usage,
  durationMs: number
) {
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
    agentId,
    model: spec,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    costMicros: cost === null ? null : toMicros(cost),
    durationMs,
  })
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
    // A picture the person sent with this message (lib/companion/images.ts)
    imageId?: string
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
  // A redo keeps the picture of the message it answers
  const roundImage = (round?.user.metadata as { imageId?: string } | null)?.imageId
  const imageId = redo === "regenerate" ? roundImage : (input.imageId ?? roundImage)
  let image: CompanionImage | null = null
  if (imageId) {
    image = await getImage(input.agentId, imageId)
    if (!image) throw new HttpError(404, "找不到这张图片")
  }
  if (redo !== "regenerate" && !input.text.trim() && !image)
    throw new HttpError(400, "说点什么，或者发张图片")
  let user: CompanionMessage
  if (round && redo === "regenerate") user = round.user
  else {
    ;[user] = await insertMessages(
      input.agentId,
      [
        {
          role: "user",
          kind: "chat",
          content: input.text,
          channel,
          metadata: image ? { imageId: image.id } : null,
        },
      ],
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

  let spec = deps.model
    ? (deps.spec ?? "mock/test")
    : ((await getSetting("model.chat")) ?? (await resolveModelSpec(agent.model)))
  const fallbackSpec =
    deps.model || deps.spec ? null : (await getSetting("model.fallback"))?.trim() || null
  let price =
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

    let model: LanguageModel
    if (deps.model) model = deps.model
    else {
      const parsed = parseModelSpec(spec)
      if (!parsed) throw new HttpError(409, `不支持的模型：${spec}`)
      const created = await createModelWithFallback(
        spec,
        fallbackSpec && fallbackSpec !== spec ? fallbackSpec : null
      )
      model = created.model
      if (created.usedFallback) {
        spec = created.spec
        price = findPrice(spec, { custom: await getCustomPrices() })
      }
    }
    // Narrowed for tool closures below (spec was string | null before the throw).
    let activeSpec: string = spec
    let activePrice = price

    const effort = await getSetting("chat.reasoningEffort")
    const optionsFor = (activeSpec: string) => {
      const id = parseModelSpec(activeSpec)?.provider
      return id === "custom" || id === "openrouter"
        ? { [id]: { reasoningEffort: effort ?? "low" } }
        : undefined
    }
    let providerOptions = optionsFor(activeSpec)

    // What she can see of the picture: a short vision call first (what is it, is there a face or an
    // ID?). If she cannot look at it, she says so instead of guessing.
    let sight: "none" | "seen" | "unseen" = "none"
    let picture: Buffer | null = null
    if (image) {
      const data = await readImage(image, now)
      sight = "unseen"
      if (data) {
        try {
          if (image.description === null) {
            const lookedAt = Date.now()
            const looked = await seeImage(model, data, { providerOptions })
            await recordUsage(
              input.agentId,
              activeSpec,
              activePrice,
              looked.usage,
              Date.now() - lookedAt
            )
            const [updated] = await db
              .update(companionImages)
              .set({ description: looked.description, sensitive: looked.sensitive })
              .where(eq(companionImages.id, image.id))
              .returning()
            image = updated
          }
          sight = "seen"
          picture = data
        } catch (error) {
          console.error(
            "Companion could not look at the picture",
            (error as Error).message
          )
        }
      }
    }
    // A face or an ID (or not knowing) keeps the picture out of her notes
    const guarded = !!image && (sight !== "seen" || image.sensitive)

    const link =
      redo === "regenerate"
        ? null
        : await queueCoview(input.agentId, user.content, now, deps.linkCheck)
    await hide()
    hiddenNow = true
    emit({ type: "typing", on: true })
    const [memory, activities, recent] = await Promise.all([
      memoryView(input.agentId),
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
      image:
        sight === "none"
          ? undefined
          : sight === "unseen"
            ? "unseen"
            : guarded
              ? "sensitive"
              : "seen",
      summaries: memory.summaries,
      // Notes she has not sorted into a topic yet; the sorted ones she can read with recall_memory
      memories: memory.notes.filter((note) => !note.summaryId),
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

    // The same low effort for the memory call, whatever the chat setting says
    const memoryOptions = (() => {
      const id = parseModelSpec(activeSpec)?.provider
      return id === "custom" || id === "openrouter"
        ? { [id]: { reasoningEffort: "low" } }
        : undefined
    })()
    const proposals: string[] = []
    const candidates: { memoryId: string; note: string }[] = []
    // Redoing a message must not record the same thing twice: notes are read-only then
    const readOnly = redo === "regenerate"
    const frozen = { status: "这次是重说一遍，先不改记忆，下次再记" }
    const tools = {
      remember: tool({
        description:
          "把关于对方的事记进长期记忆：对方说出新的事实、信息变了、记错了、或者让你忘掉某件事，都用这个。note 用一句话写清楚发生了什么（例如“最近戒咖啡了”“让我忘掉养猫的事”），记忆管理员会对照你所有的记忆，决定是新增、改写、合并、删除，还是先问对方。",
        inputSchema: z.object({ note: z.string().trim().min(1).max(500) }),
        execute: async ({ note }) => {
          if (readOnly) return frozen
          const done = await rememberDecided(input.agentId, note, {
            // With a face or an ID in the picture nothing is kept without the person's say-so
            guarded,
            origin: "chat",
            messageId: user.id,
            sourceText: user.content,
            decide: async (fact, view) => {
              const started = Date.now()
              const decision = await decideMemoryOps(model, fact, view, {
                context: user.content,
                providerOptions: memoryOptions,
              })
              if (decision.usage)
                await recordUsage(
                  input.agentId,
                  activeSpec,
                  activePrice,
                  decision.usage,
                  Date.now() - started
                )
              return decision
            },
          })
          if (done.candidate) {
            candidates.push({ memoryId: done.candidate.id, note: done.candidate.content })
            return {
              id: done.candidate.id,
              status: "candidate",
              hint: "这条先放在待确认里，等对方点头才算数。",
            }
          }
          if (done.changes.length)
            return {
              status: "已记下",
              changes: done.changes.map((change) => ({
                op: change.op,
                before: change.before,
                after: change.after,
              })),
            }
          return { status: "这件事已经记着了，不用重复记" }
        },
      }),
      recall_memory: tool({
        description:
          "翻看记忆。topic 选择主题详细笔记；不传 topic 按页翻全部笔记；summaries=true 按页读主题总结。page 从 1 开始，按返回的 pages 继续翻。",
        inputSchema: z.object({
          topic: z.string().trim().max(40).optional(),
          page: z.number().int().min(1).optional(),
          summaries: z.boolean().optional(),
        }),
        execute: async (query) => recallNotes(input.agentId, query),
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

    const started = Date.now()
    const pictureIds = recent.flatMap((row) => {
      const found = (row.metadata as { imageId?: string } | null)?.imageId
      return found ? [found] : []
    })
    const pictures = new Map<string, string | null>()
    if (pictureIds.length)
      for (const row of await db
        .select({ id: companionImages.id, description: companionImages.description })
        .from(companionImages)
        .where(
          and(
            eq(companionImages.agentId, input.agentId),
            inArray(companionImages.id, pictureIds)
          )
        ))
        pictures.set(row.id, row.description)
    const history = historyMessages(recent.reverse(), pictures, {
      id: user.id,
      image: picture,
    })
    async function runStream(
      activeModel: LanguageModel,
      activeSpec: string,
      activePrice: Price | null
    ) {
      const result = streamText({
        model: activeModel,
        providerOptions: optionsFor(activeSpec),
        system,
        messages: history,
        tools,
        stopWhen: isStepCount(4),
        maxOutputTokens: 1200,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(240_000),
        onError: ({ error }) => {
          throw error
        },
      })
      let text = ""
      let emitted = false
      try {
        for await (const delta of result.textStream) {
          text += delta
          emitted = true
          emit({ type: "delta", text: delta })
        }
      } catch (error) {
        ;(error as { __emitted?: boolean }).__emitted = emitted
        throw error
      }
      await recordUsage(
        input.agentId,
        activeSpec,
        activePrice,
        await result.totalUsage,
        Date.now() - started
      )
      return text
    }
    let text = ""
    try {
      text = await runStream(model, activeSpec, activePrice)
    } catch (error) {
      const emitted = !!(error as { __emitted?: boolean }).__emitted
      const canFallback =
        !deps.model &&
        !emitted &&
        fallbackSpec &&
        fallbackSpec !== activeSpec &&
        isRetriableModelError(error)
      if (!canFallback) throw error
      console.error(
        `chat on ${activeSpec} failed before any reply (${(error as Error).message}); trying ${fallbackSpec}`
      )
      const parsed = parseModelSpec(fallbackSpec)
      if (!parsed) throw error
      model = await createModel(
        fallbackSpec,
        await getProviderCredentials(parsed.provider)
      )
      activeSpec = fallbackSpec
      spec = fallbackSpec
      activePrice = findPrice(activeSpec, { custom: await getCustomPrices() })
      price = activePrice
      providerOptions = optionsFor(activeSpec)
      text = await runStream(model, activeSpec, activePrice)
    }

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
        metadata: { goal, status: "pending", sourceMessageId: user.id },
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
    if (card.kind !== "memory_candidate" && card.kind !== "memory_merge") continue
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
