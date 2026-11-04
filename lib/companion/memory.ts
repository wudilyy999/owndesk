// Memory notes are plain rows the person can read, edit and delete. The model looks after them:
// when she wants to remember something it decides what happens to the notes (./memory-update.ts),
// and now and then she tidies them into topic summaries (./consolidate.ts). Every change the
// model makes is written to `memory_changes`, shown on the memory page, and can be undone with one
// click.
import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { db } from "@/db"
import {
  companionMessages,
  companions,
  memories,
  memoryChanges,
  type Memory,
  type MemoryChange,
  type MemorySnapshot,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import type { MemoryOp, MemoryView } from "./memory-update"

export async function listNotes(agentId: string, status?: "active" | "candidate") {
  return db
    .select()
    .from(memories)
    .where(
      status
        ? and(eq(memories.agentId, agentId), eq(memories.status, status))
        : eq(memories.agentId, agentId)
    )
    .orderBy(desc(memories.updatedAt), desc(memories.id))
}

// Everything she knows about the person: the topic summaries and every active note. Nothing is
// cut: what she cannot fit into a prompt she reads page by page.
export async function memoryView(agentId: string): Promise<MemoryView> {
  const rows = await listNotes(agentId, "active")
  return {
    summaries: rows
      .filter((row) => row.kind === "summary")
      .map((row) => ({ id: row.id, topic: row.topic ?? "", content: row.content })),
    notes: rows
      .filter((row) => row.kind === "note")
      .map((row) => ({ id: row.id, content: row.content, summaryId: row.summaryId })),
  }
}

// How much text one page holds. This is a reading window (what fits comfortably in one model
// call), not a limit on memory: more notes simply mean more pages.
export const PAGE_CHARS = 6000

// Splits notes into pages of at most `chars` (a single long note gets a page of its own)
export function paginate<T extends { content: string }>(notes: T[], chars = PAGE_CHARS) {
  const pages: T[][] = []
  let size = 0
  for (const note of notes) {
    const cost = note.content.length + 8
    if (!pages.length || size + cost > chars) {
      pages.push([])
      size = 0
    }
    pages.at(-1)!.push(note)
    size += cost
  }
  return pages
}

// What she asks for with `recall_memory` during a chat: the detailed notes under one of her topic
// summaries, or all notes page by page. She picks the topic or the page herself.
export async function recallNotes(
  agentId: string,
  query: { topic?: string; page?: number }
) {
  const view = await memoryView(agentId)
  const topics = view.summaries.map((summary) => summary.topic)
  const topic = query.topic?.trim()
  if (topic) {
    const summary = view.summaries.find((item) => item.topic === topic)
    if (!summary)
      return { error: `没有叫“${topic}”的主题`, topics, unsorted: unsorted(view) }
    return {
      topic,
      summary: summary.content,
      notes: view.notes
        .filter((note) => note.summaryId === summary.id)
        .map((note) => ({ id: note.id, content: note.content })),
    }
  }
  const pages = paginate(view.notes)
  const page = Math.min(Math.max(query.page ?? 1, 1), Math.max(pages.length, 1))
  return {
    page,
    pages: pages.length,
    notes: (pages[page - 1] ?? []).map((note) => ({
      id: note.id,
      content: note.content,
      topic: view.summaries.find((item) => item.id === note.summaryId)?.topic ?? null,
    })),
  }
}

const unsorted = (view: MemoryView) => view.notes.filter((note) => !note.summaryId).length

// The chat card for a candidate follows the note: accepted or dismissed
async function settleCard(memoryId: string, status: "accepted" | "dismissed") {
  await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.kind, "memory_candidate"),
        sql`${companionMessages.metadata}->>'memoryId' = ${memoryId}`
      )
    )
}

export type ChangeInfo = {
  actor: "model" | "user"
  origin: string
  reason?: string | null
  messageId?: string | null
  sourceText?: string | null
  // Changes made together share a group and are undone together
  groupId?: string | null
}

const snapshot = async (note: Memory): Promise<MemorySnapshot> => ({
  content: note.content,
  status: note.status,
  source: note.source,
  createdAt: note.createdAt.toISOString(),
  kind: note.kind,
  topic: note.topic,
  summaryId: note.summaryId,
  ...(note.kind === "summary" ? { covers: await coveredBy(note.id) } : {}),
})

async function coveredBy(summaryId: string) {
  return (
    await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.summaryId, summaryId))
      .orderBy(asc(memories.createdAt), asc(memories.id))
  ).map((row) => row.id)
}

