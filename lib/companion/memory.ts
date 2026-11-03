// Memory notes are plain rows the person can read, edit and delete. The model edits them
// through remember / update_memory / forget (Letta-style self-editing memory; mem0's
// add / update / delete operations are the reference for the operation set).
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { db } from "@/db"
import {
  companionMessages,
  memories,
  memorySuggestions,
  type Memory,
  type MemorySuggestion,
} from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { findSimilar, proposeMerge } from "./similar"

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

// The chat card for a candidate follows the note: accepted or dismissed. A merge card whose
// newer note disappears is closed the same way.
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
  await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status: "dropped" })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.kind, "memory_merge"),
        sql`${companionMessages.metadata}->>'status' = 'pending'`,
        or(
          sql`${companionMessages.metadata}->>'memoryId' = ${memoryId}`,
          sql`${companionMessages.metadata}->>'otherId' = ${memoryId}`
        )
      )
    )
}

export async function addNote(
  agentId: string,
  content: string,
  source: "user" | "agent",
  status: "active" | "candidate" = "active"
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
  return note
}

export async function updateNote(agentId: string, id: string, content: string) {
  const [note] = await db
    .update(memories)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning()
  if (!note) throw new HttpError(404, "Note not found for this agent")
  return note
}

export async function deleteNote(agentId: string, id: string) {
  const [removed] = await db
    .delete(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, id)))
    .returning({ id: memories.id })
  if (!removed) throw new HttpError(404, "Note not found for this agent")
  await settleCard(id, "dismissed")
  return removed
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
  // Taking a candidate that looked like an older note as it is means "keep both"
  await closeSuggestions(agentId, "memoryId", id, "kept")
  return note
}

// ───────────────── similar notes: confirm cards, never automatic merging ─────────────────
// Reference for the idea: mem0 and Letta check a new memory against the closest existing ones
// before saving it (both Apache-2.0). Here the check is plain text matching (./similar.ts) and
// the outcome is a card the person answers.

export type SuggestionView = MemorySuggestion & {
  memory: Pick<Memory, "id" | "content" | "status">
  other: Pick<Memory, "id" | "content" | "status">
}

async function closeSuggestions(
  agentId: string,
  column: "memoryId" | "otherId",
  id: string,
  status: "kept" | "dropped"
) {
  const closed = await db
    .update(memorySuggestions)
    .set({ status })
    .where(
      and(
        eq(memorySuggestions.agentId, agentId),
        eq(memorySuggestions[column], id),
        eq(memorySuggestions.status, "pending")
      )
    )
    .returning()
  for (const row of closed) await settleMergeCard(row.id, status)
}

async function settleMergeCard(suggestionId: string, status: string) {
  await db
    .update(companionMessages)
    .set({
      metadata: sql`${companionMessages.metadata} || ${JSON.stringify({ status })}::jsonb`,
    })
    .where(
      and(
        eq(companionMessages.kind, "memory_merge"),
        sql`${companionMessages.metadata}->>'suggestionId' = ${suggestionId}`
      )
    )
}

// Is there already a decision (pending or made) about these two notes?
async function pairKnown(a: string, b: string) {
  const [row] = await db
    .select({ id: memorySuggestions.id })
    .from(memorySuggestions)
    .where(
      or(
        and(eq(memorySuggestions.memoryId, a), eq(memorySuggestions.otherId, b)),
        and(eq(memorySuggestions.memoryId, b), eq(memorySuggestions.otherId, a))
      )
    )
  return !!row
}

// Looks for the closest active note that is not the same note, and records a pending
// suggestion for the pair. Returns null when nothing is close or the pair was already decided.
export async function suggestMerge(
  agentId: string,
  note: Pick<Memory, "id" | "content">
) {
  const others = (await listNotes(agentId, "active")).filter((row) => row.id !== note.id)
  for (const hit of findSimilar(note.content, others, 3)) {
    if (await pairKnown(note.id, hit.note.id)) continue
    const [row] = await db
      .insert(memorySuggestions)
      .values({
        agentId,
        memoryId: note.id,
        otherId: hit.note.id,
        mergedText: proposeMerge(hit.note.content, note.content),
        score: Math.round(hit.score * 100),
      })
      .onConflictDoNothing()
      .returning()
    if (row) return { suggestion: row, other: hit.note }
  }
  return null
}

