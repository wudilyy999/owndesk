import { chatRoutineSchema, manageChatRoutine } from "./routines"
import { ownedUploads } from "@/lib/uploads"
// Light chat path: one model call per message, no durable task, no workstation.
// Errands are only proposed here; the person confirms them in the UI (lib/companion/errands.ts).
import { streamText, tool, isStepCount, type LanguageModel } from "ai"
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
  objectives,
  type CompanionImage,
  type CompanionMessage,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import {
  createModel,
  getProviderCredentials,
  modelContextWindow,
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
import { playbackSchedule, realSleep } from "./pacing"
import { rhythmAt } from "./rules"
import { ensureCompanion } from "./store"
import type { ObjectiveProposal } from "./objectives"
import { controlObjective, objectiveBrief } from "@/lib/objectives"
import type { ImprovementProposal } from "@/lib/evolution/improvements"
import { evolutionEnabled } from "@/lib/evolution/store"
import { estimateContextTokens, isContextWindowError } from "@/lib/agent/context"
import { buildChatContext, historyMessages, summaryMessage } from "./context"

export { historyMessages } from "./context"

const MAX_BUBBLES = 4
const MAX_STEPS = 4
// The last model step may only answer: tools stay defined but cannot be called (as OpenCode does)
const FINAL_STEP =
  "（这是你这次回复的最后一步：不能再调用工具。根据上面的工具结果，直接用聊天语气回复对方；没办成的事要如实说。）"

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
  // Model window used to decide when older chat is summarized (tests use a small one)
  contextWindow?: number
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
  "objective_proposal",
  "improvement_proposal",
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
  const commands = await db.execute(
    sql`SELECT 1 FROM routine_commands WHERE agent_id=${agentId} AND key LIKE ${`chat:${user.id}:%`} LIMIT 1`
  )
  if (commands.rowCount)
    throw new HttpError(409, "这一轮已经修改自动化计划，请发送新消息继续调整")
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
    attachmentIds?: string[]
    // A channel delivery id: a retried delivery continues the same turn instead of adding
    // the message again
    sourceKey?: string
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
  const roundAttachments =
    (round?.user.metadata as { attachmentIds?: string[] } | null)?.attachmentIds ?? []
  const attachmentIds =
    redo === "regenerate" ? roundAttachments : (input.attachmentIds ?? roundAttachments)
  const attachments = await ownedUploads(input.ownerId, input.agentId, attachmentIds)
  let image: CompanionImage | null = null
  if (imageId) {
    image = await getImage(input.agentId, imageId)
    if (!image) throw new HttpError(404, "找不到这张图片")
  }
  if (redo !== "regenerate" && !input.text.trim() && !image && !attachments.length)
    throw new HttpError(400, "说点什么，或者发张图片")
  let user: CompanionMessage
  const [delivered] =
    input.sourceKey && !redo
      ? await db
          .select()
          .from(companionMessages)
          .where(
            and(
              eq(companionMessages.agentId, input.agentId),
              eq(companionMessages.role, "user"),
              sql`${companionMessages.metadata}->>'sourceKey' = ${input.sourceKey}`
            )
          )
          .limit(1)
      : []
  if (delivered && (delivered.metadata as { answered?: boolean } | null)?.answered) {
    // The reply was saved before the delivery was retried: hand back the same reply
    const replies = await repliesTo(input.agentId, delivered)
    return { user: delivered, replies, schedule: replies.map(() => 0) }
  }
  if ((delivered?.metadata as { effects?: boolean } | null)?.effects)
    // The earlier attempt stopped after a tool changed something: never run it twice
    throw new HttpError(
      409,
      "上一次处理这条消息时中断了，已经办的事保留着，没有重复执行；请看看记录后再发新消息。"
    )
  if (round && redo === "regenerate") user = round.user
  else if (delivered) user = delivered
  else {
    ;[user] = await insertMessages(
      input.agentId,
      [
        {
          role: "user",
          kind: "chat",
          content: input.text,
          channel,
          metadata: {
            ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
            ...(image ? { imageId: image.id } : {}),
            ...(attachments.length
              ? { attachmentIds: attachments.map((file) => file.id), attachments }
              : {}),
          },
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
  // Set once a tool changed something; the turn is then never run again (no double writes).
  // The mark is saved on the message, so a retried channel delivery sees it after a crash too.
  let wrote = false
  const markWrote = async () => {
    if (wrote) return
    wrote = true
    await db
      .update(companionMessages)
      .set({
        metadata: sql`coalesce(${companionMessages.metadata}, '{}'::jsonb) || '{"effects":true}'::jsonb`,
      })
      .where(eq(companionMessages.id, user.id))
  }
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
    const [memory, activities] = await Promise.all([
      memoryView(input.agentId),
      db
        .select()
        .from(lifeActivities)
        .where(eq(lifeActivities.agentId, input.agentId))
        .orderBy(desc(lifeActivities.createdAt))
        .limit(8),
    ])
    const promptContext = {
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
    } satisfies Parameters<typeof buildCompanionPrompt>[0]
    const system = buildCompanionPrompt(promptContext)

    // The same low effort for the memory call, whatever the chat setting says
    const memoryOptions = (() => {
      const id = parseModelSpec(activeSpec)?.provider
      return id === "custom" || id === "openrouter"
        ? { [id]: { reasoningEffort: "low" } }
        : undefined
    })()
    const proposals: string[] = []
    const objectiveProposals: ObjectiveProposal[] = []
    const improvementProposals: ImprovementProposal[] = []
    const improving = await evolutionEnabled()
    const candidates: { memoryId: string; note: string }[] = []
    // Redoing a message must not record the same thing twice: notes are read-only then
    const readOnly = redo === "regenerate"
    const frozen = { status: "这次是重说一遍，先不改记忆，下次再记" }
    const tools = {
      manage_routine: tool({
        description:
          "管理这个助手的自动化。用户要求创建、修改、暂停、恢复、删除时调用；先 list 获取 ID 和版本。创建/修改明确名称、工作、时间与启用状态；eventTrigger 可设置 webhook 或网页变化。用户只问现有计划时使用 list。",
        inputSchema: chatRoutineSchema,
        execute: async (command, options) => {
          if (readOnly && command.action !== "list") return frozen
          if (command.action !== "list") await markWrote()
          return manageChatRoutine(
            input.ownerId,
            input.agentId,
            `chat:${user.id}:${options.toolCallId}`,
            command
          )
        },
      }),
      remember: tool({
        description:
          "把关于对方的事记进长期记忆：对方说出新的事实、信息变了、记错了、或者让你忘掉某件事，都用这个。note 用一句话写清楚发生了什么（例如“最近戒咖啡了”“让我忘掉养猫的事”），记忆管理员会对照你所有的记忆，决定是新增、改写、合并、删除，还是先问对方。",
        inputSchema: z.object({ note: z.string().trim().min(1).max(500) }),
        execute: async ({ note }) => {
          if (readOnly) return frozen
          await markWrote()
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
      propose_objective: tool({
        description:
          "对方想让你长期、分很多轮去完成一个较大的目标（不是一次能办完的小事）时，写清目标和完成标准发给对方确认。确认前不会开始；上限不填就不限。",
        inputSchema: z.object({
          title: z.string().trim().min(1).max(60),
          objective: z.string().trim().min(1).max(4000),
          doneCriteria: z.string().trim().max(2000).default(""),
          requireReview: z.boolean().default(false),
          maxCostUsd: z.number().positive().max(100000).optional(),
          maxRounds: z.number().int().min(1).max(100000).optional(),
          deadlineAt: z.iso.datetime({ offset: true }).optional(),
        }),
        execute: async (draft) => {
          objectiveProposals.push({
            title: draft.title,
            objective: draft.objective,
            doneCriteria: draft.doneCriteria,
            completionContract: { requireHumanReview: draft.requireReview },
            budget: {
              roundMaxSteps: 40,
              ...(draft.maxCostUsd !== undefined
                ? { maxCostMicros: Math.round(draft.maxCostUsd * 1_000_000) }
                : {}),
              ...(draft.maxRounds !== undefined ? { maxRounds: draft.maxRounds } : {}),
              ...(draft.deadlineAt !== undefined ? { deadlineAt: draft.deadlineAt } : {}),
            },
          })
          return { status: "已发给对方，等对方在界面里确认后才会开始" }
        },
      }),
      ...(improving
        ? {
            propose_improvement: tool({
              description:
                "对方希望改变你这个软件本身的功能、界面或行为（需要改代码才能做到）时用。先判断能不能不改代码：改说话方式/人设用设置，记住偏好用记忆，定时提醒用定时任务，固定的电脑操作用操作手册，这些不要用本工具。确实要改代码时，写清对方想要什么（现在怎样、希望怎样）和 2~6 条能在网页上实际检查的验收清单，发给对方确认。上限不填就不限。",
              inputSchema: z.object({
                title: z.string().trim().min(1).max(60),
                request: z.string().trim().min(1).max(4000),
                checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
                maxCostUsd: z.number().positive().max(100000).optional(),
                maxRounds: z.number().int().min(1).max(100000).optional(),
                deadlineAt: z.iso.datetime({ offset: true }).optional(),
              }),
              execute: async (draft) => {
                improvementProposals.push({
                  title: draft.title,
                  request: draft.request,
                  checklist: draft.checklist,
                  budget: {
                    roundMaxSteps: 40,
                    ...(draft.maxCostUsd !== undefined
                      ? { maxCostMicros: Math.round(draft.maxCostUsd * 1_000_000) }
                      : {}),
                    ...(draft.maxRounds !== undefined
                      ? { maxRounds: draft.maxRounds }
                      : {}),
                    ...(draft.deadlineAt !== undefined
                      ? { deadlineAt: draft.deadlineAt }
                      : {}),
                  },
                })
                return { status: "改进提议卡已发给对方，确认后才会开始" }
              },
            }),
          }
        : {}),
      manage_objective: tool({
        description:
          "查看、暂停或停止对方的长期目标。对方问目标进展时用 list；要暂停或停止时先 list 拿到 id。继续、改上限请对方到长期目标页操作。",
        inputSchema: z.object({
          action: z.enum(["list", "pause", "stop"]),
          id: z.string().min(1).max(100).optional(),
        }),
        execute: async ({ action, id }) => {
          if (action === "list") return objectiveBrief(input.ownerId, input.agentId)
          if (readOnly) return frozen
          if (!id) return { error: "先 list 拿到目标的 id" }
          const [owned] = await db
            .select({ id: objectives.id })
            .from(objectives)
            .where(and(eq(objectives.id, id), eq(objectives.agentId, input.agentId)))
          if (!owned) return { error: "没有这个目标" }
          await markWrote()
          try {
            await controlObjective(input.ownerId, id, action)
            return { status: action === "pause" ? "已暂停" : "已停止" }
          } catch (error) {
            if (error instanceof HttpError) return { error: error.message }
            throw error
          }
        },
      }),
    }

    // Tool schemas and the picture share the window with the prompt and the history
    const toolTokens = estimateContextTokens(
      Object.entries(tools).map(([name, item]) => ({
        name,
        description: item.description,
        schema: z.toJSONSchema(item.inputSchema as z.ZodType),
      }))
    )
    const contextFor = (force: boolean) =>
      buildChatContext({
        agentId: input.agentId,
        name: agent.name,
        timeZone: companion.timeZone,
        now: new Date(),
        currentUserId: user.id,
        window: deps.contextWindow ?? modelContextWindow(activeSpec),
        fixedTokens: (summary, gap) =>
          estimateContextTokens([system, summaryMessage(summary, gap)]) +
          toolTokens +
          (picture ? 8192 : 0),
        model,
        providerOptions: memoryOptions,
        onUsage: (usage, durationMs) =>
          recordUsage(input.agentId, activeSpec, activePrice, usage, durationMs),
        force,
      })
    let context = await contextFor(false)
    const viewOf = (view: typeof context) => {
      const earlier = summaryMessage(view.summary, view.gap)
      return {
        system,
        messages: [
          ...(earlier ? [earlier] : []),
          ...historyMessages(view.rows, view.pictures, { id: user.id, image: picture }),
        ],
      }
    }

    async function runStream(
      activeModel: LanguageModel,
      activeSpec: string,
      activePrice: Price | null
    ) {
      const started = Date.now()
      const view = viewOf(context)
      // Cards collected by a failed attempt are not sent twice
      proposals.length = 0
      objectiveProposals.length = 0
      improvementProposals.length = 0
      // streamText reports a failed request as "no output"; keep the provider's own error
      let failure: unknown = null
      const result = streamText({
        model: activeModel,
        providerOptions: optionsFor(activeSpec),
        system: view.system,
        messages: view.messages,
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        prepareStep: ({ stepNumber, messages }) =>
          stepNumber === MAX_STEPS - 1
            ? {
                toolChoice: "none" as const,
                messages: [...messages, { role: "user" as const, content: FINAL_STEP }],
              }
            : {},
        maxOutputTokens: 1200,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(240_000),
        onError: ({ error }) => {
          failure ??= error
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
        const usage = await result.totalUsage
        if (failure) throw failure
        await recordUsage(
          input.agentId,
          activeSpec,
          activePrice,
          usage,
          Date.now() - started
        )
      } catch (error) {
        const cause = (failure ?? error) as Error & { __emitted?: boolean }
        if (cause && typeof cause === "object") cause.__emitted = emitted
        throw cause
      }
      return text
    }
    // Sent again only when nothing reached the person and no tool changed anything
    const untouched = (error: unknown) =>
      !(error as { __emitted?: boolean }).__emitted && !wrote
    let text = ""
    try {
      text = await runStream(model, activeSpec, activePrice)
    } catch (error) {
      if (isContextWindowError(error) && untouched(error)) {
        // Too long after all: summarize harder once and send the turn again (a second refusal stands)
        console.error(
          `chat on ${activeSpec} exceeded the context window; summarizing older chat`
        )
        context = await contextFor(true)
        text = await runStream(model, activeSpec, activePrice)
      } else {
        const canFallback =
          !deps.model &&
          untouched(error) &&
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
    for (const proposal of objectiveProposals)
      rows.push({
        role: "assistant",
        kind: "objective_proposal",
        content: proposal.title,
        channel,
        metadata: { proposal, status: "pending", sourceMessageId: user.id },
      })
    for (const proposal of improvementProposals)
      rows.push({
        role: "assistant",
        kind: "improvement_proposal",
        content: proposal.title,
        channel,
        metadata: { proposal, status: "pending", sourceMessageId: user.id },
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
    if (input.sourceKey)
      await db
        .update(companionMessages)
        .set({
          metadata: sql`coalesce(${companionMessages.metadata}, '{}'::jsonb) || '{"answered":true}'::jsonb`,
        })
        .where(eq(companionMessages.id, user.id))
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
    // After a tool changed something the message stays: it is what the change came from
    if (hiddenNow && !wrote) await undo()
    else if (round && redo === "edit" && !wrote)
      await db.delete(companionMessages).where(eq(companionMessages.id, user.id))
    if (wrote && !(error instanceof HttpError)) {
      // A tool already changed something: running the turn again could do it twice
      console.error("Companion chat failed after a tool changed something", error)
      throw new HttpError(
        502,
        "回复中途出错了。这条消息里已经办的事（比如记下的内容、改的计划）都保留了，没有重复执行；可以看看记录后再接着说。"
      )
    }
    throw error
  }
}

// What she answered to one message: her rows after it, up to the person's next message
async function repliesTo(agentId: string, user: CompanionMessage) {
  const rows = await db
    .select()
    .from(companionMessages)
    .where(
      and(
        eq(companionMessages.agentId, agentId),
        isNull(companionMessages.supersededAt),
        sql`(${companionMessages.createdAt}, ${companionMessages.id}) > (${user.createdAt}, ${user.id})`
      )
    )
    .orderBy(companionMessages.createdAt, companionMessages.id)
    .limit(20)
  const next = rows.findIndex((row) => row.role === "user")
  return (next === -1 ? rows : rows.slice(0, next)).filter(
    (row) => row.role === "assistant"
  )
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
