import { redactSecrets } from "@/lib/redact-secrets"
import type { ModelMessage } from "ai"
import { tool } from "ai"
import { z } from "zod"

const pageSchema = z.object({
  id: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(4000).default(2000),
})

export const readResultTool = tool({
  description:
    "Read another slice of a captured text tool receipt from this execution segment. Use its tool call ID and character offset. This never executes the tool again. Only file reads, listings, searches, shell and checks are available.",
  inputSchema: pageSchema,
})
export function readResult(history: ModelMessage[], args: Record<string, unknown>) {
  const { id, offset, limit } = pageSchema.parse(args)
  for (const message of history) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (
        part.type !== "tool-result" ||
        part.toolCallId !== id ||
        ![
          "fs_read",
          "fs_list",
          "shell",
          "read_file",
          "list_files",
          "search",
          "run_check",
        ].includes(part.toolName)
      )
        continue
      const output = part.output
      if (
        output.type !== "text" &&
        output.type !== "json" &&
        output.type !== "error-text" &&
        output.type !== "error-json"
      )
        continue
      const body = redactSecrets(
        typeof output.value === "string" ? output.value : JSON.stringify(output.value)
      )
      return {
        id,
        offset,
        totalChars: body.length,
        text: body.slice(offset, offset + limit),
        next: offset + limit < body.length ? offset + limit : null,
      }
    }
  }
  return { error: "No readable text receipt with this ID in this execution segment." }
}