async function logChange(
  agentId: string,
  memoryId: string,
  op: "add" | "update" | "delete",
  before: MemorySnapshot | null,
  after: MemorySnapshot | null,
  info: ChangeInfo
) {
  const [row] = await db
    .insert(memoryChanges)
    .values({
      agentId,
      memoryId,
      op,
      groupId: info.groupId ?? null,
      actor: info.actor,
      origin: info.origin,
      before,
      after,
      reason: info.reason ?? null,
      messageId: info.messageId ?? null,
      sourceText: info.sourceText?.slice(0, 300) ?? null,
    })
    .returning()
  return row
}

// `info` makes the change appear in the change log (and be undoable); without it nothing is logged
export async function addNote(
  agentId: string,
  content: string,
  source: "user" | "agent",
  status: "active" | "candidate" = "active",
  info?: ChangeInfo
) {
  const [existing] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.agentId, agentId),
        eq(memories.kind, "note"),
        eq(memories.content, content)
      )
    )
  if (existing) return existing
  const [note] = await db
    .insert(memories)
    .values({ agentId, content, source, status })
    .returning()
  if (info) await logChange(agentId, note.id, "add", null, await snapshot(note), info)
  return note
}

export async function updateNote(
  agentId: string,
  id: string,
  content: string,
  info?: ChangeInfo
) {
  const [before] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
  if (!before) throw new HttpError(404, "Note not found for this agent")
  const beforeSnapshot = await snapshot(before)
  const [note] = await db
    .update(memories)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning()
  if (info && before.content !== note.content)
    await logChange(agentId, id, "update", beforeSnapshot, await snapshot(note), info)
  return note
}

export async function deleteNote(agentId: string, id: string, info?: ChangeInfo) {
  const [before] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
  if (!before) throw new HttpError(404, "Note not found for this agent")
  const beforeSnapshot = await snapshot(before)
  const [removed] = await db
    .delete(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning()
  if (!removed) throw new HttpError(404, "Note not found for this agent")
  await settleCard(id, "dismissed")
  if (info) await logChange(agentId, id, "delete", beforeSnapshot, null, info)
  return { id: removed.id }
}

// Several notes say one thing: the first one (the oldest in the list given) takes the new wording,
// the others go. Logged as changes of one group, so one click undoes the whole merge.
export async function mergeNotes(
  agentId: string,
  ids: string[],
  content: string,
  info: ChangeInfo
) {
  const found = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.agentId, agentId),
        eq(memories.kind, "note"),
        inArray(memories.id, ids)
      )
    )
  if (found.length < 2)
    throw new HttpError(404, "Notes to merge not found for this agent")
  const keep = ids.find((id) => found.some((note) => note.id === id))!
  const grouped = { ...info, groupId: info.groupId ?? randomUUID() }
  // The merged note covers what the merged notes belonged to
  const summaryId = found.find((note) => note.summaryId)?.summaryId ?? null
  const updated = await updateNote(agentId, keep, content, grouped)
  if (!updated.summaryId && summaryId)
    await db.update(memories).set({ summaryId }).where(eq(memories.id, keep))
  for (const note of found)
    if (note.id !== keep) await deleteNote(agentId, note.id, grouped)
  return { id: keep, removed: found.filter((note) => note.id !== keep).map((n) => n.id) }
}

// Writes (or rewrites) a topic summary and links the notes it covers. An existing summary keeps
// the notes it already covered.
export async function saveSummary(
  agentId: string,
  input: { id: string | null; topic: string; content: string; covers: string[] },
  info: ChangeInfo
) {
  const [byId] = input.id
    ? await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.agentId, agentId),
            eq(memories.id, input.id),
            eq(memories.kind, "summary")
          )
        )
    : []
  const [byTopic] = byId
    ? []
    : await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.agentId, agentId),
            eq(memories.kind, "summary"),
            eq(memories.topic, input.topic)
          )
        )
  const existing = byId ?? byTopic
  const covers = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.agentId, agentId),
        eq(memories.kind, "note"),
        input.covers.length ? inArray(memories.id, input.covers) : sql`false`
      )
    )
  if (!existing) {
    const [created] = await db
      .insert(memories)
      .values({
        agentId,
        kind: "summary",
        topic: input.topic,
        content: input.content,
        source: "agent",
      })
      .returning()
    if (covers.length)
      await db
        .update(memories)
        .set({ summaryId: created.id })
        .where(
          inArray(
            memories.id,
            covers.map((row) => row.id)
          )
        )
    await logChange(agentId, created.id, "add", null, await snapshot(created), info)
    return created
  }
  const before = await snapshot(existing)
  if (covers.length)
    await db
      .update(memories)
      .set({ summaryId: existing.id })
      .where(
        inArray(
          memories.id,
          covers.map((row) => row.id)
        )
      )
  const [saved] = await db
    .update(memories)
    .set({ content: input.content, topic: input.topic, updatedAt: new Date() })
    .where(eq(memories.id, existing.id))
    .returning()
  const after = await snapshot(saved)
  const same =
    before.content === after.content &&
    before.topic === after.topic &&
    JSON.stringify(before.covers) === JSON.stringify(after.covers)
  if (!same) await logChange(agentId, existing.id, "update", before, after, info)
  return saved
}

