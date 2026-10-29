import { z } from "zod"
import { directoryTreeSchema } from "@/db/schema"
import {
  bindWorkflowContract,
  validateWorkflowCandidate,
  validateWorkflowParameters,
  workflowBasenameSchema,
  workflowStepSchema,
  workflowTextSchema,
  WorkflowValidationError,
  type WorkflowEnvironment,
  type WorkflowPlan,
  type WorkflowText,
} from "@/lib/workflow-schema"

export const workflowPackageMaxBytes = 128 * 1024
const publicText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\x00-\x1f\x7f]+$/)
const portableStepSchema = z.discriminatedUnion("operation", [
  workflowStepSchema.options[0].omit({ evidence: true }),
  workflowStepSchema.options[1].omit({ evidence: true }),
  workflowStepSchema.options[2].omit({ evidence: true }),
  workflowStepSchema.options[3].omit({ evidence: true }),
  workflowStepSchema.options[4].omit({ evidence: true }),
  workflowStepSchema.options[5].omit({ evidence: true }),
])
export const workflowPackageSchema = z.strictObject({
  format: z.literal("personal-agent.workflow"),
  formatVersion: z.literal(1),
  packageId: z.uuid(),
  name: publicText(100),
  description: publicText(2000),
  environment: z.strictObject({
    workstationImageId: z.string().regex(/^[a-z0-9]+:[a-f0-9]{64}$/),
    guestProtocol: z.literal(6),
    locale: z.string().regex(/^(C|[a-z]{2}_[A-Z]{2})\.UTF-8$/),
    application: z.literal("Thunar"),
  }),
  parameters: z
    .array(
      z.strictObject({
        name: z.string().regex(/^input[1-8]$/),
        label: publicText(100),
      })
    )
    .min(1)
    .max(8),
  completion: z.strictObject({
    root: workflowTextSchema,
    directories: z.array(workflowTextSchema).min(1).max(50),
    absent: z.array(workflowTextSchema).max(50),
  }),
  steps: z.array(portableStepSchema).min(2).max(60),
  testSamples: z.array(z.record(z.string(), workflowBasenameSchema)).length(3),
})
export type WorkflowPackage = z.infer<typeof workflowPackageSchema>
export const workflowImportSchema = z.strictObject({
  clientRequestId: z.uuid(),
  reviewed: z.literal(true),
  package: z.unknown(),
})

function signature(text: WorkflowText) {
  if (text.some((part) => "literal" in part && part.literal.includes("@")))
    throw new WorkflowValidationError(
      "Portable literals cannot impersonate parameter bindings"
    )
  return text
    .map((part) => ("parameter" in part ? `@${part.parameter}` : part.literal))
    .join("")
}

export function workflowPlanFromPackage(pack: WorkflowPackage): WorkflowPlan {
  return {
    schemaVersion: 1,
    description: pack.description,
    parameters: pack.parameters.map((parameter) => ({
      ...parameter,
      sourceValue: pack.testSamples[0][parameter.name],
    })),
    completion: pack.completion,
    environment: pack.environment,
    steps: pack.steps.map((step) => ({ ...step, evidence: [] })),
    sourceTaskId: null,
    sourceSegment: null,
    sourceActionNumbers: [],
  }
}

