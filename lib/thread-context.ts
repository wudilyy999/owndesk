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
// Older pairs are shortened into this extra allowance before any is left out, so detail goes
// first and whole exchanges last (the order OpenCode uses when it shrinks a transcript)
export const CONVERSATION_SHORT_CHARS = 24000
const SHORT_PAIR_CHARS = 1200

function shorten(text: string, chars: number) {
  if (text.length <= chars) return text
  const head = Math.ceil(chars * 0.7)
  return `${text.slice(0, head)}…[shortened]…${text.slice(text.length - (chars - head))}`
}

// Recent user/reply pairs stay complete; older ones are shortened, and only the oldest are
// omitted. Old desktop observations and tool calls are deliberately absent: a new turn must
// observe its current workstation. The task's own compaction summarizes this history when the
// model window fills.
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
  let short = first
  let shortChars = 0
  const shortened: typeof pairs = []
  while (short > 0) {
    const [question, reply] = pairs[short - 1]
    const pair = [
      { ...question, content: shorten(question.content, SHORT_PAIR_CHARS / 2) },
      { ...reply, content: shorten(reply.content, SHORT_PAIR_CHARS / 2) },
    ]
    const size = pair[0].content.length + pair[1].content.length
    if (shortChars + size > CONVERSATION_SHORT_CHARS) break
    shortened.unshift(pair)
    short--
    shortChars += size
  }
  return {
    conversation: [...shortened.flat(), ...pairs.slice(first).flat()],
    omittedConversationTurns: short,
    shortenedConversationTurns: shortened.length,
  }
}
