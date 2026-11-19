import { memoryView } from "@/lib/companion/memory"

// Like the chat prompt: every topic summary first, then the notes not sorted into a topic, then
// the newest sorted notes while room is left. Whatever does not fit is counted, never silently
// dropped, and stays readable through recall_memory. Initial snapshot and each decision share it.
export const MEMORY_SUMMARY_CHARS = 16_000
export const MEMORY_NOTE_CHARS = 12_000

export async function taskMemoryContext(agentId: string) {
  const view = await memoryView(agentId)
  const summaries: string[] = []
  let chars = 0
  for (const summary of view.summaries) {
    const line = `- [${summary.id}] ${summary.topic}: ${summary.content}`
    if (chars + line.length > MEMORY_SUMMARY_CHARS) break
    summaries.push(line)
    chars += line.length
  }
  const notes: string[] = []
  chars = 0
  const ordered = [
    ...view.notes.filter((note) => !note.summaryId),
    ...view.notes.filter((note) => note.summaryId),
  ]
  for (const note of ordered) {
    const line = `- [${note.id}] ${note.content}`
    // Stop at the first note that does not fit, so the prompt keeps a contiguous newest run
    if (chars + line.length > MEMORY_NOTE_CHARS) break
    notes.push(line)
    chars += line.length
  }
  const missing = [
    view.summaries.length > summaries.length
      ? `${view.summaries.length - summaries.length} topic summaries`
      : "",
    view.notes.length > notes.length ? `${view.notes.length - notes.length} notes` : "",
  ].filter(Boolean)
  return {
    memories: notes,
    memorySummary: [
      summaries.join("\n"),
      missing.length
        ? `Not shown here (read them with recall_memory when relevant): ${missing.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}
