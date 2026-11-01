// Light chat path: one model call per message, no durable task, no workstation.
// Errands are only proposed here; the person confirms them in the UI (lib/companion/errands.ts).
import { streamText, tool, isStepCount, type LanguageModel, type ModelMessage } from "ai"
import { desc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import {
  agents,
  companionMessages,
  companionUsage,
  lifeActivities,
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
import { ensureCompanion } from "./store"

const HISTORY = 30
const MAX_BUBBLES = 4

export type ChatEvent =
  | { type: "user"; message: CompanionMessage }
  | { type: "delta"; text: string }
  | { type: "messages"; messages: CompanionMessage[] }

export type ChatDeps = {
  model?: LanguageModel
  // Spec used to price the call when a model is injected
  spec?: string
  price?: Price | null
  now?: Date
}

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

async function insertMessages(
  agentId: string,
  rows: Pick<CompanionMessage, "role" | "kind" | "content" | "channel" | "metadata">[],
  start = new Date()
) {
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

export async function companionChat(
  input: { ownerId: string; agentId: string; text: string; channel?: string },
  deps: ChatDeps = {},
  emit: (event: ChatEvent) => void = () => {}
) {
  const channel = input.channel ?? "web"
  const now = deps.now ?? new Date()
  const companion = await ensureCompanion(input.ownerId, input.agentId)
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId))
  const [user] = await insertMessages(
    input.agentId,
    [{ role: "user", kind: "chat", content: input.text, channel, metadata: null }],
    now
  )
  emit({ type: "user", message: user })

  // Crisis wording gets a fixed reply before any model call
  if (detectCrisis(input.text)) {
    const replies = await insertMessages(input.agentId, [
      {
        role: "assistant",
        kind: "crisis",
        content: crisisReply(companion.timeZone),
        channel,
        metadata: null,
      },
    ])
    emit({ type: "messages", messages: replies })
    return { user, replies }
  }

  const spec = deps.model
    ? (deps.spec ?? "mock/test")
    : ((await getSetting("model.chat")) ?? (await resolveModelSpec(agent.model)))
  if (!spec) throw new HttpError(409, "先在设置里配置模型服务和模型")
  const price =
    deps.price !== undefined
      ? deps.price
      : findPrice(spec, { custom: await getCustomPrices() })
  const block = monthlyBlock(await monthlyUsage(input.ownerId), price)
  if (block) throw new HttpError(402, block)

  let model = deps.model
  if (!model) {
    const parsed = parseModelSpec(spec)
    if (!parsed) throw new HttpError(409, `不支持的模型：${spec}`)
    model = await createModel(spec, await getProviderCredentials(parsed.provider))
  }

  const [notes, activities, recent] = await Promise.all([
    listNotes(input.agentId),
    db
      .select()
      .from(lifeActivities)
      .where(eq(lifeActivities.agentId, input.agentId))
      .orderBy(desc(lifeActivities.createdAt))
      .limit(8),
    db
      .select()
      .from(companionMessages)
      .where(eq(companionMessages.agentId, input.agentId))
      .orderBy(desc(companionMessages.createdAt), desc(companionMessages.id))
      .limit(HISTORY),
  ])
  const system = buildCompanionPrompt({
    name: agent.name,
    persona: companion.persona,
    mode: companion.mode,
    now: now.toISOString(),
    timeZone: companion.timeZone,
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
  const tools = {
    remember: tool({
      description: "记下一条关于对方的长期信息，一句话。",
      inputSchema: z.object({ note: z.string().trim().min(1).max(500) }),
      execute: async ({ note }) => {
        const saved = await addNote(input.agentId, note, "agent")
        return { id: saved.id, saved: saved.content }
      },
    }),
    update_memory: tool({
      description: "信息变了时，改写一条已有记忆。",
      inputSchema: z.object({ id: z.string(), note: z.string().trim().min(1).max(500) }),
      execute: async ({ id, note }) => {
        const saved = await updateNote(input.agentId, id, note)
        return { id: saved.id, saved: saved.content }
      },
    }),
    forget: tool({
      description: "对方要求忘掉某件事，或记错了，立即删除这条记忆。",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({
        forgotten: (await deleteNote(input.agentId, id)).id,
      }),
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

  const rows: Parameters<typeof insertMessages>[1] = splitBubbles(text).map(
    (content) => ({ role: "assistant", kind: "chat", content, channel, metadata: null })
  )
  for (const goal of proposals)
    rows.push({
      role: "assistant",
      kind: "errand_proposal",
      content: goal,
      channel,
      metadata: { goal, status: "pending" },
    })
  const replies = rows.length ? await insertMessages(input.agentId, rows) : []
  emit({ type: "messages", messages: replies })
  return { user, replies }
}
