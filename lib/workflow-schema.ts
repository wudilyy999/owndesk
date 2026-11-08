import { z } from "zod"

export class WorkflowValidationError extends Error {}

export const workflowBasenameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (value) => !/[\/\\\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value),
    "Use one ordinary directory name without path separators or control characters"
  )
export const workflowParameterSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
  label: z.string().trim().min(1).max(100),
  sourceValue: workflowBasenameSchema,
})
export const workflowCompilationInputSchema = z.strictObject({
  sourceTaskId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  parameters: z.array(workflowParameterSchema).min(1).max(8),
})
export type WorkflowCompilationInput = z.infer<typeof workflowCompilationInputSchema>
export type WorkflowParameter = z.infer<typeof workflowParameterSchema>

// Finite text bindings, never executable expressions or command templates.
export const workflowTextSchema = z
  .array(
    z.union([
      z.strictObject({ literal: z.string().min(1).max(1000) }),
      z.strictObject({ parameter: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/) }),
    ])
  )
  .min(1)
  .max(20)
export type WorkflowText = z.infer<typeof workflowTextSchema>
export const workflowApplicationSchema = z.enum([
  "Thunar",
  "Browser",
  "Writer",
  "Calc",
  "Mousepad",
])
export type WorkflowApplication = z.infer<typeof workflowApplicationSchema>
const windowSchema = z.strictObject({
  application: workflowApplicationSchema,
  title: workflowTextSchema,
})
const step = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
  label: z.string().min(1).max(180),
  evidence: z.array(z.number().int().positive()).max(100),
}
export const workflowStepSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...step, operation: z.literal("observe"), share: z.boolean() }),
  z.strictObject({
    ...step,
    operation: z.literal("open_application"),
    application: workflowApplicationSchema,
  }),
  z.strictObject({
    ...step,
    operation: z.literal("key_press"),
    when: windowSchema,
    key: z.enum([
      "enter",
      "escape",
      "tab",
      "f2",
      "l",
      "a",
      "n",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "space",
      "s",
      "c",
      "v",
      "o",
      "w",
    ]),
    modifiers: z.array(z.enum(["ctrl", "alt", "shift"])).max(3),
  }),
  z.strictObject({
    ...step,
    operation: z.literal("key_type"),
    when: windowSchema,
    text: workflowTextSchema,
  }),
  z.strictObject({ ...step, operation: z.literal("assert"), window: windowSchema }),
  z.strictObject({
    ...step,
    operation: z.literal("human_checkpoint"),
    reason: z.string().min(1).max(1000),
  }),
])
export const workflowCandidateSchema = z.strictObject({
  description: z.string().min(1).max(2000),
  steps: z.array(workflowStepSchema).min(2).max(60),
})
export type WorkflowCandidate = z.infer<typeof workflowCandidateSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowDirectoryContract = {
  root: WorkflowText
  directories: WorkflowText[]
  absent: WorkflowText[]
}
export type WorkflowTraceEntry = {
  evidence: number
  operation: string
  application?: "Thunar" | "other"
  title?: WorkflowText
  text?: WorkflowText
  submittedWithEnter?: boolean
  key?: string
  modifiers?: string[]
}
export type WorkflowCompilation = WorkflowCompilationInput & {
  sourceSegment: number
  sourceActionNumbers: number[]
  sourceContainerName: string
  contract: WorkflowDirectoryContract
  trace: WorkflowTraceEntry[]
}
export type WorkflowEnvironment = {
  workstationImageId: string
  guestProtocol: number
  locale: string
  application: "Thunar" | "Desktop"
}
export type WorkflowPlan = WorkflowCandidate & {
  schemaVersion: 1
  parameters: WorkflowParameter[]
  completion: WorkflowDirectoryContract
  artifact?: { path: WorkflowText; requiredColumns: string[]; minRows: number }
  environment: WorkflowEnvironment
  sourceTaskId: string | null
  sourceSegment: number | null
  sourceActionNumbers: number[]
  repairOrigin?: { versionId: string; taskId: string; step: number }
}

