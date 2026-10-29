import test from "node:test"
import assert from "node:assert/strict"
import { act, newConsole } from "./fixtures/manual-console"
import { benchmarkCases, evaluateConsole } from "./manuals-benchmark-cases"

test("manual benchmark oracle rejects default filters, wrong instances and uninspected missing targets", () => {
  const s = newConsole("topbar")
  act(s, "catalog")
  act(s, "database")
  act(s, "region", "华北二")
  const missing = benchmarkCases[2]
  assert.equal(evaluateConsole(missing, s, false).passed, false)
  assert.equal(evaluateConsole(missing, s, true).passed, true)
  assert.equal(evaluateConsole(missing, newConsole("topbar", true), true).passed, false)
  act(s, "instance", "db-eval-209")
  act(s, "backups")
  act(s, "tab", "归档日志")
  assert.equal(evaluateConsole(benchmarkCases[0], s, false).passed, true)
  assert.equal(evaluateConsole(benchmarkCases[1], s, false).passed, false)
  act(s, "range", "最近30分钟")
  act(s, "level", "仅异常")
  assert.equal(evaluateConsole(benchmarkCases[1], s, false).passed, false)
  act(s, "apply")
  assert.equal(evaluateConsole(benchmarkCases[1], s, false).passed, true)
  act(s, "instance", "db-eval-2090")
  act(s, "instance", "db-eval-209")
  act(s, "backups")
  act(s, "tab", "归档日志")
  act(s, "apply")
  assert.equal(evaluateConsole(benchmarkCases[0], s, false).passed, false)
  assert.equal(evaluateConsole(missing, s, true).passed, false)
})
