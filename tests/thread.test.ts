import assert from "node:assert/strict"
import { test } from "node:test"
import { conversationContext } from "@/lib/thread-context"
import { threadToMarkdown, exportFilename } from "@/lib/export"

test("History before the current task remains verbatim until the shared window overflows", () => {
  const turns = Array.from({ length: 205 }, (_, i) => ({
    id: String(i),
    goal: `question-${i}`,
    status: "completed",
    error: null,
    result: { summary: `reply-${i}:` + "y".repeat(1000) },
  }))
  const messages = conversationContext(turns)
  assert.equal(messages.length, 410)
  assert.equal(messages[1].content, turns[0].result.summary)
  assert.equal(messages.at(-1)?.content, turns[204].result.summary)
  const outcome = conversationContext([
    {
      id: "cancelled",
      goal: "cancelled task",
      status: "cancelled",
      error: null,
      result: null,
    },
    {
      id: "file",
      goal: "deliver report",
      status: "completed",
      error: null,
      result: {
        summary: "done",
        files: [
          {
            id: "artifact",
            name: "report.csv",
            path: "/home/agent/report.csv",
            verification: { grade: "program_checked" },
          },
        ],
      },
    },
  ])
  assert.match(outcome[1].content, /ended cancelled/)
  assert.match(outcome[1].content, /inspect the current state before repeating any write/)
  assert.match(outcome[3].content, /workstation path=\/home\/agent\/report.csv/)
  assert.match(outcome[3].content, /Re-check the current file/)
})

test("Reused thread export keeps user/reply text and tool failures without invented cost", () => {
  const markdown = threadToMarkdown({
    title: "Weekly report",
    owner: "Owner",
    members: [],
    messages: [
      { role: "user", parts: [{ type: "text", text: "Double the amounts" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool-fs_read", state: "output-error", input: { path: "report.csv" } },
          { type: "text", text: "Needs review" },
        ],
      },
    ],
  })
  assert.match(markdown, /exported from OwnDesk/)
  assert.match(markdown, /Double the amounts/)
  assert.match(markdown, /`fs_read` report.csv \(failed\)/)
  assert.match(markdown, /Needs review/)
  assert(!markdown.includes("free"))
  assert.match(exportFilename("../../报告"), /^thread-\d{4}-\d{2}-\d{2}\.md$/)
})
