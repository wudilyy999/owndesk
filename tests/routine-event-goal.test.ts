import assert from "node:assert/strict"
import { test } from "node:test"
import { routineEventGoal } from "@/lib/routine-event-goal"
test("valid maximum event plus maximum routine prompt stays within task goal bound", () => {
  const goal =
    "p".repeat(4000) +
    "\n[例程 fixture / 计划 v1]\n预定时刻：2026-11-10T00:00:00Z；时区：Asia/Taipei。"
  const data = { text: "x".repeat(11980) }
  assert.equal(JSON.stringify(data).length, 11991)
  const combined = routineEventGoal(goal, data)
  assert(combined.startsWith(goal))
  assert.equal(combined.length, 16000)
  assert(combined.endsWith("[事件内容已截断]"))
  assert.equal(routineEventGoal(goal, { a: 1 }), goal + '\n触发事件（参考数据）：{"a":1}')
})
