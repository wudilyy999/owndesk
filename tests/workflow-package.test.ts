import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { parameterizeWorkflowText, type WorkflowPlan } from "@/lib/workflow-schema"
import {
  prepareWorkflowPackage,
  validateWorkflowPackage,
  workflowPlanFromPackage,
} from "@/lib/workflow-package"

const parameters = [
  { name: "privateParent", label: "PRIVATE-CONTACT", sourceValue: "Production-Parent" },
  { name: "privateDraft", label: "PRIVATE-CONTACT", sourceValue: "Production-Draft" },
  { name: "privateReady", label: "PRIVATE-CONTACT", sourceValue: "Production-Ready" },
]
const text = (value: string) => parameterizeWorkflowText(value, parameters)
const environment = {
  workstationImageId: `image:${"f".repeat(64)}`,
  guestProtocol: 6,
  locale: "C.UTF-8",
  application: "Thunar" as const,
}
const plan: WorkflowPlan = {
  schemaVersion: 1,
  parameters,
  description: "PRIVATE-CONTACT and PRIVATE-CREDENTIAL",
  environment,
  sourceTaskId: "PRIVATE-SOURCE-ID",
  sourceSegment: 1,
  sourceActionNumbers: [41, 42],
  repairOrigin: { versionId: "PRIVATE-VERSION-ID", taskId: "PRIVATE-REPAIR-ID", step: 1 },
  completion: {
    root: text("/home/agent/Production-Parent"),
    directories: [text("Production-Ready")],
    absent: [text("Production-Draft")],
  },
  steps: parameters.map((parameter, index) => ({
    id: `private-step-${index}`,
    label: "PRIVATE-CONTACT and PRIVATE-CREDENTIAL",
    operation: "key_type",
    text: [{ parameter: parameter.name }],
    when: { application: "Thunar", title: [{ literal: "Create New Folder" }] },
    evidence: [41, 42],
  })),
}
const portable = () => prepareWorkflowPackage(plan, environment, randomUUID())

test("Export regenerates every free-text/source field and neutral samples; materialization creates honest imported provenance", () => {
  const pack = portable()
  const serialized = JSON.stringify(pack)
  for (const marker of [
    "PRIVATE-",
    "Production-",
    "privateParent",
    "privateDraft",
    "privateReady",
    "private-step",
    "sourceTaskId",
    "sourceValue",
    "evidence",
    "repairOrigin",
    "sourceActionNumbers",
  ])
    assert(!serialized.includes(marker), marker)
  assert.deepEqual(
    pack.parameters.map((parameter) => parameter.name),
    ["input1", "input2", "input3"]
  )
  assert.equal(pack.testSamples.length, 3)
  const imported = workflowPlanFromPackage(pack)
  assert.equal(imported.sourceTaskId, null)
  assert.equal(imported.sourceSegment, null)
  assert.deepEqual(imported.sourceActionNumbers, [])
  assert(imported.steps.every((step) => step.evidence.length === 0))
  assert.equal(plan.sourceTaskId, "PRIVATE-SOURCE-ID")
})

test("Strict external packages reject code, old control references, status, authorizations and malformed nested data", () => {
  for (const field of [
    "status",
    "validatedEnvironment",
    "sourceTaskId",
    "sourceActionNumbers",
    "approval",
    "screenshot",
    "command",
    "epoch",
    "bootId",
    "observationId",
  ])
    assert.throws(
      () => validateWorkflowPackage({ ...portable(), [field]: "forged" }),
      field
    )
  const pack = portable()
  for (const field of ["x", "y", "ref", "pageId", "evidence", "observationId", "script"])
    assert.throws(
      () =>
        validateWorkflowPackage({
          ...pack,
          steps: [{ ...pack.steps[0], [field]: "old" }, ...pack.steps.slice(1)],
        }),
      field
    )
  assert.throws(() =>
    validateWorkflowPackage({
      ...pack,
      steps: [{ operation: "shell", command: "arbitrary" }, ...pack.steps.slice(1)],
    })
  )
  assert.throws(() =>
    validateWorkflowPackage({
      ...pack,
      environment: { ...environment, guestProtocol: 5 },
    })
  )
  assert.throws(() =>
    validateWorkflowPackage({
      ...pack,
      testSamples: [...pack.testSamples, pack.testSamples[0]],
    })
  )
})

test("Portable contracts/windows cannot freeze private names or disguise literals as bindings", () => {
  assert.throws(
    () =>
      prepareWorkflowPackage(
        {
          ...plan,
          completion: {
            ...plan.completion,
            directories: [[{ literal: "PRIVATE-CONTACT" }]],
          },
        },
        environment,
        randomUUID()
      ),
    /parameter bindings/
  )
  const pack = portable()
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        completion: { ...pack.completion, root: [{ literal: "/home/agent/@input1" }] },
      }),
    /impersonate/
  )
  const step = pack.steps[0]
  assert.equal(step.operation, "key_type")
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        steps: [
          {
            ...step,
            when: {
              application: "Thunar",
              title: [{ literal: "PRIVATE-CONTACT - Thunar" }],
            },
          },
          ...pack.steps.slice(1),
        ],
      }),
    /known Thunar/
  )
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        steps: [
          { ...step, text: [{ literal: "PRIVATE-CREDENTIAL" }] },
          ...pack.steps.slice(1),
        ],
      }),
    /owner's directory contract/
  )
})

test("Samples are distinct, exactly bound, host-contract-valid and never imported as successful execution evidence", () => {
  const pack = portable()
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        testSamples: [pack.testSamples[0], pack.testSamples[0], pack.testSamples[2]],
      }),
    /distinct/
  )
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        testSamples: [
          { ...pack.testSamples[0], extra: "foreign" },
          ...pack.testSamples.slice(1),
        ],
      }),
    /exactly/
  )
  assert.throws(() =>
    validateWorkflowPackage({
      ...pack,
      testSamples: [
        { ...pack.testSamples[0], input1: "../escape" },
        ...pack.testSamples.slice(1),
      ],
    })
  )
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        testSamples: [
          { ...pack.testSamples[0], input3: pack.testSamples[0].input2 },
          ...pack.testSamples.slice(1),
        ],
      }),
    /must differ/
  )
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        parameters: [pack.parameters[0], pack.parameters[0], pack.parameters[2]],
      }),
    /unique/
  )
})

test("Human checkpoints survive sanitization without private instructions or historical approval", () => {
  const pack = prepareWorkflowPackage(
    {
      ...plan,
      steps: [
        ...plan.steps,
        {
          id: "private-human",
          label: "PRIVATE-CONTACT",
          evidence: [41],
          operation: "human_checkpoint",
          reason: "PRIVATE-CREDENTIAL",
        },
      ],
    },
    environment,
    randomUUID()
  )
  assert.equal(pack.steps.at(-1)!.operation, "human_checkpoint")
  assert(!JSON.stringify(pack).includes("PRIVATE-"))
})

test("Finite interpreter restrictions still apply to external package shortcuts and step identities", () => {
  const pack = portable()
  const extra = {
    id: "key",
    label: "Unsupported shortcut",
    operation: "key_press",
    when: { application: "Thunar", title: [{ literal: "agent - Thunar" }] },
    key: "l",
    modifiers: ["alt"],
  }
  assert.throws(
    () => validateWorkflowPackage({ ...pack, steps: [...pack.steps, extra] }),
    /Unsupported Thunar/
  )
  assert.throws(
    () =>
      validateWorkflowPackage({
        ...pack,
        steps: [pack.steps[0], pack.steps[0], ...pack.steps.slice(1)],
      }),
    /unique/
  )
})
