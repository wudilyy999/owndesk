// Memory notes are plain rows the person can read, edit and delete. The model edits them
// through remember / update_memory / forget (Letta-style self-editing memory; mem0's
// add / update / delete operations are the reference for the operation set).
import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { companionMessages, memories } from "@/db/schema"
import { HttpError } from "@/lib/errors"

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
  return note
}