export function validateWorkflowPackage(raw: unknown): WorkflowPackage {
  const pack = workflowPackageSchema.parse(raw)
  const names = pack.parameters.map((parameter) => parameter.name)
  if (new Set(names).size !== names.length)
    throw new WorkflowValidationError("Package parameter names must be unique")
  // Portable v1 permits only parameterized paths. No production basename,
  // arbitrary window title or hidden free-form typing is exported as a constant.
  const root = signature(pack.completion.root)
  const relative = [...pack.completion.directories, ...pack.completion.absent].map(
    signature
  )
  if (
    !/^\/home\/agent\/@input[1-8](\/@input[1-8])*$/.test(root) ||
    relative.some((value) => !/^@input[1-8](\/@input[1-8])*$/.test(value))
  )
    throw new WorkflowValidationError(
      "Portable directory paths must use parameter bindings for every directory name"
    )
  const basenames = [root, ...relative].map((value) => value.split("/").at(-1)!)
  const titles = new Set([
    "agent - Thunar",
    "Create New Folder",
    ...basenames.flatMap((name) => [`${name} - Thunar`, `Rename "${name}"`]),
  ])
  for (const step of pack.steps) {
    if (
      /[\x00-\x1f\x7f]/.test(step.label) ||
      (step.operation === "human_checkpoint" && /[\x00-\x1f\x7f]/.test(step.reason))
    )
      throw new WorkflowValidationError(
        "Package descriptions cannot contain control characters"
      )
    const window =
      "when" in step ? step.when : step.operation === "assert" ? step.window : null
    if (window && !titles.has(signature(window.title)))
      throw new WorkflowValidationError(
        "Portable windows must be known Thunar dialogs or parameterized directory titles"
      )
  }
  const plan = workflowPlanFromPackage(pack)
  const samples = new Set<string>()
  for (const values of pack.testSamples) {
    validateWorkflowParameters(plan, values)
    const tree = directoryTreeSchema.parse(bindWorkflowContract(pack.completion, values))
    if (tree.directories.some((value) => tree.absent.includes(value)))
      throw new WorkflowValidationError("Required and absent directory names must differ")
    const sample = JSON.stringify(Object.fromEntries(Object.entries(values).sort()))
    if (samples.has(sample))
      throw new WorkflowValidationError("Supply three distinct test samples")
    samples.add(sample)
    validateWorkflowCandidate(
      { description: pack.description, steps: plan.steps },
      {
        parameters: plan.parameters.map((parameter) => ({
          ...parameter,
          sourceValue: values[parameter.name],
        })),
        contract: pack.completion,
        trace: [],
      }
    )
  }
  return pack
}

export function prepareWorkflowPackage(
  plan: WorkflowPlan,
  environment: WorkflowEnvironment,
  packageId: string
): WorkflowPackage {
  const aliases = Object.fromEntries(
    plan.parameters.map((parameter, index) => [parameter.name, `input${index + 1}`])
  )
  const text = (value: WorkflowText): WorkflowText =>
    value.map((part) =>
      "parameter" in part
        ? { parameter: aliases[part.parameter] }
        : { literal: part.literal }
    )
  const steps = plan.steps.map(
    ({ id: _id, label: _label, evidence: _evidence, ...step }, index) => {
      const base = {
        id: `step-${index + 1}`,
        label: `步骤 ${index + 1}：${step.operation}`,
      }
      if (step.operation === "key_type")
        return {
          ...base,
          ...step,
          text: text(step.text),
          when: { ...step.when, title: text(step.when.title) },
        }
      if (step.operation === "key_press")
        return { ...base, ...step, when: { ...step.when, title: text(step.when.title) } }
      if (step.operation === "assert")
        return {
          ...base,
          ...step,
          window: { ...step.window, title: text(step.window.title) },
        }
      if (step.operation === "human_checkpoint")
        return {
          ...base,
          ...step,
          reason:
            "保留的人工检查点：请按本次目录合同处理现场，检查后显式交还给 Agent。原私有说明已移除。",
        }
      return { ...base, ...step }
    }
  )
  return validateWorkflowPackage({
    format: "personal-agent.workflow",
    formatVersion: 1,
    packageId,
    name: "Thunar 目录流程",
    description: "通过 Thunar 桌面操作处理参数化目录，使用固定宿主目录树检查器核对结果。",
    environment: { ...environment },
    parameters: plan.parameters.map((parameter, index) => ({
      name: aliases[parameter.name],
      label: plan.completion.root.some(
        (part) => "parameter" in part && part.parameter === parameter.name
      )
        ? "父目录名"
        : plan.completion.directories.some((value) =>
              value.some(
                (part) => "parameter" in part && part.parameter === parameter.name
              )
            )
          ? "完成后保留的目录名"
          : `目录参数 ${index + 1}（核对完成合同）`,
    })),
    completion: {
      root: text(plan.completion.root),
      directories: plan.completion.directories.map(text),
      absent: plan.completion.absent.map(text),
    },
    steps,
    testSamples: [1, 2, 3].map((sample) =>
      Object.fromEntries(
        plan.parameters.map((_, index) => [
          `input${index + 1}`,
          `Example-${sample}-Folder-${index + 1}`,
        ])
      )
    ),
  })
}
