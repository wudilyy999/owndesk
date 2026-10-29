import assert from "node:assert/strict"
import { test } from "node:test"
import { taskInputSchema } from "@/db/schema"
import { buildInstructions } from "@/lib/agent/instructions"
import { toolsForTask } from "@/lib/agent/tools"
import {
  bindWorkflowContract,
  cleanWorkflowTrace,
  parameterizeWorkflowText,
  validateWorkflowCandidate,
  workflowBasenameSchema,
  type WorkflowCompilation,
  type WorkflowCandidate,
  validateWorkflowParameters,
  type WorkflowPlan,
  validateWorkflowRepair,
  workflowRepairPlan,
} from "@/lib/workflow-schema"
import { workflowWindowMatches } from "@/worker/workflow-execution"

test("Local repair preserves the final effect, original contract and finite navigation scope", () => {
  const plan: WorkflowPlan = {
    ...candidate,
    schemaVersion: 1,
    parameters,
    completion: compilation.contract,
    environment: {
      workstationImageId: "image",
      guestProtocol: 6,
      locale: "en_US.UTF-8",
      application: "Thunar",
    },
    sourceTaskId: "source",
    sourceSegment: 1,
    sourceActionNumbers: [1],
  }
  const values = {
    parentName: "Different-parent",
    draftName: "Different-draft",
    readyName: "Different-ready",
  }
  const raw = {
    reason: "Recover current dialog",
    steps: [
      {
        id: "recover-observe",
        label: "观察",
        evidence: [],
        operation: "observe" as const,
        share: false,
      },
      { ...candidate.steps[0], id: "repaired-parent" },
    ],
  }
  const repair = validateWorkflowRepair(raw, plan, 0, values)
  const patched = workflowRepairPlan(plan, { step: 0, steps: repair.steps })
  assert.deepEqual(patched.completion, plan.completion)
  assert.deepEqual(patched.steps.slice(2), plan.steps.slice(1))
  assert.deepEqual(plan.steps, candidate.steps)
  assert.throws(() => validateWorkflowRepair({ ...raw, completion: {} }, plan, 0, values))
  assert.throws(
    () =>
      validateWorkflowRepair(
        {
          ...raw,
          steps: [{ ...candidate.steps[0], text: [{ parameter: "readyName" }] }],
        },
        plan,
        0,
        values
      ),
    /preserve/
  )
  assert.throws(
    () =>
      validateWorkflowRepair(
        {
          ...raw,
          steps: [{ ...candidate.steps[1], id: "repeat-creation" }, candidate.steps[0]],
        },
        plan,
        0,
        values
      ),
    /navigation paths/
  )
  assert.throws(
    () =>
      validateWorkflowRepair(
        {
          ...raw,
          steps: [
            {
              id: "restart",
              label: "重开",
              evidence: [],
              operation: "open_application",
              application: "Thunar",
            },
            candidate.steps[0],
          ],
        },
        plan,
        0,
        values
      ),
    /prefixes/
  )
  assert.throws(() =>
    validateWorkflowRepair(
      { ...raw, steps: [{ operation: "shell", command: "arbitrary" }] },
      plan,
      0,
      values
    )
  )
  assert.throws(() =>
    validateWorkflowRepair(
      { ...raw, steps: [...raw.steps, ...raw.steps, ...raw.steps, ...raw.steps] },
      plan,
      0,
      values
    )
  )
  assert.deepEqual(
    Object.keys(toolsForTask({ workflowExecution: { allowRepair: true } })),
    ["submit_workflow_repair"]
  )
})