// The person confirms or rejects something the companion was unsure about. Only
// accepted notes reach the prompt and the errand agent.
export async function reviewCandidate(
  agentId: string,
  id: string,
  action: "accept" | "dismiss"
) {
  if (action === "dismiss") return deleteNote(agentId, id)
  const [note] = await db
    .update(memories)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(memories.agentId, agentId),
        eq(memories.id, id),
        eq(memories.status, "candidate")
      )
    )
    .returning()
  if (!note) throw new HttpError(404, "Candidate not found for this agent")
  await settleCard(id, "accepted")
  return note
}

// ───────────────── she wants to remember something ─────────────────

export type AppliedChange = {
  op: "add" | "update" | "delete"
  id: string
  before: string | null
  after: string | null
  reason: string | null
}

export type Remembered = {
  // What happened to the notes (active ones only; a candidate is reported separately)
  changes: AppliedChange[]
  // A note waiting for the person's yes (the model asked, a sensitive picture, or the call failed)
  candidate: Memory | null
  // The fact was already known and nothing changed
  known: boolean
  // The update call failed or could not be read, so the fact became a candidate
  fellBack: boolean
  // The model asked for a tidy-up
  organize: boolean
}

export type DecideFn = (
  fact: string,
  view: MemoryView
) => Promise<{ ops: MemoryOp[] | null }>

export type RememberOptions = {
  // A face or an ID is in the picture: nothing may be written without the person's yes
  guarded: boolean
  origin: string
  messageId?: string | null
  sourceText?: string | null
  decide: DecideFn
}

// The model decides what happens to her notes. Two guardrails stand beside that:
// - a failed call or an unreadable answer keeps the fact as a candidate and deletes nothing
// - while a sensitive picture is in play nothing is written; at most a candidate for the person
// Which notes and summaries an operation may touch is checked when the answer is read (ids come
// from the numbers the model was shown).
export async function rememberDecided(
  agentId: string,
  fact: string,
  options: RememberOptions
): Promise<Remembered> {
  const done: Remembered = {
    changes: [],
    candidate: null,
    known: false,
    fellBack: false,
    organize: false,
  }
  const asCandidate = async (text: string, reason?: string | null) => {
    const note = await addNote(agentId, text, "agent", "candidate", {
      actor: "model",
      origin: options.origin,
      reason: reason ?? "待确认",
      messageId: options.messageId,
      sourceText: options.sourceText,
    })
    if (note.status === "candidate") done.candidate = note
    else done.known = true
  }
  if (options.guarded) {
    await asCandidate(fact)
    return done
  }
  const view = await memoryView(agentId)
  // The exact same note: nothing to decide
  if (view.notes.some((note) => note.content === fact)) return { ...done, known: true }
  const { ops } = await options.decide(fact, view)
  if (!ops) {
    done.fellBack = true
    await asCandidate(fact)
    return done
  }
  const edits = ops.filter((op) => !["NONE", "ASK", "ORGANIZE"].includes(op.op))
  const group = randomUUID()
  const info = (reason?: string | null): ChangeInfo => ({
    actor: "model",
    origin: options.origin,
    reason: reason ?? null,
    messageId: options.messageId,
    sourceText: options.sourceText,
    groupId: edits.length > 1 ? group : null,
  })
  const text = new Map<string, string>([
    ...view.notes.map((note) => [note.id, note.content] as const),
    ...view.summaries.map((summary) => [summary.id, summary.content] as const),
  ])
  for (const op of ops) {
    try {
      if (op.op === "ADD") {
        const before = done.changes.length
        const note = await addNote(agentId, op.text, "agent", "active", info())
        if (note.content === op.text && note.status === "active")
          done.changes.push({
            op: "add",
            id: note.id,
            before: null,
            after: note.content,
            reason: null,
          })
        else if (before === done.changes.length) done.known = true
      } else if (op.op === "UPDATE") {
        const note = await updateNote(agentId, op.id, op.text, info(op.reason))
        if (text.get(op.id) !== note.content)
          done.changes.push({
            op: "update",
            id: note.id,
            before: text.get(op.id) ?? null,
            after: note.content,
            reason: op.reason,
          })
      } else if (op.op === "DELETE") {
        await deleteNote(agentId, op.id, info(op.reason))
        done.changes.push({
          op: "delete",
          id: op.id,
          before: text.get(op.id) ?? null,
          after: null,
          reason: op.reason,
        })
      } else if (op.op === "MERGE") {
        const merged = await mergeNotes(agentId, op.ids, op.text, info(op.reason))
        done.changes.push({
          op: "update",
          id: merged.id,
          before: text.get(merged.id) ?? null,
          after: op.text,
          reason: op.reason,
        })
        for (const id of merged.removed)
          done.changes.push({
            op: "delete",
            id,
            before: text.get(id) ?? null,
            after: null,
            reason: op.reason,
          })
      } else if (op.op === "ASK") {
        await asCandidate(op.text, op.reason)
      } else if (op.op === "ORGANIZE") {
        done.organize = true
        await db
          .update(companions)
          .set({ memoryOrganizeRequested: true })
          .where(eq(companions.agentId, agentId))
      }
    } catch (error) {
      // A note that vanished meanwhile: skip it, never make up for it with another change
      if (!(error instanceof HttpError)) throw error
    }
  }
  if (!done.changes.length && !done.candidate) done.known = true
  return done
}

