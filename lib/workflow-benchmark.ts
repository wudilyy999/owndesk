import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { CompletionContract, TaskInput } from "@/db/schema"
import {
  bindWorkflowContract,
  validateWorkflowParameters,
  workflowBasenameSchema,
  type WorkflowEnvironment,
  type WorkflowPlan,
} from "@/lib/workflow-schema"

export const benchmarkArmSchema = z.enum(["baseline", "checked", "repair"])
export type BenchmarkArm = z.infer<typeof benchmarkArmSchema>
export const benchmarkCasesSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      parameters: z.record(z.string(), workflowBasenameSchema),
    })
  )
  .length(10)
  .superRefine((cases, ctx) => {
    if (new Set(cases.map((value) => value.id)).size !== cases.length)
      ctx.addIssue({ code: "custom", message: "Benchmark case ids must be unique" })
    const values = cases.map((value) =>
      JSON.stringify(Object.fromEntries(Object.entries(value.parameters).sort()))
    )
    if (new Set(values).size !== cases.length)
      ctx.addIssue({ code: "custom", message: "Freeze ten distinct benchmark inputs" })
  })
export type BenchmarkManifest = {
  format: 1
  id: string
  frozenAt: string
  database: string
  installId: string
  ownerId: string
  agentIds: Record<BenchmarkArm, string>
  model: string
  providerEndpoint?: string | null
  agentConfig: {
    model: string
    instructions: string
    memories: string[]
    timeZone?: string
    name?: string
    role?: string
  }
  versionId: string
  plan: WorkflowPlan
  environment: WorkflowEnvironment
  coordinateMode: "pixels" | "normalized_1000"
  cases: z.infer<typeof benchmarkCasesSchema>
  maxSteps: number
  maxActions: number
  maxDurationSeconds: number
  arms: BenchmarkArm[]
  uncheckedReplay: "unimplemented"
  population: "ten-new-matched-repetitions-after-exploration"
}
export type BenchmarkAttempt = {
  segmentNo: number
  decisionNo: number
  attemptNo: number
  model: string
  status: string
  usage: {
    input: number
    output: number
    cached: number
    reasoning: number
    missing: boolean
  } | null
  costMicros: string | null
  reconciledCostMicros: string | null
  priceSnapshot: unknown
  startedAt: string
  finishedAt: string | null
}
export type BenchmarkTask = {
  taskId: string
  database: string
  ownerId: string
  phase:
    | "exploration"
    | "compilation"
    | "validation"
    | "execution"
    | "repair"
    | "control"
    | "ui"
  status: string
  source: string
  requestKey: string
  createdAt: string
  terminalAt: string | null
  contract: CompletionContract
  grade: string | null
  model: string
  plan: WorkflowPlan | null
  parameters: Record<string, string> | null
  environment: WorkflowEnvironment | null
  workstationChannel: "desktop" | null
  attempts: BenchmarkAttempt[]
  actions: {
    segmentNo: number
    actionNo: number
    kind: string
    status: string
    bootId: string
  }[]
  requests: {
    id: string
    kind: string
    status: string
    createdAt: string
    resolvedAt: string | null
  }[]
}

export function benchmarkTaskInput(
  manifest: BenchmarkManifest,
  arm: BenchmarkArm,
  caseId: string
): TaskInput {
  if (!manifest.arms.includes(arm))
    throw new Error("Arm was not included in the frozen protocol")
  const sample = manifest.cases.find((value) => value.id === caseId)
  if (!sample) throw new Error("Case was not included in the frozen protocol")
  const parameters = validateWorkflowParameters(manifest.plan, sample.parameters)
  const tree = bindWorkflowContract(manifest.plan.completion, parameters)
  if (tree.directories.some((name) => tree.absent.includes(name)))
    throw new Error("Required and absent benchmark directories must differ")
  return {
    agentId: manifest.agentIds[arm],
    clientRequestId: sample.id,
    workstationChannel: "desktop",
    desktopCoordinateMode: manifest.coordinateMode,
    goal: `Using native Thunar GUI tools only, create ${tree.root}. Inside it create ${tree.absent.join(", ")}, then rename it to ${tree.directories.join(", ")}. Show the final desktop and complete the task. All file modifications use desktop input; the host checks the frozen result.`,
    completionContract:
      arm === "baseline"
        ? { directoryTree: tree, requireHumanReview: false }
        : { requireHumanReview: false },
    budget:
      arm === "checked"
        ? { maxSteps: manifest.maxSteps, maxCostMicros: 0 }
        : { maxSteps: manifest.maxSteps },
    ...(arm === "baseline"
      ? {}
      : {
          workflowExecution: {
            versionId: manifest.versionId,
            purpose: "run" as const,
            parameters,
            maxActions: manifest.maxActions,
            maxDurationSeconds: manifest.maxDurationSeconds,
            ...(arm === "repair" ? { allowRepair: true } : {}),
          },
        }),
  }
}

