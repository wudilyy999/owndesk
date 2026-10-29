import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  cleanManualTrace,
  loadManual,
  manualCompilationInputSchema,
  manualDraftSchema,
  manualMarkdown,
  type ManualReference,
} from "@/lib/manual-schema"
import { toolsForTask } from "@/lib/agent/tools"
import { buildInstructions } from "@/lib/agent/instructions"
import { contextMessages } from "@/lib/agent/context"

const manual: ManualReference = {
  id: "5f28fe1a-9ca5-4b0e-9aad-de353ad3ee03",
  sourceTaskId: "a917f215-48a1-47be-93ed-abf9b12f5e1d",
  name: "下载报表",
  description: "进入报表页面，按月份下载 CSV",
  body: "# 步骤\n观察当前页面，找到月份输入框并设置 {{month}}。下载后检查 CSV 的日期和列。",
  parameters: [{ name: "month", label: "月份" }],
  sourceVerification: "model_reported",
  humanInvolvement: true,
}

test("manual compiler uses whitelisted source facts and parameter names without historical input values", () => {
  const input = (kind: string, data: Record<string, unknown>, action_no: number) => ({
    action_no,
    kind,
    input: data,
    receipt: {
      output: {
        window: { wmClass: '"Thunar"', title: "private-window" },
        image: "private-image",
        text: "private-page",
      },
    },
  })
  const trace = cleanManualTrace(
    [
      input("key_type", { text: "2026-10", observationId: "old-frame" }, 1),
      input("browser_fill", { text: "private-password", ref: "r7" }, 2),
      input("pointer_click", { x: 91, y: 120, epoch: 7 }, 3),
      input("shell", { command: "private-command" }, 4),
      input(
        "browser_open",
        {
          url: "https://person:private-password@example.test/private-path?token=private-token",
        },
        5
      ),
      input("key_press", { key: "l", modifiers: ["ctrl"] }, 6),
    ],
    [{ name: "month", label: "月份", sourceValue: "2026-10" }]
  )
  assert.equal(trace[0].parameter, "month")
  assert.equal(trace[1].omittedInput, true)
  assert.equal(trace[4].site, "https://example.test")
  assert.equal(trace[5].key, "l")
  assert.doesNotMatch(
    JSON.stringify(trace),
    /private-|2026-10|old-frame|observationId|epoch|"x"|"y"|r7/
  )
})

test("drafting exposes only submit_manual and requires explicit reviewed input", () => {
  assert.deepEqual(Object.keys(toolsForTask({ manualCompilation: {} })), [
    "submit_manual",
  ])
  assert(!("load_manual" in toolsForTask({})))
  assert(
    "load_manual" in toolsForTask({ manuals: [manual], workstationChannel: "desktop" })
  )
  const schema = toolsForTask({ manualCompilation: {} }).submit_manual
    .inputSchema as z.ZodType
  assert(
    schema.safeParse({
      name: manual.name,
      description: manual.description,
      body: manual.body,
    }).success
  )
  assert(
    !manualDraftSchema.safeParse({
      name: "name",
      description: "desc",
      body: "a".repeat(12001),
    }).success
  )
  assert(
    !manualDraftSchema.safeParse({
      name: "name",
      description: "desc",
      body: "steps",
      x: 10,
    }).success
  )
  assert(
    !manualCompilationInputSchema.safeParse({
      sourceTaskId: manual.sourceTaskId,
      name: "name",
      purpose: "purpose",
      reviewed: false,
    }).success
  )
})

test("manual catalog stays concise until loading; loaded body is pinned through context compaction", () => {
  const config = {
    instructions: "standing orders",
    memories: [],
    manuals: [manual],
    manualId: manual.id,
  }
  const initial = buildInstructions(config, "2026-10-27T00:00:00Z")
  assert(initial.includes(manual.description))
  assert(!initial.includes(manual.body))
  const loaded = loadManual(config.manuals, manual.id)
  assert(loaded.ok)
  assert.equal(loaded.output.body, manual.body)
  assert(!loadManual([], manual.id).ok)
  const system = buildInstructions(config, "2026-10-27T00:00:00Z", [loaded.output.id])
  const compressed = contextMessages(
    [
      { role: "system", content: system },
      { role: "user", content: "new goal" },
      { role: "assistant", content: "old step" },
      { role: "user", content: "current step" },
    ],
    1,
    { through: 3, summary: "Old history compressed without manual text" }
  )
  assert.equal(compressed[0].content, system)
  assert(system.includes(JSON.stringify(manual.body)))
  assert.match(system, /never authorization/)
  assert.match(system, /CURRENT completion contract/)
  assert.match(system, /Human involvement/)
})

test("SKILL.md export contains the edited guidance and no local task identities", () => {
  const exported = manualMarkdown(manual)
  assert(exported.startsWith('---\nname: "operation-manual"'))
  assert(exported.includes(manual.body))
  assert(!exported.includes(manual.id) && !exported.includes(manual.sourceTaskId))
})