export const workflowRepairSchema = z.strictObject({
  reason: z.string().min(1).max(1000),
  steps: z.array(workflowStepSchema).min(1).max(6),
})
export type WorkflowRepairCandidate = z.infer<typeof workflowRepairSchema>
export type WorkflowRepair = {
  status: "requesting" | "accepted" | "rejected"
  decisionNo: number
  step: number
  cursor: number
  observationActionNo: number
  epoch: number
  bootId: string
  failure: string
  reason?: string
  steps?: WorkflowStep[]
  draftVersionId?: string
}

export const workflowExecutionInputSchema = z.strictObject({
  versionId: z.string().min(1).max(100),
  purpose: z.enum(["verify", "run"]),
  parameters: z.record(z.string(), workflowBasenameSchema),
  maxActions: z.number().int().min(1).max(200).default(120),
  maxDurationSeconds: z.number().int().min(10).max(1800).default(300),
  allowRepair: z.boolean().optional(),
})
export type WorkflowExecutionInput = z.infer<typeof workflowExecutionInputSchema>
export type WorkflowExecution = WorkflowExecutionInput & {
  plan: WorkflowPlan
  validatedEnvironment: WorkflowEnvironment | null
}
export type WorkflowCheckpoint = {
  bootId?: string
  step: number
  phase: "observe" | "act" | "repair" | "blocked"
  frame: {
    observationId: string
    epoch: number
    bootId: string
    window: { title: string; wmClass: string } | null
  } | null
  waitStartedAt: number | null
  blockedReason: string | null
  repair?: WorkflowRepair
}

export function workflowRepairPlan(
  plan: WorkflowPlan,
  repair: { step: number; steps: WorkflowStep[] }
) {
  return {
    ...plan,
    steps: [
      ...plan.steps.slice(0, repair.step),
      ...repair.steps,
      ...plan.steps.slice(repair.step + 1),
    ],
  }
}

export function validateWorkflowRepair(
  raw: unknown,
  plan: WorkflowPlan,
  stepIndex: number,
  values: Record<string, string>
): WorkflowRepairCandidate {
  const repair = workflowRepairSchema.parse(raw)
  const original = plan.steps[stepIndex]
  if (!["key_press", "key_type", "assert"].includes(original.operation))
    throw new WorkflowValidationError("Only a guarded, undispatched step can be repaired")
  // Keep the intended last operation. Prefixes can recover navigation/dialog state;
  // they cannot repeat directory creation/rename or restart the whole workflow.
  const effect = (step: WorkflowStep) => {
    if (step.operation === "key_type")
      return { operation: step.operation, text: step.text }
    if (step.operation === "key_press")
      return {
        operation: step.operation,
        key: step.key,
        modifiers: [...step.modifiers].sort(),
      }
    return { operation: step.operation }
  }
  if (JSON.stringify(effect(repair.steps.at(-1)!)) !== JSON.stringify(effect(original)))
    throw new WorkflowValidationError(
      "The repair must preserve the failed step's intended operation"
    )
  if (plan.artifact) {
    const originalApp =
      "when" in original
        ? original.when.application
        : original.operation === "assert"
          ? original.window.application
          : null
    const final = repair.steps.at(-1)!
    const finalApp =
      "when" in final
        ? final.when.application
        : final.operation === "assert"
          ? final.window.application
          : null
    if (originalApp !== finalApp)
      throw new WorkflowValidationError("Repair must preserve the intended application")
    for (const step of repair.steps.slice(0, -1)) {
      if (step.operation === "observe" || step.operation === "assert") continue
      if (
        step.operation === "key_press" &&
        step.key === "escape" &&
        !step.modifiers.length
      )
        continue
      throw new WorkflowValidationError(
        "Cross-app repair prefixes may observe or dismiss a dialog only"
      )
    }
    validateCrossAppWorkflow({
      ...plan,
      steps: workflowRepairPlan(plan, { step: stepIndex, steps: repair.steps }).steps,
    })
    return repair
  }
  const paths = new Set(["/home/agent", bindWorkflowText(plan.completion.root, values)])
  for (const [index, step] of repair.steps.slice(0, -1).entries()) {
    if (["observe", "assert"].includes(step.operation)) continue
    if (step.operation === "key_type") {
      if (
        !paths.has(bindWorkflowText(step.text, values)) ||
        !bindWorkflowText(step.when.title, values).endsWith(" - Thunar")
      )
        throw new WorkflowValidationError(
          "Repair prefix typing is limited to navigation paths in a Thunar folder window"
        )
      continue
    }
    if (step.operation === "key_press") {
      if (["escape", "l", "a", "n", "f2", "tab"].includes(step.key)) continue
      const previous = repair.steps[index - 1]
      if (
        step.key === "enter" &&
        previous?.operation === "key_type" &&
        JSON.stringify(previous.when) === JSON.stringify(step.when)
      )
        continue
    }
    throw new WorkflowValidationError(
      "Repair prefixes may only observe, dismiss dialogs or navigate; filesystem effects stay in the original final operation"
    )
  }
  const patched = workflowRepairPlan(plan, { step: stepIndex, steps: repair.steps })
  const trace = plan.steps.flatMap((step) =>
    step.evidence.map((evidence) => ({ evidence, operation: step.operation }))
  )
  validateWorkflowCandidate(
    { description: patched.description, steps: patched.steps },
    {
      parameters: plan.parameters.map((parameter) => ({
        ...parameter,
        sourceValue: values[parameter.name],
      })),
      contract: plan.completion,
      trace,
    }
  )
  return repair
}

