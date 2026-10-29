import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCsv, verifyCsv } from "@/lib/artifact-checks"
import { compactContext, forProvider } from "@/lib/agent/context"
import type { ModelMessage } from "ai"

test("CSV parsing preserves quotes, embedded newlines, empty values and CRLF; invalid contracts fail", () => {
  assert.deepEqual(parseCsv('name,note,value\r\nA,"x, y\n""quoted""",\r\n'), [
    ["name", "note", "value"],
    ["A", 'x, y\n"quoted"', ""],
  ])
  assert.throws(() => parseCsv('a,b\n1,"missing'), /Unclosed/)
  assert.throws(() => parseCsv('a\n"value"extra'), /Invalid/)
  const contract = {
    path: "report.csv",
    requiredColumns: ["date", "amount"],
    minRows: 1,
    dateColumn: "date",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-31",
  }
  assert.equal(
    verifyCsv("date,amount\n2026-10-20,10\n", contract).grade,
    "program_checked"
  )
  for (const content of [
    "wrong,amount\n2026-10-20,10\n",
    "date,amount\n2026-11-01,10\n",
    "date,amount\n2026-02-30,10\n",
    "date,amount\n",
    "date,date\n2026-10-20,10\n",
  ])
    assert.throws(() => verifyCsv(content, contract))
})
test("Reused context shaping limits images and lifts them for compatible chat providers", () => {
  const history: ModelMessage[] = Array.from({ length: 4 }, (_, i) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: String(i),
        toolName: "screen_capture",
        output: {
          type: "content",
          value: [
            { type: "text", text: "Screen" },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: { type: "data", data: "eA==" },
            },
          ],
        },
      },
    ],
  }))
  const compacted = compactContext(history)
  assert.equal(JSON.stringify(compacted).split('"type":"file"').length - 1, 1)
  const shaped = forProvider("custom/fixture", compacted)
  assert(
    shaped.some(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file")
    )
  )
  assert(
    !shaped.some(
      (message) =>
        message.role === "tool" && JSON.stringify(message).includes('"type":"file"')
    )
  )
})