// A note the companion wants to write down. If it resembles an active note it is held back as a
// candidate and a merge suggestion is made instead of a second, near-identical note.
export async function rememberChecked(
  agentId: string,
  content: string,
  status: "active" | "candidate"
) {
  const [exact] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.content, content)))
  if (exact) return { note: exact, similar: null }
  const hits = findSimilar(content, await listNotes(agentId, "active"), 1)
  if (!hits.length)
    return { note: await addNote(agentId, content, "agent", status), similar: null }
  const note = await addNote(agentId, content, "agent", "candidate")
  const made = await suggestMerge(agentId, note)
  return { note, similar: made }
}

export async function listSuggestions(agentId: string): Promise<SuggestionView[]> {
  const rows = await db
    .select()
    .from(memorySuggestions)
    .where(
      and(eq(memorySuggestions.agentId, agentId), eq(memorySuggestions.status, "pending"))
    )
    .orderBy(desc(memorySuggestions.createdAt))
  if (!rows.length) return []
  const notes = await db
    .select({ id: memories.id, content: memories.content, status: memories.status })
    .from(memories)
    .where(
      inArray(memories.id, [...new Set(rows.flatMap((r) => [r.memoryId, r.otherId]))])
    )
  const byId = new Map(notes.map((note) => [note.id, note]))
  return rows.flatMap((row) => {
    const memory = byId.get(row.memoryId)
    const other = byId.get(row.otherId)
    return memory && other ? [{ ...row, memory, other }] : []
  })
}

// Looks through the active notes for pairs that resemble each other (the memory page button).
// Only creates suggestions; the older note of a pair is the one that stays on a merge.
export async function scanSimilar(agentId: string) {
  const notes = (await listNotes(agentId, "active")).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )
  let created = 0
  for (const [index, note] of notes.entries()) {
    const older = notes.slice(0, index)
    for (const hit of findSimilar(note.content, older, 1)) {
      if (await pairKnown(note.id, hit.note.id)) continue
      await db.insert(memorySuggestions).values({
        agentId,
        memoryId: note.id,
        otherId: hit.note.id,
        mergedText: proposeMerge(hit.note.content, note.content),
        score: Math.round(hit.score * 100),
      })
      created++
    }
  }
  return created
}

// The person's answer. merge: the older note takes the merged wording and the newer one is
// removed; keep: both stay (a candidate becomes a note); drop: the newer one is removed.
export async function resolveSuggestion(
  agentId: string,
  id: string,
  action: "merge" | "keep" | "drop",
  mergedText?: string
) {
  const [row] = await db
    .select()
    .from(memorySuggestions)
    .where(
      and(
        eq(memorySuggestions.id, id),
        eq(memorySuggestions.agentId, agentId),
        eq(memorySuggestions.status, "pending")
      )
    )
  if (!row) throw new HttpError(404, "Suggestion not found for this agent")
  if (action === "keep") {
    await db
      .update(memories)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(memories.agentId, agentId), eq(memories.id, row.memoryId)))
    await db
      .update(memorySuggestions)
      .set({ status: "kept" })
      .where(eq(memorySuggestions.id, id))
    await settleMergeCard(id, "kept")
    return { action }
  }
  if (action === "merge") {
    await updateNote(agentId, row.otherId, (mergedText ?? row.mergedText).trim())
  }
  // The suggestion row goes with the newer note (cascade); the card keeps the outcome
  await settleMergeCard(id, action === "merge" ? "merged" : "dropped")
  await db
    .delete(memories)
    .where(and(eq(memories.agentId, agentId), eq(memories.id, row.memoryId)))
  return { action }
}