export function validateWorkflowParameters(
  plan: WorkflowPlan,
  values: Record<string, string>
) {
  const parsed = z.record(z.string(), workflowBasenameSchema).parse(values)
  const expected = plan.parameters.map((parameter) => parameter.name).sort()
  if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expected))
    throw new WorkflowValidationError("Supply exactly the declared workflow parameters")
  return parsed
}

export function parameterizeWorkflowText(
  text: string,
  parameters: WorkflowParameter[]
): WorkflowText {
  const ordered = [...parameters].sort(
    (a, b) => b.sourceValue.length - a.sourceValue.length
  )
  const tokens: WorkflowText = []
  let rest = text
  while (rest) {
    const found = ordered
      .map((parameter) => {
        let at = rest.indexOf(parameter.sourceValue)
        while (at >= 0) {
          const before = at === 0 || ["/", '"'].includes(rest[at - 1])
          const after = rest.slice(at + parameter.sourceValue.length)
          if (
            before &&
            (!after ||
              after.startsWith("/") ||
              after.startsWith('"') ||
              after === " - Thunar")
          )
            break
          at = rest.indexOf(parameter.sourceValue, at + 1)
        }
        return { parameter, at }
      })
      .filter((match) => match.at >= 0)
      .sort((a, b) => a.at - b.at)[0]
    if (!found) {
      tokens.push({ literal: rest })
      break
    }
    if (found.at) tokens.push({ literal: rest.slice(0, found.at) })
    tokens.push({ parameter: found.parameter.name })
    rest = rest.slice(found.at + found.parameter.sourceValue.length)
  }
  return tokens
}

export function bindWorkflowText(text: WorkflowText, values: Record<string, string>) {
  return text
    .map((part) => {
      if ("literal" in part) return part.literal
      if (!Object.hasOwn(values, part.parameter))
        throw new WorkflowValidationError(`Unknown workflow parameter: ${part.parameter}`)
      return values[part.parameter]
    })
    .join("")
}
export function bindWorkflowContract(
  contract: WorkflowDirectoryContract,
  values: Record<string, string>
) {
  return {
    root: bindWorkflowText(contract.root, values),
    directories: contract.directories.map((value) => bindWorkflowText(value, values)),
    absent: contract.absent.map((value) => bindWorkflowText(value, values)),
  }
}