// A cloned database is an alias for saved Tasks/attempts, never another API call.
// Conflicting copies require a canonical source selection instead of silent choice.
export function uniqueBenchmarkTasks(input: BenchmarkTask[]) {
  const tasks = new Map<string, BenchmarkTask>()
  for (const task of input) {
    const existing = tasks.get(task.taskId)
    if (existing) {
      const { database: firstDatabase, phase: firstPhase, ...first } = existing
      const { database: nextDatabase, phase: nextPhase, ...next } = task
      if (!isDeepStrictEqual(first, next))
        throw new Error(
          `Conflicting copies of Task ${task.taskId}; select its authoritative source database`
        )
    } else tasks.set(task.taskId, task)
  }
  return [...tasks.values()]
}

export function benchmarkTotals(input: BenchmarkTask[], asOf: string) {
  const tasks = uniqueBenchmarkTasks(input)
  let knownCost = 0n
  let unknownCostAttempts = 0,
    uncertainAttempts = 0,
    pendingAttempts = 0
  let inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    reasoningTokens = 0,
    missingUsageAttempts = 0
  let modelWallMs = 0,
    unfinishedModelDurations = 0,
    taskWallMs = 0,
    unfinishedTasks = 0
  let waitingWallMs = 0,
    openRequests = 0
  const attempts = new Set<string>()
  for (const task of tasks) {
    if (task.terminalAt)
      taskWallMs += Date.parse(task.terminalAt) - Date.parse(task.createdAt)
    else unfinishedTasks++
    const intervals = task.requests
      .map((request) => {
        if (!request.resolvedAt && !task.terminalAt) openRequests++
        return [
          Date.parse(request.createdAt),
          Date.parse(request.resolvedAt ?? task.terminalAt ?? asOf),
        ]
      })
      .sort((a, b) => a[0] - b[0])
    let end = -Infinity
    for (const [start, until] of intervals) {
      waitingWallMs += Math.max(0, until - Math.max(start, end))
      end = Math.max(end, until)
    }
    for (const attempt of task.attempts) {
      const key = `${task.taskId}:${attempt.segmentNo}:${attempt.decisionNo}:${attempt.attemptNo}`
      if (attempts.has(key)) throw new Error(`Duplicate model attempt ${key}`)
      attempts.add(key)
      const cost = attempt.costMicros ?? attempt.reconciledCostMicros
      if (cost === null) unknownCostAttempts++
      else knownCost += BigInt(cost)
      if (attempt.status === "unknown") uncertainAttempts++
      if (attempt.status === "pending") pendingAttempts++
      if (!attempt.usage || attempt.usage.missing) missingUsageAttempts++
      if (attempt.usage) {
        inputTokens += attempt.usage.input
        outputTokens += attempt.usage.output
        cachedTokens += attempt.usage.cached
        reasoningTokens += attempt.usage.reasoning
      }
      if (attempt.finishedAt)
        modelWallMs += Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
      else unfinishedModelDurations++
    }
  }
  return {
    tasks: tasks.length,
    completed: tasks.filter((task) => task.status === "completed").length,
    checkedCompleted: tasks.filter(
      (task) => task.status === "completed" && task.grade === "program_checked"
    ).length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    unfinishedTasks,
    modelRequests: attempts.size,
    knownCostMicros: knownCost.toString(),
    totalCostMicros: unknownCostAttempts ? null : knownCost.toString(),
    unknownCostAttempts,
    uncertainAttempts,
    pendingAttempts,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    missingUsageAttempts,
    modelWallMs,
    unfinishedModelDurations,
    taskWallMs,
    humanRequests: tasks.reduce((sum, task) => sum + task.requests.length, 0),
    takeovers: tasks.reduce(
      (sum, task) =>
        sum + task.requests.filter((request) => request.kind === "takeover").length,
      0
    ),
    waitingWallMs,
    openRequests,
    activeHumanMs: null,
    activeHumanMeasurement: "not-instrumented; request waiting time is not active labor",
    workstationActions: tasks.reduce((sum, task) => sum + task.actions.length, 0),
    unknownActions: tasks.reduce(
      (sum, task) =>
        sum +
        task.actions.filter(
          (action) => action.status === "unknown" || action.status === "intent"
        ).length,
      0
    ),
  }
}

