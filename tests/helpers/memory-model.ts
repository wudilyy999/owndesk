// Fake answers for the memory manager and the tidy-up: both are plain generateText calls, so a
// MockLanguageModelV3 needs `doGenerate` next to its `doStream`.
import type { MockLanguageModelV3 } from "ai/test"

const usage = {
  inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
}

export type Seen = {
  // "remember" for the call after she wanted to remember something, "organize" for a tidy-up page
  call: "remember" | "organize"
  fact: string
  // Summary lines as shown ("S1. 饮食习惯：……") and note lines ("1. ……"), without the number
  summaries: string[]
  notes: string[]
  prompt: string
}

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content.map((part) => (part as { text?: string }).text ?? "").join("")
    : String(content)

export function parseSeen(options: {
  prompt: { role: string; content: unknown }[]
}): Seen {
  const system = options.prompt.find((m) => m.role === "system")
  const user = textOf(options.prompt.at(-1)?.content)
  const call = /在替“她”整理/.test(textOf(system?.content)) ? "organize" : "remember"
  const lines = (title: RegExp, pattern: RegExp) => {
    const block = new RegExp(`${title.source}[^\\n]*\\n([\\s\\S]*?)(?:\\n\\n|$)`).exec(
      user
    )
    return [...(block?.[1] ?? "").matchAll(pattern)].map((m) => m[1])
  }
  return {
    call,
    fact: /她想记的新信息：(.*)$/m.exec(user)?.[1] ?? "",
    summaries: lines(/已有总结：/, /^S\d+\. (.*)$/gm),
    notes: lines(
      /(?:全部笔记|这一页笔记)[^\n]*：/,
      /^\d+\. (.*?)(?:（已归入 S\d+）)?$/gm
    ),
    prompt: JSON.stringify(options.prompt),
  }
}

// `answer` gets what the model was shown; it returns the JSON text of the answer (or an Error)
export function decides(
  model: MockLanguageModelV3,
  answer: string | Error | ((seen: Seen) => string | Error),
  log: Seen[] = []
) {
  model.doGenerate = async (options) => {
    const seen = parseSeen(options as never)
    log.push(seen)
    const out = typeof answer === "function" ? answer(seen) : answer
    if (out instanceof Error) throw out
    return {
      content: [{ type: "text", text: out }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }
  }
  return model
}

// Always adds the fact as it was worded: what a model does for something new
export const adds = (model: MockLanguageModelV3, log?: Seen[]) =>
  decides(
    model,
    (seen) =>
      seen.call === "organize"
        ? '{"ops":[{"op":"NONE"}]}'
        : JSON.stringify({ ops: [{ op: "ADD", text: seen.fact }] }),
    log
  )

// Always asks the person first: what a model does for something it is not sure about
export const asks = (model: MockLanguageModelV3, log?: Seen[]) =>
  decides(
    model,
    (seen) => JSON.stringify({ ops: [{ op: "ASK", text: seen.fact, reason: "拿不准" }] }),
    log
  )

// The number a note was shown under (newest notes come first)
export const numberOf = (seen: Seen, content: string) => {
  const index = seen.notes.indexOf(content)
  if (index === -1) throw new Error(`note not shown: ${content}`)
  return String(index + 1)
}

// The number a summary was shown under ("S1", ...)
export const summaryNumber = (seen: Seen, topic: string) => {
  const index = seen.summaries.findIndex((line) => line.startsWith(`${topic}：`))
  if (index === -1) throw new Error(`summary not shown: ${topic}`)
  return `S${index + 1}`
}