type TraceAction = {
  action_no: number
  kind: string
  input: Record<string, unknown>
  receipt: Record<string, any> | null
}
export function cleanWorkflowTrace(
  actions: TraceAction[],
  parameters: WorkflowParameter[],
  contract: { root: string; directories: string[]; absent: string[] },
  humanActionNumbers: (number | null)[]
) {
  const texts = new Set([
    "/home/agent",
    contract.root,
    contract.root.split("/").at(-1)!,
    ...contract.directories,
    ...contract.absent,
    ...parameters.map((p) => p.sourceValue),
  ])
  const titles = new Set([
    "agent - Thunar",
    "Create New Folder",
    ...[...texts].flatMap((text) => [`${text} - Thunar`, `Rename "${text}"`]),
  ])
  const trace: WorkflowTraceEntry[] = []
  for (const action of actions) {
    if (humanActionNumbers.includes(action.action_no))
      trace.push({ evidence: trace.length + 1, operation: "human_checkpoint" })
    const entry: WorkflowTraceEntry = {
      evidence: trace.length + 1,
      operation: action.kind,
    }
    const window = action.receipt?.output?.window
    if (window) {
      entry.application = /"Thunar"/.test(String(window.wmClass)) ? "Thunar" : "other"
      if (entry.application === "Thunar" && titles.has(window.title))
        entry.title = parameterizeWorkflowText(window.title, parameters)
    }
    if (action.kind === "key_type") {
      const text = String(action.input.text)
      const plain = text.replace(/\n$/, "")
      if (texts.has(plain)) {
        entry.text = parameterizeWorkflowText(plain, parameters)
        entry.submittedWithEnter = text.endsWith("\n")
      } else entry.operation = "human_checkpoint"
    } else if (
      action.kind === "key_press" &&
      [
        "enter",
        "escape",
        "tab",
        "f2",
        "l",
        "a",
        "n",
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "space",
      ].includes(String(action.input.key))
    ) {
      entry.key = String(action.input.key)
      entry.modifiers = (action.input.modifiers as string[]).filter((key) =>
        ["ctrl", "alt", "shift"].includes(key)
      )
    } else if (action.kind.startsWith("pointer_"))
      entry.operation = "pointer_target_omitted"
    else if (!["screen_capture", "screen_share"].includes(action.kind))
      entry.operation = "human_checkpoint"
    trace.push(entry)
  }
  // Unrecorded human inputs remain a checkpoint; never copy the request/approval itself.
  if (humanActionNumbers.includes(null))
    trace.unshift({ evidence: 0, operation: "human_checkpoint" })
  return trace.map((entry, index) => ({ ...entry, evidence: index + 1 }))
}

