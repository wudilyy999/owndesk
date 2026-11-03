// Memory notes are plain rows the person can read, edit and delete. When she wants to remember
// something, a model call decides what happens to the notes (./memory-update.ts, the mem0 way:
// add / update / delete / nothing). Every change the model makes is written to `memory_changes`,
// shown on the memory page, and can be undone with one click.
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db"
import {
  companionMessages,
  memories,
  memoryChanges,
  type Memory,
  type MemoryChange,
  type MemorySnapshot,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { relatedNotes, type MemoryOp, type NoteRef, type Retrieve } from "./memory-update"

const NOTE_LIMIT = 60
const NOTE_CHARS = 12000

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

// The notes that go into the prompt: newest first, capped by count and size
export function selectNotes(notes: { id: string; content: string }[]) {
  const selected: { id: string; content: string }[] = []
  let chars = 0
  for (const note of notes.slice(0, NOTE_LIMIT)) {
    const size = note.content.length + note.id.length + 6
    if (chars + size > NOTE_CHARS) break
    selected.push({ id: note.id, content: note.content })
    chars += size
  }
  return selected
}

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
}

const snapshot = (note: Memory): MemorySnapshot => ({
  content: note.content,
  status: note.status,
  source: note.source,
  createdAt: note.createdAt.toISOString(),
})

async function logChange(
  agentId: string,
  memoryId: string,
  op: "add" | "update" | "delete",
  before: Memory | null,
  after: Memory | null,
  info: ChangeInfo
) {
  const [row] = await db
    .insert(memoryChanges)
    .values({
      agentId,
      memoryId,
      op,
      actor: info.actor,
      origin: info.origin,
      before: before ? snapshot(before) : null,
      after: after ? snapshot(after) : null,
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
    .where(and(eq(memories.agentId, agentId), eq(memories.content, content)))
  if (existing) return existing
  const [note] = await db
    .insert(memories)
    .values({ agentId, content, source, status })
    .returning()
  if (info) await logChange(agentId, note.id, "add", null, note, info)
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
  const [note] = await db
    .update(memories)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning()
  if (!note) throw new HttpError(404, "Note not found for this agent")
  if (info && before.content !== note.content)
    await logChange(agentId, id, "update", before, note, info)
  return note
}

export async function deleteNote(agentId: string, id: string, info?: ChangeInfo) {
  const [removed] = await db
    .delete(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning()
  if (!removed) throw new HttpError(404, "Note not found for this agent")
  await settleCard(id, "dismissed")
  if (info) await logChange(agentId, id, "delete", removed, null, info)
  return { id: removed.id }
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
  // A note waiting for the person's yes (uncertain, sensitive picture, or the update call failed)
  candidate: Memory | null
  // The fact was already known and nothing changed
  known: boolean
  // The update call failed or could not be read, so the fact became a candidate
  fellBack: boolean
}

export type DecideFn = (
  fact: string,
  related: NoteRef[]
) => Promise<{ ops: MemoryOp[] | null }>

export type RememberOptions = {
  certainty: "sure" | "unsure"
  // A face or an ID is in the picture: nothing may be written without the person's yes
  guarded: boolean
  origin: string
  messageId?: string | null
  sourceText?: string | null
  decide: DecideFn
  // Hook for plugging in embeddings when there are many notes
  retrieve?: Retrieve
}

// The model decides; the rules below make sure it can only do what is safe:
// - uncertain facts, and anything while a sensitive picture is in play, never change a note: at
//   most they become a candidate for the person to confirm
// - UPDATE / DELETE only reach notes that were shown to the model (ids are checked on parsing)
// - a failed call or unreadable answer saves the fact as a candidate and deletes nothing
export async function rememberDecided(
  agentId: string,
  fact: string,
  options: RememberOptions
): Promise<Remembered> {
  const done: Remembered = { changes: [], candidate: null, known: false, fellBack: false }
  const info = (reason?: string | null): ChangeInfo => ({
    actor: "model",
    origin: options.origin,
    reason: reason ?? null,
    messageId: options.messageId,
    sourceText: options.sourceText,
  })
  const asCandidate = async () => {
    const note = await addNote(agentId, fact, "agent", "candidate", info("待确认"))
    if (note.status === "candidate") done.candidate = note
    else done.known = true
  }
  if (options.guarded) {
    await asCandidate()
    return done
  }
  const active = await listNotes(agentId, "active")
  // The exact same note: nothing to decide
  if (active.some((note) => note.content === fact)) return { ...done, known: true }
  const related = relatedNotes(
    fact,
    active.map((note) => ({ id: note.id, content: note.content })),
    { retrieve: options.retrieve }
  )
  const { ops } = await options.decide(fact, related)
  if (!ops) {
    done.fellBack = true
    await asCandidate()
    return done
  }
  const real = ops.filter((op) => op.op !== "NONE")
  if (!real.length) return { ...done, known: true }
  if (options.certainty === "unsure") {
    await asCandidate()
    return done
  }
  const shown = new Set(related.map((note) => note.id))
  for (const op of real) {
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
      } else if (op.op === "UPDATE" && shown.has(op.id)) {
        const old = active.find((note) => note.id === op.id)
        const note = await updateNote(agentId, op.id, op.text, info(op.reason))
        if (old && old.content !== note.content)
          done.changes.push({
            op: "update",
            id: note.id,
            before: old.content,
            after: note.content,
            reason: op.reason,
          })
      } else if (op.op === "DELETE" && shown.has(op.id)) {
        const old = active.find((note) => note.id === op.id)
        await deleteNote(agentId, op.id, info(op.reason))
        done.changes.push({
          op: "delete",
          id: op.id,
          before: old?.content ?? null,
          after: null,
          reason: op.reason,
        })
      }
    } catch (error) {
      // A note that vanished meanwhile: skip it, never make up for it with another change
      if (!(error instanceof HttpError)) throw error
    }
  }
  if (!done.changes.length) done.known = true
  return done
}

// ───────────────── change log and undo ─────────────────

export async function listChanges(agentId: string, limit = 40): Promise<MemoryChange[]> {
  return db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.agentId, agentId))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(limit)
}

// Puts the notes back as they were before this change. A change can be undone once.
export async function undoChange(agentId: string, id: string) {
  const [change] = await db
    .select()
    .from(memoryChanges)
    .where(and(eq(memoryChanges.id, id), eq(memoryChanges.agentId, agentId)))
  if (!change) throw new HttpError(404, "Change not found for this agent")
  if (change.undoneAt) throw new HttpError(409, "这条改动已经撤销过了")
  const [claimed] = await db
    .update(memoryChanges)
    .set({ undoneAt: new Date() })
    .where(and(eq(memoryChanges.id, id), isNull(memoryChanges.undoneAt)))
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
      if (existing)
        await db
          .update(memories)
          .set({ content: before.content, status: before.status, updatedAt: new Date() })
          .where(eq(memories.id, change.memoryId))
      else
        await db.insert(memories).values({
          id: change.memoryId,
          agentId,
          content: before.content,
          status: before.status,
          source: before.source,
          createdAt: new Date(before.createdAt),
        })
    }
  } catch (error) {
    await db.update(memoryChanges).set({ undoneAt: null }).where(eq(memoryChanges.id, id))
    throw error
  }
  return { id, op: change.op }
}
