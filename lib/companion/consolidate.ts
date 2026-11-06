// Her tidy-up. Now and then she reads through her notes and rewrites the loose ones into topic
// summaries ("关于你" blocks such as 饮食习惯, 工作近况), merges duplicates and removes what no longer
// holds. The model decides all of it (./memory-update.ts, `decideOrganizing`); this file only feeds
// it the notes page by page, so that any amount of notes fits the model's context, and applies the
// answer. Every change is written to the change log under one group, so the whole run can be
// undone with one click. The idea follows Letta / MemGPT's background "sleep-time" memory rewrite
// (letta-ai/letta, Apache-2.0; see THIRD_PARTY.md); the code is our own.
import { randomUUID } from "node:crypto"
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm"
import type { LanguageModel } from "ai"
import { db } from "@/db"
import { agents, companions, memories } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { findPrice, type Price } from "@/lib/providers/pricing"
import {
  createModel,
  getProviderCredentials,
  resolveModelSpec,
} from "@/lib/providers/registry"
import { createModelWithFallback, withModelFallback } from "@/lib/providers/fallback"
import { parseModelSpec } from "@/lib/providers/catalog"
import { getSetting } from "@/lib/config"
import { getCustomPrices, monthlyBlock, monthlyUsage } from "@/lib/spend"
import { recordUsage } from "./chat"
import {
  deleteNote,
  mergeNotes,
  memoryView,
  paginate,
  saveSummary,
  updateNote,
} from "./memory"
import {
  decideOrganizing,
  type MemoryOp,
  type MemoryView,
  type Usage,
} from "./memory-update"

// The periodic schedule: at most one tidy-up per day, and only when a note changed since the last
export const ORGANIZE_EVERY_MS = 24 * 60 * 60 * 1000

export type OrganizeDeps = {
  // Replaces the model call (tests, or another provider)
  decide?: (
    view: MemoryView,
    page: { index: number; total: number }
  ) => Promise<{ ops: MemoryOp[] | null; usage?: Usage }>
  model?: LanguageModel
  spec?: string
  price?: Price | null
  now?: Date
}

export type Organized = {
  pages: number
  // Pages whose answer could not be used (nothing was changed for them)
  failedPages: number
  changes: number
  groupId: string | null
}

async function modelFor(agentId: string, ownerId: string, deps: OrganizeDeps) {
  if (deps.model)
    return {
      model: deps.model,
      spec: deps.spec ?? "mock/test",
      price: deps.price ?? null,
      providerOptions: undefined,
    }
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))
  let spec = (await getSetting("model.chat")) ?? (await resolveModelSpec(agent.model))
  if (!spec) throw new HttpError(409, "先在设置里配置模型服务和模型")
  const fallback = (await getSetting("model.fallback"))?.trim() || null
  let price = findPrice(spec, { custom: await getCustomPrices() })
  const block = monthlyBlock(await monthlyUsage(ownerId), price)
  if (block) throw new HttpError(402, block)
  if (!parseModelSpec(spec)) throw new HttpError(409, `不支持的模型：${spec}`)
  const created = await createModelWithFallback(
    spec,
    fallback && fallback !== spec ? fallback : null
  )
  spec = created.spec
  if (created.usedFallback) price = findPrice(spec, { custom: await getCustomPrices() })
  const parsed = parseModelSpec(spec)!
  const providerOptions =
    parsed.provider === "custom" || parsed.provider === "openrouter"
      ? { [parsed.provider]: { reasoningEffort: "low" } }
      : undefined
  return { model: created.model, spec, price, providerOptions }
}

