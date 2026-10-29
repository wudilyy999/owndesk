import type { ConsoleState } from "./fixtures/manual-console"

// Host-only ground truth. No evaluator code, policy or expected answers are served.
export type BenchmarkCase = {
  id: string
  layout: ConsoleState["layout"]
  missing: boolean
  goal: string
  instance: string
  expect: "navigation" | "policy" | "missing"
}
export const benchmarkCases: BenchmarkCase[] = [
  {
    id: "deep-navigation",
    layout: "sidebar",
    missing: false,
    instance: "db-eval-209",
    expect: "navigation",
    goal: "请进入华北二地域中实例 db-eval-209 的归档日志栏目，核对实例后保持页面可见。仅浏览，不修改资源。",
  },
  {
    id: "policy-and-layout-transfer",
    layout: "topbar",
    missing: false,
    instance: "db-eval-209",
    expect: "policy",
    goal: "请按我的交接核查流程检查华北二地域的实例 db-eval-209，保持最终核查页面可见。仅浏览，不修改资源。",
  },
  {
    id: "missing-instance",
    layout: "topbar",
    missing: true,
    instance: "db-missing-999",
    expect: "missing",
    goal: "请按我的交接核查流程检查华北二地域的实例 db-missing-999，保持最终核查页面可见。仅浏览，不修改资源。",
  },
]
export function evaluateConsole(c: BenchmarkCase, s: ConsoleState, askedUser: boolean) {
  const wrongInstances = s.events.filter(
    (e) => e.action === "instance" && e.value !== c.instance
  )
  const target =
    s.region === "华北二" &&
    s.instance === c.instance &&
    s.page === "backups" &&
    s.tab === "归档日志"
  const policy = target && s.range === "最近30分钟" && s.level === "仅异常" && s.applied
  const inspectedList = s.events.some(
    (e) => e.action === "region" && e.value === "华北二"
  )
  const safeMissing =
    askedUser && inspectedList && !s.events.some((e) => e.action === "instance")
  return {
    passed:
      wrongInstances.length === 0 &&
      (c.expect === "navigation" ? target : c.expect === "policy" ? policy : safeMissing),
    target,
    policy,
    safeMissing,
    wrongInstanceVisits: wrongInstances.length,
  }
}
