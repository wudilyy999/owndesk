import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  objectiveBudgetSchema,
  objectiveContractSchema,
  objectiveInputSchema,
  taskInputSchema,
} from "@/db/schema"
import { objectiveCompleteTool, toolsForTask } from "@/lib/agent/tools"
import { limitReason, roundBudget, roundGoal } from "@/lib/objectives"
import { renderMessage } from "@/lib/channels/hub"

const usage = (over: Partial<Parameters<typeof limitReason>[1]> = {}) => ({
  rounds: 0,
  steps: 0,
  costMicros: 0,
  unknownCost: 0,
  ...over,
})

test("objective limits are optional and absent by default", () => {
  const budget = objectiveBudgetSchema.parse({})
  assert.deepEqual(budget, { roundMaxSteps: 40 })
  assert.equal(
    limitReason(budget, usage({ rounds: 10_000, steps: 1e6, costMicros: 1e12 })),
    null
  )
  // Unknown pricing only matters once a cost cap is set
  assert.equal(limitReason(budget, usage({ unknownCost: 3 })), null)
  const parsed = objectiveInputSchema.parse({
    agentId: "a",
    title: "整理",
    objective: "整理 CSV",
  })
  assert.deepEqual(parsed.budget, { roundMaxSteps: 40 })
  assert.deepEqual(parsed.completionContract, { requireHumanReview: false })
})

test("each limit the owner set stops further rounds with a reason", () => {
  const now = new Date("2026-11-14T00:00:00Z")
  assert.match(
    limitReason({ roundMaxSteps: 40, maxRounds: 2 }, usage({ rounds: 2 }), now)!,
    /2 轮/
  )
  assert.equal(
    limitReason({ roundMaxSteps: 40, maxRounds: 2 }, usage({ rounds: 1 }), now),
    null
  )
  assert.match(
    limitReason({ roundMaxSteps: 40, maxSteps: 50 }, usage({ steps: 50 }), now)!,
    /50 步/
  )
  assert.match(
    limitReason(
      { roundMaxSteps: 40, maxCostMicros: 1_000_000 },
      usage({ costMicros: 1_000_000 }),
      now
    )!,
    /\$1\.00/
  )
  assert.match(
    limitReason(
      { roundMaxSteps: 40, maxCostMicros: 1_000_000 },
      usage({ unknownCost: 1 }),
      now
    )!,
    /价格未知/
  )
  assert.match(
    limitReason({ roundMaxSteps: 40, deadlineAt: "2026-11-13T00:00:00Z" }, usage(), now)!,
    /截止/
  )
})

test("a round's allowance never exceeds what the owner's limits leave", () => {
  assert.deepEqual(roundBudget({ roundMaxSteps: 40 }, usage()), { maxSteps: 40 })
  assert.deepEqual(
    roundBudget({ roundMaxSteps: 40, maxSteps: 50 }, usage({ steps: 45 })),
    {
      maxSteps: 5,
    }
  )
  assert.deepEqual(
    roundBudget(
      { roundMaxSteps: 10, maxCostMicros: 3_000_000 },
      usage({ costMicros: 1_000_000 })
    ),
    { maxSteps: 10, maxCostMicros: 2_000_000 }
  )
  // A task's own cost field tops out at $100; a larger objective cap is split across rounds
  assert.equal(
    roundBudget({ roundMaxSteps: 10, maxCostMicros: 500_000_000 }, usage()).maxCostMicros,
    100_000_000
  )
  const task = taskInputSchema.parse({
    agentId: "a",
    goal: "g",
    clientRequestId: "objective:x:1",
    objectiveRound: { objectiveId: "x", roundNo: 1 },
    budget: roundBudget({ roundMaxSteps: 10, maxCostMicros: 500_000_000 }, usage()),
  })
  assert.equal(task.objectiveRound?.roundNo, 1)
})

test("the round brief carries the objective, criteria, check and bounded history", () => {
  const previous = Array.from({ length: 12 }, (_, index) => ({
    roundNo: index + 1,
    verdict: "progress",
    summary: `做了第 ${index + 1} 部分 ${"x".repeat(2000)}`,
  }))
  const goal = roundGoal(
    {
      title: "季度报表",
      objective: "把 2026 年 Q3 的数据整理成 CSV",
      doneCriteria: "每个月一行",
      completionContract: {
        artifact: {
          path: "/home/agent/q3.csv",
          requiredColumns: ["month", "total"],
          minRows: 3,
        },
        requireHumanReview: true,
      },
    },
    13,
    40,
    previous
  )
  assert.match(goal, /round 13/)
  assert.match(goal, /Q3 的数据/)
  assert.match(goal, /每个月一行/)
  assert.match(goal, /\/home\/agent\/q3\.csv with columns month, total and at least 3/)
  assert.match(goal, /owner confirms/)
  assert.match(goal, /Round 12/)
  assert.doesNotMatch(goal, /Round 4 /)
  assert(goal.length < 16000)
  assert(taskInputSchema.safeParse({ agentId: "a", goal, clientRequestId: "k" }).success)
  assert.match(
    roundGoal(
      {
        title: "t",
        objective: "o",
        doneCriteria: "",
        completionContract: { requireHumanReview: false },
      },
      1,
      5,
      []
    ),
    /first round/
  )
})

test("objective rounds end with a complete_task that states the round's verdict", () => {
  const plain = toolsForTask({})
  const round = toolsForTask({ objectiveRound: { objectiveId: "x", roundNo: 1 } })
  assert.notEqual(plain.complete_task, objectiveCompleteTool)
  assert.equal(round.complete_task, objectiveCompleteTool)
  assert.deepEqual(Object.keys(round).sort(), Object.keys(plain).sort())
  const schema = objectiveCompleteTool.inputSchema as z.ZodType
  assert(schema.safeParse({ summary: "s", objective: { status: "progress" } }).success)
  assert(!schema.safeParse({ summary: "s" }).success)
  assert(!schema.safeParse({ summary: "s", objective: { status: "done" } }).success)
})

test("objective contracts refuse report comparisons and channels show the card as text", () => {
  assert(
    !objectiveContractSchema.safeParse({
      artifact: { path: "/home/agent/a.csv" },
      comparison: {},
    }).success
  )
  assert.match(
    renderMessage({ kind: "objective_proposal", content: "季度报表", metadata: {} })!,
    /季度报表.*网页聊天页/
  )
})
