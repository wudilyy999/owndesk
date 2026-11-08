import { and, desc, eq } from "drizzle-orm"
import { db } from "@/db"
import { memories } from "@/db/schema"
import { recallNotes } from "@/lib/companion/memory"

// Initial audit snapshot and each fresh decision use the same bounded view.
export async function taskMemoryContext(agentId: string) {
  const [notes, overview] = await Promise.all([
    db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agentId),
          eq(memories.status, "active"),
          eq(memories.kind, "note")
        )
      )
      .orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(30),
    recallNotes(agentId, { summaries: true }),
  ])
  const selected: string[] = []
  let chars = 0
  for (const note of notes) {
    const line = `- [${note.id}] ${note.content}`
    if (chars + line.length > 12000) break
    selected.unshift(line)
    chars += line.length
  }
  return { memories: selected, memorySummary: JSON.stringify(overview) }
}
