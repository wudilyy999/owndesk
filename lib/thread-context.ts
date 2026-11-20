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
export function conversationContext(turns: ConversationTurn[]) {
  return turns.flatMap((turn) => [
    { role: "user" as const, content: turn.goal },
    {
      role: "assistant" as const,
      content: [
        turn.result?.summary ??
          `The earlier task ended ${turn.status}.${turn.error ? ` ${turn.error}` : ""} External effects may already have happened; inspect the current state before repeating any write.`,
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
}

export function roundConversation(
  rounds: { roundNo: number; verdict: string; summary: string | null }[]
) {
  return rounds.map((round) => ({
    role: "assistant" as const,
    content: `Round ${round.roundNo} (${round.verdict === "achieved" ? "claimed achieved" : round.verdict}): ${round.summary || "no summary"}`,
  }))
}