const parameters = [
  { name: "parentName", label: "父目录", sourceValue: "Source-parent" },
  { name: "draftName", label: "初始名称", sourceValue: "Draft" },
  { name: "readyName", label: "最终名称", sourceValue: "Ready" },
]
const bind = (value: string) => parameterizeWorkflowText(value, parameters)
const compilation: WorkflowCompilation = {
  sourceTaskId: "source",
  name: "创建并重命名",
  parameters,
  sourceSegment: 1,
  sourceActionNumbers: [1, 2, 3],
  sourceContainerName: "private-source-container",
  contract: {
    root: bind("/home/agent/Source-parent"),
    directories: [bind("Ready")],
    absent: [bind("Draft")],
  },
  trace: [{ evidence: 1, operation: "key_type", text: bind("Source-parent") }],
}
const window = {
  application: "Thunar" as const,
  title: [{ literal: "Create New Folder" }],
}
const candidate: WorkflowCandidate = {
  description: "GUI 创建并重命名目录",
  steps: parameters.map((parameter, index) => ({
    id: `type-${index}`,
    label: parameter.label,
    evidence: [1],
    operation: "key_type",
    when: window,
    text: [{ parameter: parameter.name }],
  })),
}
test("Workflow bindings preserve explicit parameters and reject undeclared or unsafe input", () => {
  assert.deepEqual(
    parameterizeWorkflowText("Create New Folder", [
      { name: "short", label: "短目录", sourceValue: "a" },
    ]),
    [{ literal: "Create New Folder" }]
  )
  assert.deepEqual(
    parameterizeWorkflowText('Rename "a"', [
      { name: "short", label: "短目录", sourceValue: "a" },
    ]),
    [{ literal: 'Rename "' }, { parameter: "short" }, { literal: '"' }]
  )
  assert.deepEqual(
    bindWorkflowContract(compilation.contract, {
      parentName: "新目录 space",
      draftName: "准备",
      readyName: "完成",
    }),
    {
      root: "/home/agent/新目录 space",
      directories: ["完成"],
      absent: ["准备"],
    }
  )
  for (const value of ["../a", ".", "..", "a/b", "a\\b", "a\n", "a\0"])
    assert.equal(workflowBasenameSchema.safeParse(value).success, false)
  assert.throws(
    () => bindWorkflowContract(compilation.contract, { parentName: "a" }),
    /Unknown workflow parameter/
  )
  assert.deepEqual(validateWorkflowCandidate(candidate, compilation), candidate)
  assert.throws(() =>
    validateWorkflowCandidate({ ...candidate, completion: {} }, compilation)
  )
  assert.throws(() =>
    validateWorkflowCandidate(
      {
        ...candidate,
        steps: candidate.steps.map((step) => ({ ...step, observationId: "stale" })),
      },
      compilation
    )
  )
  assert.throws(
    () =>
      validateWorkflowCandidate(
        {
          ...candidate,
          steps: [
            candidate.steps[0],
            { ...candidate.steps[1], text: [{ literal: "Draft" }] },
          ],
        },
        compilation
      ),
    /parameter bindings/
  )
  assert.throws(
    () =>
      validateWorkflowCandidate(
        {
          ...candidate,
          steps: [
            ...candidate.steps,
            {
              ...candidate.steps[0],
              id: "arbitrary",
              text: [{ literal: "https://example.test" }],
            },
          ],
        },
        compilation
      ),
    /owner's directory contract/
  )
})
test("Compilation trace omits secrets, images, coordinates, identifiers and human authorization", () => {
  const trace = cleanWorkflowTrace(
    [
      {
        action_no: 1,
        kind: "key_type",
        input: { text: "private-password", observationId: "old-observation" },
        receipt: {
          output: {
            image: "secret-image",
            epoch: 999,
            bootId: "secret-boot",
            window: { title: "private title", wmClass: '"Thunar"', x: 200, y: 300 },
          },
        },
      },
      { action_no: 2, kind: "pointer_click", input: { x: 800, y: 600 }, receipt: null },
      { action_no: 3, kind: "key_type", input: { text: "Ready\n" }, receipt: null },
    ],
    parameters,
    { root: "/home/agent/Source-parent", directories: ["Ready"], absent: ["Draft"] },
    [null, 2]
  )
  const serialized = JSON.stringify(trace)
  for (const value of [
    "private-password",
    "old-observation",
    "secret-image",
    "secret-boot",
    "private title",
    '"x":',
    '"epoch":',
  ])
    assert(!serialized.includes(value))
  assert(trace.some((entry) => entry.submittedWithEnter))
  assert.throws(
    () => validateWorkflowCandidate(candidate, { ...compilation, trace }),
    /human checkpoints/
  )
  const checked = {
    ...candidate,
    steps: [
      ...candidate.steps,
      {
        id: "manual",
        label: "人工",
        evidence: trace
          .filter((entry) => entry.operation === "human_checkpoint")
          .map((entry) => entry.evidence),
        operation: "human_checkpoint" as const,
        reason: "人工完成私有片段",
      },
    ],
  }
  assert.equal(
    validateWorkflowCandidate(checked, { ...compilation, trace }).steps.at(-1)?.operation,
    "human_checkpoint"
  )
})
test("Compiler gets one bounded tool and sanitized instructions on every request", () => {
  assert.deepEqual(Object.keys(toolsForTask({ workflowCompilation: compilation })), [
    "submit_workflow",
  ])
  const instructions = buildInstructions(
    {
      instructions: "private standing order",
      memories: ["private memory"],
      workflowCompilation: compilation,
    },
    "2026-10-26T00:00:00Z"
  )
  assert(instructions.includes("Frozen compilation input"))
  assert(instructions.includes("operation=human_checkpoint always requires"))
  assert(instructions.includes("pointer_target_omitted only removes mouse targeting"))
  assert(instructions.includes("/home/agent (no trailing slash)"))
  assert.deepEqual(
    validateWorkflowCandidate(candidate, {
      ...compilation,
      trace: [{ evidence: 1, operation: "pointer_target_omitted", application: "other" }],
    }),
    candidate
  )
  for (const value of [
    "private-source-container",
    "private standing order",
    "private memory",
  ])
    assert(!instructions.includes(value))
  assert(
    taskInputSchema.parse({
      agentId: "a",
      goal: "compile",
      clientRequestId: "test",
      workflowCompilation: { sourceTaskId: "source", name: "流程", parameters },
    }).workflowCompilation
  )
})

test("Workflow execution binds exactly its declared directory inputs and matches a fresh native window", () => {
  const plan = { parameters } as WorkflowPlan
  assert.deepEqual(
    validateWorkflowParameters(plan, {
      parentName: "新目录",
      draftName: "暂存",
      readyName: "完成",
    }),
    { parentName: "新目录", draftName: "暂存", readyName: "完成" }
  )
  assert.throws(
    () => validateWorkflowParameters(plan, { parentName: "a", draftName: "b" }),
    /exactly/
  )
  assert.throws(
    () =>
      validateWorkflowParameters(plan, {
        parentName: "a",
        draftName: "b",
        readyName: "c",
        undeclared: "d",
      }),
    /exactly/
  )
  assert.throws(() =>
    validateWorkflowParameters(plan, {
      parentName: "../outside",
      draftName: "b",
      readyName: "c",
    })
  )
  const frame = {
    observationId: "frame",
    epoch: 1,
    bootId: "boot",
    window: { title: "Create New Folder", wmClass: 'WM_CLASS = "thunar", "Thunar"' },
  }
  assert(workflowWindowMatches(frame, "Create New Folder"))
  assert(!workflowWindowMatches(frame, 'Rename "Draft"'))
  assert(
    !workflowWindowMatches(
      { ...frame, window: { ...frame.window, wmClass: "Chromium" } },
      "Create New Folder"
    )
  )
  assert(!workflowWindowMatches(null, "Create New Folder"))
})
