import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { crossAppTemplate } from "@/lib/cross-app-template"
import {
  prepareWorkflowPackage,
  validateWorkflowPackage,
  workflowPlanFromPackage,
} from "@/lib/workflow-package"
import { bindWorkflowArtifact, validateWorkflowRepair } from "@/lib/workflow-schema"
import { workflowWindowMatches } from "@/worker/workflow-execution"
const environment = {
  workstationImageId: `image:${"a".repeat(64)}`,
  guestProtocol: 6,
  locale: "zh_CN.UTF-8",
  application: "Desktop" as const,
}
const pack = () => crossAppTemplate(environment, randomUUID())
test("Cross-app package preserves reviewed operations, strips provenance and uses fresh parameters", () => {
  const value = pack(),
    plan = workflowPlanFromPackage(value)
  plan.description = "PRIVATE-description"
  plan.parameters[0].label = "PRIVATE-label"
  plan.parameters[0].sourceValue = "PRIVATE-file"
  plan.sourceTaskId = "PRIVATE-task"
  const exported = prepareWorkflowPackage(plan, environment, randomUUID())
  assert(!JSON.stringify(exported).includes("PRIVATE"))
  assert.equal(exported.formatVersion, 2)
  assert.deepEqual(
    bindWorkflowArtifact(workflowPlanFromPackage(exported), { input1: "新报表" }),
    { path: "/home/agent/新报表.csv", requiredColumns: ["name", "total"], minRows: 1 }
  )
  assert(value.steps.some((step) => step.operation === "key_press" && step.key === "c"))
  assert(value.steps.some((step) => step.operation === "key_press" && step.key === "v"))
  assert.equal(
    crossAppTemplate(environment, randomUUID(), "Writer").steps[0].operation,
    "open_application"
  )
})
test("Cross-app boundary rejects malformed parameters, bindings, controls and path escapes", () => {
  const value = pack()
  for (const patch of [
    { parameters: [...value.parameters, value.parameters[0]] },
    { testSamples: [value.testSamples[0], value.testSamples[0], value.testSamples[1]] },
    { testSamples: [{ input1: "../escape" }, ...value.testSamples.slice(1)] },
    {
      artifact: {
        path: [{ literal: "/tmp/file.csv" }],
        requiredColumns: ["a"],
        minRows: 1,
      },
    },
    {
      steps: [
        ...value.steps,
        {
          id: "bad",
          label: "bad",
          operation: "key_type",
          when: { application: "Mousepad", title: [{ literal: "Title" }] },
          text: [{ literal: "control\n" }],
        },
      ],
    },
    {
      steps: [
        ...value.steps,
        { id: "bad", label: "bad", operation: "shell", command: "whoami" },
      ],
    },
  ])
    assert.throws(() => validateWorkflowPackage({ ...value, ...patch }))
})
test("Cross-app guards bind application and title; repairs retain the effect and application", () => {
  const value = pack(),
    plan = workflowPlanFromPackage(value),
    index = plan.steps.findIndex((step) => step.operation === "key_type")
  const original = plan.steps[index]
  const frame = {
    observationId: "now",
    epoch: 2,
    bootId: "boot",
    window: { title: "same", wmClass: '"mousepad", "Mousepad"' },
  }
  assert(workflowWindowMatches(frame, "same", "Mousepad"))
  assert(!workflowWindowMatches(frame, "same", "Browser"))
  assert(!workflowWindowMatches(frame, "old", "Mousepad"))
  assert(
    validateWorkflowRepair({ reason: "current title", steps: [original] }, plan, index, {
      input1: "Report",
    })
  )
  assert.throws(
    () =>
      validateWorkflowRepair(
        {
          reason: "wrong app",
          steps: [
            {
              ...original,
              when: { application: "Mousepad", title: [{ literal: "same" }] },
            },
          ],
        },
        plan,
        index,
        { input1: "Report" }
      ),
    /application/
  )
  assert.throws(
    () =>
      validateWorkflowRepair(
        {
          reason: "replay",
          steps: [
            {
              id: "open",
              label: "open",
              evidence: [],
              operation: "open_application",
              application: "Browser",
            },
            original,
          ],
        },
        plan,
        index,
        { input1: "Report" }
      ),
    /prefixes/
  )
})
