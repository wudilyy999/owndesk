// Fake memory-update answers for scripted chat models: the update call is a plain generateText,
// so a MockLanguageModelV3 needs `doGenerate` next to its `doStream`.
import type { MockLanguageModelV3 } from "ai/test"

const usage = {
  inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 15, text: 15, reasoning: 0 },
}

export type Seen = { fact: string; notes: string[]; prompt: string }

// `answer` gets the new fact and the numbered notes the model was shown (alias "1", "2" ...)
export function decides(
  model: MockLanguageModelV3,
  answer: string | Error | ((seen: Seen) => string | Error),
  log: Seen[] = []
) {
  model.doGenerate = async (options) => {
    const prompt = JSON.stringify(options.prompt)
    const user = JSON.stringify(options.prompt.at(-1)?.content ?? "")
    const fact = /她想记的新信息：([^"\\]*)/.exec(user)?.[1] ?? ""
    const notes = [...user.matchAll(/(\d+)\. ([^\\"]*?)\\n/g)].map((m) => m[2])
    const seen = { fact, notes, prompt }
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
  decides(model, (seen) => JSON.stringify({ ops: [{ op: "ADD", text: seen.fact }] }), log)

// The number a note was shown under (newest notes come first)
export const numberOf = (seen: Seen, content: string) => {
  const index = seen.notes.indexOf(content)
  if (index === -1) throw new Error(`note not shown: ${content}`)
  return String(index + 1)
}