// One tidy-up over all active notes. The caller decides when (see `organizeDue`).
export async function organizeMemory(
  agentId: string,
  deps: OrganizeDeps = {}
): Promise<Organized> {
  const [companion] = await db
    .select()
    .from(companions)
    .where(eq(companions.agentId, agentId))
  if (!companion) throw new HttpError(404, "Companion not found")
  const { model, spec, price, providerOptions } = deps.decide
    ? { model: null, spec: "", price: null, providerOptions: undefined }
    : await modelFor(agentId, companion.ownerId, deps)
  const fallbackSpec = (await getSetting("model.fallback"))?.trim() || null
  const decide =
    deps.decide ??
    (async (view: MemoryView, page: { index: number; total: number }) => {
      if (!spec) return decideOrganizing(model!, view, page, { providerOptions })
      const { result } = await withModelFallback({
        primarySpec: spec,
        fallbackSpec: fallbackSpec && fallbackSpec !== spec ? fallbackSpec : null,
        run: async (m) => decideOrganizing(m, view, page, { providerOptions }),
      })
      return result
    })
  const groupId = randomUUID()
  const info = (reason: string | null) => ({
    actor: "model" as const,
    origin: "organize",
    reason,
    groupId,
  })
  const first = await memoryView(agentId)
  const pages = paginate(
    [...first.notes].reverse() // oldest first
  )
  const result: Organized = {
    pages: pages.length,
    failedPages: 0,
    changes: 0,
    groupId: null,
  }
  for (const [index, page] of pages.entries()) {
    // Earlier pages may have merged or removed notes of this page, and rewritten summaries
    const now = await memoryView(agentId)
    const ids = new Set(page.map((note) => note.id))
    const view = {
      summaries: now.summaries,
      notes: now.notes.filter((n) => ids.has(n.id)),
    }
    if (!view.notes.length) continue
    const started = Date.now()
    const decision = await decide(view, { index, total: pages.length })
    if (decision.usage)
      await recordUsage(agentId, spec, price, decision.usage, Date.now() - started)
    if (!decision.ops) {
      result.failedPages++
      continue
    }
    for (const op of decision.ops) {
      try {
        if (op.op === "UPDATE") {
          await updateNote(agentId, op.id, op.text, info(op.reason))
          result.changes++
        } else if (op.op === "DELETE") {
          await deleteNote(agentId, op.id, info(op.reason))
          result.changes++
        } else if (op.op === "MERGE") {
          await mergeNotes(agentId, op.ids, op.text, info(op.reason))
          result.changes++
        } else if (op.op === "SUMMARIZE") {
          await saveSummary(
            agentId,
            { id: op.id, topic: op.topic, content: op.text, covers: op.ids },
            info(op.reason)
          )
          result.changes++
        }
      } catch (error) {
        // A note that vanished meanwhile: skip it
        if (!(error instanceof HttpError)) throw error
      }
    }
  }
  if (result.changes) result.groupId = groupId
  return result
}

// Which companions are due: she asked for a tidy-up herself, or a day has passed and a note
// changed since the last one.
export async function organizeDue(now = new Date()) {
  const rows = await db.select().from(companions)
  const due: string[] = []
  for (const companion of rows) {
    const since = companion.memoryOrganizedAt ?? companion.createdAt
    const [changed] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.agentId, companion.agentId),
          eq(memories.kind, "note"),
          eq(memories.status, "active"),
          companion.memoryOrganizedAt
            ? gt(memories.updatedAt, companion.memoryOrganizedAt)
            : sql`true`
        )
      )
      .limit(1)
    if (
      companion.memoryOrganizeRequested ||
      (changed && now.getTime() - since.getTime() >= ORGANIZE_EVERY_MS)
    )
      due.push(companion.agentId)
  }
  return due
}

// Called by the worker's dispatcher. The run is claimed first, so a failing model call is not
// repeated every few seconds.
export async function organizeTick(now = new Date(), deps: OrganizeDeps = {}) {
  const done: { agentId: string; result: Organized }[] = []
  for (const agentId of await organizeDue(now)) {
    const [claimed] = await db
      .update(companions)
      .set({ memoryOrganizedAt: now, memoryOrganizeRequested: false })
      .where(
        and(
          eq(companions.agentId, agentId),
          or(isNull(companions.memoryOrganizedAt), lt(companions.memoryOrganizedAt, now))
        )
      )
      .returning({ agentId: companions.agentId })
    if (!claimed) continue
    try {
      done.push({ agentId, result: await organizeMemory(agentId, { ...deps, now }) })
    } catch (error) {
      // A failed tidy-up changes nothing; the next one is due at the next interval or request
      console.error(`memory tidy-up failed for ${agentId}`, (error as Error).message)
    }
  }
  return done
}

// The person asked for it
export async function organizeNow(agentId: string, deps: OrganizeDeps = {}) {
  const result = await organizeMemory(agentId, deps)
  await db
    .update(companions)
    .set({ memoryOrganizedAt: deps.now ?? new Date(), memoryOrganizeRequested: false })
    .where(eq(companions.agentId, agentId))
  return result
}
