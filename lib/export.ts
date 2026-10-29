import { format } from "date-fns"

// Thread formatting and export filenames adapted from the pinned MIT upstream's lib/export.ts.
export type ExportMessage = {
  role: "user" | "assistant" | "system"
  parts: {
    type: string
    text?: string
    input?: unknown
    state?: string
    output?: unknown
    filename?: string
    mediaType?: string
  }[]
  metadata?: { agentId?: string; model?: string; routine?: { name: string } }
}

// A thread as a Markdown file: what was said, by whom, and the steps agents
// took, in a form that reads well anywhere. Client-safe.

type Author = { id: string; name: string }

// The input field that best says what a tool call did
function stepDetail(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const fields = input as Record<string, unknown>
  for (const key of ["command", "query", "url", "path", "key", "agentId", "summary"]) {
    const value = fields[key]
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split("\n")[0]
      return line.length > 120 ? `${line.slice(0, 117)}…` : line
    }
  }
  return ""
}

export function threadToMarkdown({
  title,
  owner,
  members,
  messages,
}: {
  title: string | null
  owner: string
  members: Author[]
  messages: ExportMessage[]
}) {
  const nameOf = (id?: string) => members.find((m) => m.id === id)?.name
  const lines = [
    `# ${title ?? "New thread"}`,
    "",
    `_${owner} · exported from OwnDesk on ${format(new Date(), "d MMMM yyyy, HH:mm")}_`,
    "",
  ]

  for (const message of messages) {
    if (message.role === "system") continue
    const meta = message.metadata
    let author =
      message.role === "user"
        ? meta?.routine
          ? `Routine · ${meta.routine.name}`
          : "You"
        : (nameOf(meta?.agentId) ?? members[0]?.name ?? "Agent")
    const facts = message.role === "assistant" && meta?.model ? [meta.model] : []

    const heading = (who: string) => {
      lines.push(
        "---",
        "",
        `**${who}**${facts.length ? ` · ${facts.join(" · ")}` : ""}`,
        ""
      )
    }
    heading(author)

    let steps: string[] = []
    const flushSteps = () => {
      if (!steps.length) return
      lines.push(...steps.map((step) => `> ${step}`), "")
      steps = []
    }

    for (const part of message.parts) {
      if (part.type === "text" && part.text?.trim()) {
        flushSteps()
        lines.push(part.text.trim(), "")
      } else if (part.type.startsWith("tool-") && "input" in part) {
        const name = part.type.slice("tool-".length)
        if (name === "delegate" && part.state === "output-available") {
          const output = part.output as { agentId?: string } | undefined
          const next = nameOf(output?.agentId)
          steps.push(`↳ handed to ${next ?? "another agent"}`)
          flushSteps()
          if (next) {
            author = next
            heading(author)
          }
          continue
        }
        const detail = stepDetail(part.input)
        const failed = part.state === "output-error" ? " (failed)" : ""
        steps.push(`\`${name}\`${detail ? ` ${detail.replace(/`/g, "'")}` : ""}${failed}`)
      } else if (part.type === "file" && message.role === "user") {
        flushSteps()
        lines.push(`_Attached: ${part.filename ?? part.mediaType}_`, "")
      }
    }
    flushSteps()
  }

  return `${lines.join("\n").trimEnd()}\n`
}

export function exportFilename(title: string | null) {
  const slug = (title ?? "thread")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
  return `${slug || "thread"}-${format(new Date(), "yyyy-MM-dd")}.md`
}