export function benchmarkReport(
  manifest: BenchmarkManifest,
  setup: BenchmarkTask[],
  samples: BenchmarkTask[],
  asOf: string,
  sharedFirstTaskId: string | null = null
) {
  const uniqueSetup = uniqueBenchmarkTasks(setup)
  const first = sharedFirstTaskId
    ? uniqueSetup.filter((task) => task.taskId === sharedFirstTaskId)
    : []
  if (
    sharedFirstTaskId &&
    (first.length !== 1 ||
      first[0].grade !== "program_checked" ||
      first[0].status !== "completed")
  )
    throw new Error(
      "The shared first delivery must be a checked completed exploration Task"
    )
  const firstIds = new Set(first.map((task) => task.taskId))
  if (samples.some((task) => uniqueSetup.some((prior) => prior.taskId === task.taskId)))
    throw new Error("A setup Task cannot also be a new frozen benchmark sample")
  const overhead = uniqueSetup.filter((task) => !firstIds.has(task.taskId))
  const checkedSamples = uniqueBenchmarkTasks(samples)
  const violations: string[] = []
  if (manifest.providerEndpoint === undefined)
    violations.push(
      "Provider endpoint was not frozen by this earlier manifest; only the deterministic arm may be admitted"
    )
  const groups: Record<BenchmarkArm, BenchmarkTask[]> = {
    baseline: [],
    checked: [],
    repair: [],
  }
  for (const task of checkedSamples) {
    const arm = manifest.arms.find(
      (value) => task.source === `benchmark:${manifest.id}:${value}`
    )
    const sample = manifest.cases.find((value) => value.id === task.requestKey)
    if (!arm || !sample) {
      violations.push(`Unregistered Task ${task.taskId}`)
      continue
    }
    groups[arm].push(task)
    if (groups[arm].filter((row) => row.requestKey === task.requestKey).length > 1)
      violations.push(
        `Multiple Tasks for ${arm}/${task.requestKey}; all attempts remain in the report`
      )
    if (
      task.ownerId !== manifest.ownerId ||
      Date.parse(task.createdAt) < Date.parse(manifest.frozenAt)
    )
      violations.push(
        `Task ${task.taskId} does not belong to this owner/pre-frozen population`
      )
    const expectedTree = bindWorkflowContract(manifest.plan.completion, sample.parameters)
    if (
      !isDeepStrictEqual(task.contract, {
        directoryTree: expectedTree,
        requireHumanReview: false,
      })
    )
      violations.push(`Completion contract mismatch: ${task.taskId}`)
    if (
      arm === "baseline"
        ? task.plan !== null
        : !isDeepStrictEqual(task.plan, manifest.plan) ||
          !isDeepStrictEqual(task.parameters, sample.parameters)
    )
      violations.push(`Frozen method/parameters mismatch: ${task.taskId}`)
    if (!isDeepStrictEqual(task.environment, manifest.environment))
      violations.push(`Environment unverified/mismatched: ${task.taskId}`)
    if (task.actions.some((action) => ["intent", "unknown"].includes(action.status)))
      violations.push(`Unresolved workstation effect: ${task.taskId}`)
    if (
      task.workstationChannel !== "desktop" ||
      task.actions.some(
        (action) =>
          ![
            "desktop_open_application",
            "screen_capture",
            "screen_share",
            "pointer_click",
            "pointer_move",
            "pointer_drag",
            "pointer_scroll",
            "key_press",
            "key_type",
          ].includes(action.kind)
      )
    )
      violations.push(`Desktop channel mismatch: ${task.taskId}`)
    if (
      task.attempts.some((attempt) => attempt.model !== manifest.model) ||
      (arm === "baseline" && task.model !== manifest.model)
    )
      violations.push(`Model mismatch: ${task.taskId}`)
  }
  const arms = Object.fromEntries(
    manifest.arms.map((arm) => {
      const group = groups[arm]
      const totals = benchmarkTotals(group, asOf)
      const durations = group
        .filter(
          (task) =>
            task.status === "completed" &&
            task.grade === "program_checked" &&
            task.terminalAt
        )
        .map((task) => Date.parse(task.terminalAt!) - Date.parse(task.createdAt))
        .sort((a, b) => a - b)
      const median = durations.length
        ? (durations[Math.floor((durations.length - 1) / 2)] +
            durations[Math.floor(durations.length / 2)]) /
          2
        : null
      return [
        arm,
        {
          planned: 10,
          ...totals,
          missingCases: manifest.cases
            .filter((sample) => !group.some((task) => task.requestKey === sample.id))
            .map((sample) => sample.id),
          deliveredDurationMs: {
            count: durations.length,
            median,
            min: durations.at(0) ?? null,
            max: durations.at(-1) ?? null,
          },
          taskIds: group.map((task) => task.taskId),
        },
      ]
    })
  )
  const comparable =
    manifest.arms.every(
      (arm) =>
        groups[arm].length === 10 &&
        groups[arm].every((task) =>
          ["completed", "failed", "cancelled"].includes(task.status)
        )
    ) && violations.length === 0
  const economics = Object.fromEntries(
    manifest.arms
      .filter((arm) => arm !== "baseline")
      .map((arm) => {
        const baseline = benchmarkTotals([...first, ...groups.baseline], asOf)
        const optimized = benchmarkTotals([...first, ...overhead, ...groups[arm]], asOf)
        const allMatchedDeliveriesChecked =
          [...groups.baseline, ...groups[arm]].length === 20 &&
          [...groups.baseline, ...groups[arm]].every(
            (task) => task.status === "completed" && task.grade === "program_checked"
          )
        const moneyComplete =
          comparable &&
          allMatchedDeliveriesChecked &&
          baseline.totalCostMicros !== null &&
          optimized.totalCostMicros !== null
        return [
          arm,
          {
            comparedUserDeliveries: 10 + first.length,
            baseline,
            optimized,
            allMatchedDeliveriesChecked,
            netModelRequestSavings:
              comparable && allMatchedDeliveriesChecked
                ? baseline.modelRequests - optimized.modelRequests
                : null,
            netApiCostSavingsMicros: moneyComplete
              ? (
                  BigInt(baseline.totalCostMicros!) - BigInt(optimized.totalCostMicros!)
                ).toString()
              : null,
            netAllInCostSavingsMicros: null,
            reason:
              "Environment preparation/parameterization and active human work are unmeasured; API-only totals cannot establish all-in savings.",
          },
        ]
      })
  )
  return {
    benchmarkId: manifest.id,
    frozenAt: manifest.frozenAt,
    asOf,
    comparable,
    violations,
    arms,
    economics,
    setup: benchmarkTotals(uniqueSetup, asOf),
    setupByPhase: Object.fromEntries(
      [...new Set(uniqueSetup.map((task) => task.phase))].map((phase) => [
        phase,
        benchmarkTotals(
          uniqueSetup.filter((task) => task.phase === phase),
          asOf
        ),
      ])
    ),
    sharedFirstTaskId,
    accounting:
      "The shared first delivery is charged once to each strategy. Other setup failures/compilation/validation/control trials are charged once to each workflow strategy, never once per cloned database. The ten new samples remain a separate pre-frozen population.",
    missingMeasurements: [
      "active human labor",
      "dedicated environment preparation",
      "parameterization labor",
      "infrastructure cost",
      "unchecked-replay ablation",
    ],
    fullC4Accepted: false,
    scope:
      "Matched Thunar GUI engineering benchmark; comparability and complete costs are reported separately. No OwnDesk superiority or all-in savings claim.",
  }
}