// ───────────────── change log and undo ─────────────────

export async function listChanges(agentId: string, limit = 80): Promise<MemoryChange[]> {
  return db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.agentId, agentId))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(limit)
}

// Puts one change back as it was.
async function undoOne(agentId: string, change: MemoryChange) {
  const [claimed] = await db
    .update(memoryChanges)
    .set({ undoneAt: new Date() })
    .where(and(eq(memoryChanges.id, change.id), isNull(memoryChanges.undoneAt)))
    .returning({ id: memoryChanges.id })
  if (!claimed) throw new HttpError(409, "这条改动已经撤销过了")
  try {
    if (change.op === "add") {
      await db
        .delete(memories)
        .where(and(eq(memories.agentId, agentId), eq(memories.id, change.memoryId)))
      await settleCard(change.memoryId, "dismissed")
    } else if (change.before) {
      const before = change.before
      const [existing] = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.agentId, agentId), eq(memories.id, change.memoryId)))
      // The summary a note belonged to may be gone by now
      const [summary] = before.summaryId
        ? await db
            .select({ id: memories.id })
            .from(memories)
            .where(eq(memories.id, before.summaryId))
        : []
      const restored = {
        content: before.content,
        status: before.status,
        kind: before.kind ?? "note",
        topic: before.topic ?? null,
        updatedAt: new Date(),
      }
      // An edited note keeps the summary it belongs to now; a deleted one returns to its old one
      if (existing)
        await db.update(memories).set(restored).where(eq(memories.id, change.memoryId))
      else
        await db.insert(memories).values({
          id: change.memoryId,
          agentId,
          ...restored,
          summaryId: summary?.id ?? null,
          source: before.source,
          createdAt: new Date(before.createdAt),
        })
      if (before.covers) {
        // A summary covers again exactly what it covered before
        await db
          .update(memories)
          .set({ summaryId: null })
          .where(
            and(
              eq(memories.summaryId, change.memoryId),
              before.covers.length ? notInArray(memories.id, before.covers) : undefined
            )
          )
        if (before.covers.length)
          await db
            .update(memories)
            .set({ summaryId: change.memoryId })
            .where(
              and(eq(memories.agentId, agentId), inArray(memories.id, before.covers))
            )
      }
    }
  } catch (error) {
    await db
      .update(memoryChanges)
      .set({ undoneAt: null })
      .where(eq(memoryChanges.id, change.id))
    throw error
  }
}

// Puts the notes back as they were before this change. Changes made together (a merge, a whole
// tidy-up) are undone together, newest first. A change can be undone once.
export async function undoChange(agentId: string, id: string) {
  const [change] = await db
    .select()
    .from(memoryChanges)
    .where(and(eq(memoryChanges.id, id), eq(memoryChanges.agentId, agentId)))
  if (!change) throw new HttpError(404, "Change not found for this agent")
  if (change.undoneAt) throw new HttpError(409, "这条改动已经撤销过了")
  const batch = change.groupId
    ? await db
        .select()
        .from(memoryChanges)
        .where(
          and(
            eq(memoryChanges.agentId, agentId),
            eq(memoryChanges.groupId, change.groupId),
            isNull(memoryChanges.undoneAt)
          )
        )
        .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    : [change]
  for (const item of batch) await undoOne(agentId, item)
  return { id, op: change.op, undone: batch.length }
}
