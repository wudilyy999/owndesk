import assert from "node:assert/strict"
import { test } from "node:test"
import { conversationContext, CONVERSATION_CONTEXT_CHARS } from "@/lib/thread-context"
import { threadToMarkdown, exportFilename } from "@/lib/export"

test("Conversation snapshots preserve complete recent pairs, record omissions and carry artifact provenance without old tool calls", () => {
  const turns = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    goal: `question-${index}:` + "x".repeat(10000),
    status: "completed",
    error: null,
    result: { summary: `reply-${index}:` + "y".repeat(10000), files: [] },
  }))
  const snapshot = conversationContext(turns)
  assert.equal(snapshot.omittedConversationTurns, 7)
  assert.equal(snapshot.conversation.length, 6)
  assert.match(snapshot.conversation[0].content, /question-7:/)
  assert(
    snapshot.conversation.reduce((total, message) => total + message.content.length, 0) <=
      CONVERSATION_CONTEXT_CHARS
  )
  turns[9].result.summary = "later mutation"
  assert.match(snapshot.conversation.at(-1)!.content, /reply-9:/)
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
  assert.match(outcome.conversation[1].content, /ended cancelled/)
  assert.match(
    outcome.conversation[1].content,
    /inspect the current state before repeating any write/
  )
  assert.match(
    outcome.conversation[3].content,
    /workstation path=\/home\/agent\/report.csv/
  )
  assert.match(outcome.conversation[3].content, /Re-check the current file/)
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
