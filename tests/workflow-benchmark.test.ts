import assert from "node:assert/strict"
import { test } from "node:test"
import {
  benchmarkCasesSchema,
  benchmarkReport,
  benchmarkTaskInput,
  benchmarkTotals,
  uniqueBenchmarkTasks,
  type BenchmarkManifest,
  type BenchmarkTask,
} from "@/lib/workflow-benchmark"
import { toolsForTask } from "@/lib/agent/tools"

const environment = {
  workstationImageId: "image",
  guestProtocol: 6,
  locale: "C.UTF-8",
  application: "Thunar" as const,
}
const plan = {
  schemaVersion: 1 as const,
  description: "test",
  steps: [],
  parameters: [{ name: "parentName", label: "parent", sourceValue: "source" }],
  completion: {
    root: [{ literal: "/home/agent/" }, { parameter: "parentName" }],
    directories: [[{ literal: "Ready" }]],
    absent: [[{ literal: "Draft" }]],
  },
  environment,
  sourceTaskId: "source",
  sourceSegment: 1,
  sourceActionNumbers: [1],
}
const manifest: BenchmarkManifest = {
  format: 1,
  id: "experiment",
  frozenAt: "2026-10-26T00:00:00Z",
  database: "test",
  installId: "install",
  ownerId: "owner",
  agentIds: { baseline: "agent-a", checked: "agent-b", repair: "agent-c" },
  model: "custom/model",
  providerEndpoint: "http://localhost:8917/v1",
  agentConfig: { model: "custom/model", instructions: "", memories: [] },
  versionId: "version",
  plan,
  environment,
  coordinateMode: "pixels",
  cases: Array.from({ length: 10 }, (_, i) => ({
    id: `case-${i}`,
    parameters: { parentName: `parent-${i}` },
  })),
  maxSteps: 80,
  maxActions: 120,
  maxDurationSeconds: 300,
  arms: ["baseline", "checked", "repair"],
  uncheckedReplay: "unimplemented",
  population: "ten-new-matched-repetitions-after-exploration",
}
const task = (taskId: string, costMicros: string | null = "10"): BenchmarkTask => ({
  taskId,
  database: "source",
  ownerId: "owner",
  phase: "exploration",
  status: "completed",
  source: "setup",
  requestKey: "source",
  createdAt: "2026-10-26T00:00:01Z",
  terminalAt: "2026-10-26T00:00:11Z",
  contract: {
    requireHumanReview: false,
    directoryTree: {
      root: "/home/agent/source",
      directories: ["Ready"],
      absent: ["Draft"],
    },
  },
  grade: "program_checked",
  model: "custom/model",
  plan: null,
  parameters: null,
  environment,
  workstationChannel: "desktop",
  actions: [],
  requests: [],
  attempts: [
    {
      segmentNo: 1,
      decisionNo: 1,
      attemptNo: 1,
      model: "custom/model",
      status: "succeeded",
      usage: { input: 10, output: 20, cached: 0, reasoning: 0, missing: false },
      costMicros,
      reconciledCostMicros: null,
      priceSnapshot: null,
      startedAt: "2026-10-26T00:00:01Z",
      finishedAt: "2026-10-26T00:00:02Z",
    },
  ],
})
test("C4 exact money, logical-attempt dedup, unknown usage and overlapping human waits", () => {
  const source = task("source", "9007199254740997")
  source.requests = [
    {
      id: "a",
      kind: "review",
      status: "resolved",
      createdAt: "2026-10-26T00:00:02Z",
      resolvedAt: "2026-10-26T00:00:07Z",
    },
    {
      id: "b",
      kind: "takeover",
      status: "cancelled",
      createdAt: "2026-10-26T00:00:04Z",
      resolvedAt: null,
    },
  ]
  const clone = { ...source, database: "cloned" }
  const total = benchmarkTotals([source, clone], "2026-10-27T00:00:00Z")
  assert.equal(total.tasks, 1)
  assert.equal(total.modelRequests, 1)
  assert.equal(total.knownCostMicros, "9007199254740997")
  assert.equal(total.waitingWallMs, 9000)
  assert.equal(total.openRequests, 0)
  assert.equal(total.activeHumanMs, null)
  assert.throws(
    () => uniqueBenchmarkTasks([source, { ...clone, status: "failed" }]),
    /Conflicting copies/
  )
  const unknown = task("unknown", null)
  unknown.attempts[0].status = "unknown"
  unknown.attempts[0].usage = null
  const unknownTotal = benchmarkTotals([source, unknown], "2026-10-26T00:00:12Z")
  assert.equal(unknownTotal.totalCostMicros, null)
  assert.equal(unknownTotal.knownCostMicros, "9007199254740997")
  assert.equal(unknownTotal.unknownCostAttempts, 1)
  assert.equal(unknownTotal.uncertainAttempts, 1)
  assert.equal(unknownTotal.missingUsageAttempts, 1)
  unknown.attempts[0].reconciledCostMicros = "12"
  assert.equal(
    benchmarkTotals([source, unknown], "2026-10-26T00:00:12Z").totalCostMicros,
    "9007199254741009"
  )
  assert.equal(unknown.attempts[0].costMicros, null)
})
test("C4 freezes ten distinct inputs, separate desktops and the same bound contract/channel", () => {
  assert.throws(() => benchmarkCasesSchema.parse(manifest.cases.slice(0, 9)))
  assert.throws(() =>
    benchmarkCasesSchema.parse(manifest.cases.map(() => manifest.cases[0]))
  )
  const baseline = benchmarkTaskInput(manifest, "baseline", "case-0")
  const workflow = benchmarkTaskInput(manifest, "checked", "case-0")
  assert.notEqual(baseline.agentId, workflow.agentId)
  assert.equal(baseline.workstationChannel, "desktop")
  assert.equal(baseline.completionContract.directoryTree!.root, "/home/agent/parent-0")
  assert.equal(workflow.workflowExecution!.parameters.parentName, "parent-0")
  assert.equal(workflow.budget.maxCostMicros, 0)
  const tools = Object.keys(toolsForTask({ workstationChannel: "desktop" }))
  assert(tools.includes("desktop_open_application") && tools.includes("key_press"))
  for (const name of [
    "shell",
    "fs_write",
    "browser_click",
    "delegate",
    "vault_fill",
    "memory_write",
  ])
    assert(!tools.includes(name))
})
test("C4 keeps all planned denominators/failures and charges the shared first delivery once per strategy", () => {
  const first = task("first", "100")
  const setupFailure = {
    ...task("failed-compile", "50"),
    status: "cancelled",
    grade: null,
    phase: "compilation" as const,
  }
  const samples: BenchmarkTask[] = []
  for (const arm of manifest.arms)
    for (const sample of manifest.cases) {
      const input = benchmarkTaskInput(manifest, arm, sample.id)
      samples.push({
        ...task(`${arm}:${sample.id}`, "10"),
        source: `benchmark:${manifest.id}:${arm}`,
        requestKey: sample.id,
        contract: benchmarkTaskInput(manifest, "baseline", sample.id).completionContract,
        model: arm === "baseline" ? manifest.model : "workflow/deterministic",
        attempts: arm === "baseline" ? task("x").attempts : [],
        plan: arm === "baseline" ? null : manifest.plan,
        parameters: arm === "baseline" ? null : sample.parameters,
      })
    }
  const report = benchmarkReport(
    manifest,
    [first, setupFailure, { ...first, database: "clone" }],
    samples,
    "2026-10-26T00:00:12Z",
    first.taskId
  )
  assert.equal(report.comparable, true)
  const economics = report.economics.checked
  assert.equal(economics.comparedUserDeliveries, 11)
  assert.equal(economics.baseline.totalCostMicros, "200")
  assert.equal(economics.optimized.totalCostMicros, "150")
  assert.equal(economics.netApiCostSavingsMicros, "50")
  assert.equal(economics.netAllInCostSavingsMicros, null)
  assert.equal(report.fullC4Accepted, false)
  const missing = benchmarkReport(
    manifest,
    [first, setupFailure],
    samples.slice(0, 29),
    "2026-10-26T00:00:12Z",
    first.taskId
  )
  assert.equal(missing.comparable, false)
  assert.equal(missing.arms.repair.planned, 10)
  assert.equal(missing.arms.repair.missingCases.length, 1)
  assert.equal(missing.economics.checked.netApiCostSavingsMicros, null)
  const failed = structuredClone(samples)
  failed[10].status = "cancelled"
  failed[10].grade = null
  const retained = benchmarkReport(
    manifest,
    [first, setupFailure],
    failed,
    "2026-10-26T00:00:12Z",
    first.taskId
  )
  assert.equal(retained.arms.checked.tasks, 10)
  assert.equal(retained.arms.checked.completed, 9)
  assert.equal(retained.arms.checked.cancelled, 1)
  assert.equal(retained.economics.checked.netApiCostSavingsMicros, null)
  assert.throws(
    () => benchmarkReport(manifest, [first], [first], "2026-10-26T00:00:12Z"),
    /setup Task/
  )
  const mismatch = structuredClone(samples)
  mismatch[0].environment = null
  assert.equal(
    benchmarkReport(manifest, [first], mismatch, "2026-10-26T00:00:12Z").comparable,
    false
  )
  const unknownEffect = structuredClone(samples)
  unknownEffect[0].actions.push({
    segmentNo: 1,
    actionNo: 1,
    kind: "key_press",
    status: "unknown",
    bootId: "boot",
  })
  assert.equal(
    benchmarkReport(manifest, [first], unknownEffect, "2026-10-26T00:00:12Z").comparable,
    false
  )
})
