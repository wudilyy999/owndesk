import { memoryView } from "@/lib/companion/memory"

import type { MemoryView } from "@/lib/companion/memory-update"
import {
  DEFAULT_CONTEXT_LIMITS,
  estimateContextTokens,
  fittingPrefix,
  inputBudget,
} from "@/lib/agent/context"

// Long-term records remain individually addressable. This is the initial reading allowance;
// omitted entries are still available from recall_memory without overwriting any history.
export function promptMemory(view: MemoryView, room: number, includeGrouped = false) {
  const allowance = Math.max(0, Math.floor(room / 5))
  const first = fittingPrefix(
    view.summaries.length,
    (n) => estimateContextTokens(view.summaries.slice(0, n)) <= allowance
  )
  const summaries = view.summaries.slice(0, first)
  const notes = [
    ...view.notes.filter((n) => !n.summaryId),
    ...(includeGrouped ? view.notes.filter((n) => n.summaryId) : []),
  ]
  const count = fittingPrefix(
    notes.length,
    (n) => estimateContextTokens([summaries, notes.slice(0, n)]) <= allowance
  )
  return {
    summaries,
    notes: notes.slice(0, count),
    omittedSummaries: view.summaries.length - first,
    omittedNotes: notes.length - count,
  }
}

export async function taskMemoryContext(
  agentId: string,
  window = DEFAULT_CONTEXT_LIMITS.window
) {
  const read = promptMemory(
    await memoryView(agentId),
    inputBudget(window, DEFAULT_CONTEXT_LIMITS.output),
    true
  )
  const missing = [
    read.omittedSummaries && `${read.omittedSummaries} topic summaries`,
    read.omittedNotes && `${read.omittedNotes} notes`,
  ].filter(Boolean)
  return {
    memories: read.notes.map((n) => `- [${n.id}] ${n.content}`),
    memorySummary: [
      ...read.summaries.map((s) => `- [${s.id}] ${s.topic}: ${s.content}`),
      missing.length
        ? `Not shown here (outside the memory reading allowance): ${missing.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}
