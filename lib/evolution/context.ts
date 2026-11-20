import { redactSecrets } from "@/lib/redact-secrets"
// One isolated working history per reformer/reviewer invocation. Summary and normal calls
// use the same admission/usage ledger. Only model calls are retried; tools run in the caller.
import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { z } from "zod"
import {
  compactContext,
  contextMessages,
  estimateContextTokens,
  exceedsInputBudget,
  inputBudget,
  forProvider,
  isContextWindowError,
  planContextCompaction,
  validateContextSummary,
  type ContextCheckpoint,
} from "@/lib/agent/context"
import { modelContextWindow } from "@/lib/providers/registry"
import { beginAttempt, finishAttempt } from "./meter"

export function labContext<T extends ToolSet>(input: {
  taskId: string
  segment: number
  spec: string
  model: LanguageModel
  tools: T
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"]
  output: number
  timeout: number
  system?: (remaining: number) => string
}) {
  const schemas = Object.entries(input.tools).map(([name, t]) => ({
    name,
    description: t.description,
    schema: z.toJSONSchema(t.inputSchema as z.ZodType),
  }))
  const window = modelContextWindow(input.spec)
  const output = Math.min(input.output, Math.floor(window / 2))
  const limit = inputBudget(window, output)
  let checkpoint: ContextCheckpoint | undefined
  const project = (history: ModelMessage[], cp = checkpoint) =>
    forProvider(input.spec, compactContext(contextMessages(history, 0, cp)))
  const size = (messages: ModelMessage[]) =>
    estimateContextTokens([input.system?.(999), schemas, messages])
  async function metered<
    R extends {
      totalUsage: {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails: { cacheReadTokens?: number }
      }
    },
  >(call: (remaining: number) => Promise<R>) {
    const receipt = await beginAttempt(input.taskId, input.segment, input.spec)
    let result: R
    try {
      result = await call(receipt.remainingSteps)
    } catch (error) {
      await finishAttempt(receipt.id, receipt.price, null, String(error))
      throw error
    }
    const u = result.totalUsage
    await finishAttempt(
      receipt.id,
      receipt.price,
      u.inputTokens === undefined || u.outputTokens === undefined
        ? null
        : {
            input: u.inputTokens,
            output: u.outputTokens,
            cached: u.inputTokenDetails.cacheReadTokens ?? 0,
          }
    )
    return result
  }
  return async (history: ModelMessage[]) => {
    let messages = project(history)
    const call = () =>
      metered((remaining) =>
        generateText({
          model: input.model,
          providerOptions: input.providerOptions,
          system: input.system?.(remaining),
          messages,
          tools: input.tools,
          maxOutputTokens: output,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(input.timeout),
        })
      )
    let refused = false
    if (!exceedsInputBudget(size(messages), limit)) {
      try {
        return await call()
      } catch (error) {
        if (!isContextWindowError(error)) throw error
        refused = true
      }
    }
    for (;;) {
      const before = size(messages)
      const plan = planContextCompaction(
        history,
        0,
        checkpoint,
        window - 4096,
        refused ? 0 : limit - size([])
      )
      if (
        !plan ||
        size(project(history, { through: plan.through, summary: "" })) >= before
      )
        throw new Error(
          "Current lab inputs exceed the model window; no useful history can be folded"
        )
      const summary = await metered(() =>
        generateText({
          model: input.model,
          providerOptions: input.providerOptions,
          instructions: plan.messages.filter((m) => m.role === "system"),
          messages: plan.messages.filter((m) => m.role !== "system"),
          maxRetries: 0,
          maxOutputTokens: Math.min(4096, output),
          abortSignal: AbortSignal.timeout(input.timeout),
        })
      )
      const next = {
        through: plan.through,
        summary: redactSecrets(
          validateContextSummary(summary.text, summary.toolCalls, summary.finishReason)
        ),
      }
      messages = project(history, next)
      if (size(messages) >= before)
        throw new Error(
          "Lab summary did not reduce the input; keeping the previous cursor"
        )
      checkpoint = next
      if (!exceedsInputBudget(size(messages), limit)) return call()
      if (!plan.more)
        throw new Error("Lab context still exceeds the model window after compaction")
    }
  }
}