export function validateWorkflowCandidate(
  raw: unknown,
  compilation: Pick<WorkflowCompilation, "parameters" | "contract" | "trace">
): WorkflowCandidate {
  const candidate = workflowCandidateSchema.parse(raw)
  if (new Set(candidate.steps.map((step) => step.id)).size !== candidate.steps.length)
    throw new WorkflowValidationError("Workflow step ids must be unique")
  const parameters = new Set(compilation.parameters.map((parameter) => parameter.name))
  const used = new Set<string>()
  const samples = Object.fromEntries(
    compilation.parameters.map((p) => [p.name, p.sourceValue])
  )
  const contract = bindWorkflowContract(compilation.contract, samples)
  const typedValues = new Set([
    "/home/agent",
    contract.root,
    contract.root.split("/").at(-1)!,
    ...contract.directories,
    ...contract.absent,
  ])
  const inspectText = (text: WorkflowText) => {
    for (const token of text) {
      if ("parameter" in token) {
        if (!parameters.has(token.parameter))
          throw new WorkflowValidationError(
            `Undeclared workflow parameter: ${token.parameter}`
          )
        used.add(token.parameter)
      } else {
        if (/[\x00-\x1f\x7f]/.test(token.literal))
          throw new WorkflowValidationError(
            "Workflow text cannot contain control characters"
          )
        if (
          parameterizeWorkflowText(token.literal, compilation.parameters).some(
            (part) => "parameter" in part
          )
        )
          throw new WorkflowValidationError(
            "Use parameter bindings instead of frozen source values"
          )
      }
    }
  }
  const covered = new Set<number>()
  for (const step of candidate.steps) {
    const application =
      "when" in step
        ? step.when.application
        : step.operation === "assert"
          ? step.window.application
          : step.operation === "open_application"
            ? step.application
            : "Thunar"
    if (application !== "Thunar")
      throw new WorkflowValidationError("Directory workflow v1 supports Thunar only")
    for (const number of step.evidence) {
      if (!compilation.trace.some((entry) => entry.evidence === number))
        throw new WorkflowValidationError("Unknown source evidence")
      if (step.operation === "human_checkpoint") covered.add(number)
    }
    if ("when" in step) inspectText(step.when.title)
    if (step.operation === "assert") inspectText(step.window.title)
    if (step.operation === "key_type") {
      inspectText(step.text)
      if (!typedValues.has(bindWorkflowText(step.text, samples)))
        throw new WorkflowValidationError(
          "Typed workflow text must come from the owner's directory contract"
        )
    }
    if (step.operation === "key_press") {
      const chord = [...step.modifiers].sort().join("+")
      const valid = ["l", "a"].includes(step.key)
        ? chord === "ctrl"
        : step.key === "n"
          ? chord === "ctrl+shift"
          : chord === ""
      if (!valid)
        throw new WorkflowValidationError("Unsupported Thunar keyboard shortcut")
    }
  }
  if ([...parameters].some((name) => !used.has(name)))
    throw new WorkflowValidationError(
      "Every declared parameter must be used in the workflow"
    )
  if (
    compilation.trace.some(
      (entry) => entry.operation === "human_checkpoint" && !covered.has(entry.evidence)
    )
  )
    throw new WorkflowValidationError(
      "Private or human-only source segments require human checkpoints"
    )
  return candidate
}

export function bindWorkflowArtifact(plan: WorkflowPlan, values: Record<string, string>) {
  if (!plan.artifact) throw new WorkflowValidationError("Artifact contract missing")
  const path = bindWorkflowText(plan.artifact.path, values)
  if (
    !path.startsWith("/home/agent/") ||
    !path.endsWith(".csv") ||
    path.split("/").some((part) => part === ".." || part === ".") ||
    /[\\\x00-\x1f]/.test(path)
  )
    throw new WorkflowValidationError(
      "Artifact must be an ordinary file under /home/agent"
    )
  return { ...plan.artifact, path }
}
export function validateCrossAppWorkflow(plan: WorkflowPlan) {
  if (!plan.artifact)
    throw new WorkflowValidationError(
      "Cross-app workflow requires a CSV artifact contract"
    )
  if (new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length)
    throw new WorkflowValidationError("Step IDs must be unique")
  workflowCandidateSchema.parse({ description: plan.description, steps: plan.steps })
  const names = plan.parameters.map(
    (parameter) => workflowParameterSchema.parse(parameter).name
  )
  if (new Set(names).size !== names.length)
    throw new WorkflowValidationError("Parameter names must be unique")
  const parameters = new Set(names),
    used = new Set<string>()
  const inspect = (text: WorkflowText) => {
    for (const token of text) {
      if ("parameter" in token) {
        if (!parameters.has(token.parameter))
          throw new WorkflowValidationError("Unknown parameter")
        used.add(token.parameter)
      } else if (/[\x00-\x1f\x7f]/.test(token.literal))
        throw new WorkflowValidationError("Use separate key steps for control characters")
    }
  }
  for (const step of plan.steps) {
    if ("when" in step) inspect(step.when.title)
    if (step.operation === "assert") inspect(step.window.title)
    if (step.operation === "key_type") inspect(step.text)
  }
  inspect(plan.artifact.path)
  if ([...parameters].some((name) => !used.has(name)))
    throw new WorkflowValidationError("Every parameter must be used")
  bindWorkflowArtifact(
    plan,
    Object.fromEntries(
      plan.parameters.map((parameter) => [parameter.name, parameter.sourceValue])
    )
  )
  return plan
}
