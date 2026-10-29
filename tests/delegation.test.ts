import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { delegationTools, completionTools } from "@/lib/agent/tools"
import { taskInputSchema } from "@/db/schema"
import { buildInstructions } from "@/lib/agent/instructions"

test("delegation retains agentId/brief, bounds the transfer and shares deliverable defaults", () => {
  const schema = delegationTools.delegate.inputSchema as z.ZodObject
  assert.deepEqual(schema.parse({ agentId: "recipient", brief: " Continue " }), {
    agentId: "recipient",
    brief: "Continue",
    files: [],
  })
  assert.equal(schema.safeParse({ agentId: "recipient", brief: " " }).success, false)
  assert.equal(
    schema.safeParse({
      agentId: "recipient",
      brief: "Continue",
      files: Array.from({ length: 9 }, () => ({ path: "file.txt" })),
    }).success,
    false
  )
  const file = { path: "report.csv", mediaType: "text/csv" }
  const delegated = schema.parse({
    agentId: "recipient",
    brief: "Continue",
    files: [file],
  })
  const completed = (completionTools.complete_task.inputSchema as z.ZodObject).parse({
    summary: "Done",
    files: [file],
  })
  assert.deepEqual(delegated.files, completed.files)
})

test("handoff instructions preserve one task budget and invalidate earlier authorization", () => {
  const text = buildInstructions(
    { instructions: "", memories: [], timeZone: "UTC" },
    "2026-10-25T00:00:00Z"
  )
  assert.match(text, /one shared task budget/)
  assert.match(
    text,
    /Browser sessions, references and old approvals stay on their original workstation/
  )
  assert.match(text, /not a parallel child or a return-to-parent call/)
})

test("handoff permission is an optional owner task input with an empty-by-absence default", () => {
  const base = { agentId: "source", goal: "Do the task", clientRequestId: "key" }
  assert.equal(taskInputSchema.parse(base).delegateAgentIds, undefined)
  assert.deepEqual(
    taskInputSchema.parse({ ...base, delegateAgentIds: ["recipient"] }).delegateAgentIds,
    ["recipient"]
  )
  assert.equal(
    taskInputSchema.safeParse({
      ...base,
      delegateAgentIds: Array.from({ length: 33 }, () => "recipient"),
    }).success,
    false
  )
})
