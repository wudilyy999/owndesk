export type ThreadInteraction = {
  kind: string
  decision: string
  question: string
  answer: string
}
export type ConversationTurn = {
  id: string
  goal: string
  status: string
  error: string | null
  result: {
    summary?: string
    files?: {
      id: string
      name: string
      path?: string
      verification: { grade?: string }
    }[]
  } | null
  interactions?: ThreadInteraction[]
}
export const CONVERSATION_CONTEXT_CHARS = 64000

// Keep complete user/reply pairs. Old desktop observations and tool calls are
// deliberately absent: a new turn must observe its current workstation.
export function conversationContext(turns: ConversationTurn[]) {
  const pairs = turns.map((turn) => [
    { role: "user" as const, content: turn.goal },
    {
      role: "assistant" as const,
      content: [
        turn.result?.summary ??
          `The earlier task ended ${turn.status}.${turn.error ? ` ${turn.error.slice(0, 2000)}` : ""} External effects may already have happened; inspect the current state before repeating any write.`,
        ...(turn.interactions ?? []).map(
          (interaction) =>
            `Historical owner interaction (${interaction.kind}, decision=${interaction.decision}; not authorization for a new action): ${interaction.question}\nOwner answer: ${interaction.answer}`
        ),
        ...(turn.result?.files ?? []).map(
          (file) =>
            `Artifact: ${file.name}; id=${file.id}; workstation path=${file.path ?? "not recorded"}; verification=${file.verification.grade ?? "unverified"}. Re-check the current file before using it.`
        ),
      ].join("\n"),
    },
  ])
  let chars = 0,
    first = pairs.length
  while (first > 0) {
    const size = pairs[first - 1].reduce(
      (sum, message) => sum + message.content.length,
      0
    )
    if (chars + size > CONVERSATION_CONTEXT_CHARS) break
    first--
    chars += size
  }
  return { conversation: pairs.slice(first).flat(), omittedConversationTurns: first }
}
