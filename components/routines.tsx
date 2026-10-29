"use client"
// Adapted from the pinned MIT upstream components/routines/routines-view.tsx (MIT): plan editor,
// five schedule choices, enable/manual-run actions and run-history navigation.
import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { describeSchedule, WEEKDAYS } from "@/lib/schedule"
import type { RoutinePlan, routineOverview } from "@/lib/routines"
import type { RoutineSchedule } from "@/db/schema"
import { ReportComparison } from "@/components/report-comparison"

type Overview = Awaited<ReturnType<typeof routineOverview>>
const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm"
const statusLabels: Record<string, string> = {
  queued: "已排队",
  running: "执行中",
  waiting_user: "等待你处理",
  needs_review: "待复核",
  verifying: "检查成果",
  completed: "已完成",
  ok: "已完成",
  cancelled: "已停止",
  stopped: "已停止",
  failed: "失败",
  skipped: "已跳过",
}

export function Routines({ initial }: { initial: Overview }) {
  const [data, setData] = useState(initial)
  const empty: RoutinePlan = {
    name: "",
    agentId: data.agents[0]?.id ?? "",
    prompt: "",
    schedule: { kind: "daily", time: "09:00" },
    timeZone: data.ownerTimeZone,
    enabled: true,
    missedRunPolicy: "latest",
    dateRange: "none",
    completionContract: { requireHumanReview: false },
    budget: { maxSteps: 40 },
    delegateAgentIds: [],
  }
  const [draft, setDraft] = useState<RoutinePlan>(empty)
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("")
  const set = <K extends keyof RoutinePlan>(key: K, value: RoutinePlan[K]) =>
    setDraft((old) => ({ ...old, [key]: value }))
  async function mutate(body: Record<string, unknown>) {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const response = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setData(result)
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const date = (value: string | null, zone: string) =>
    value
      ? new Date(value).toLocaleString("zh-CN", { timeZone: zone, hour12: false })
      : "无后续计划"
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回工作现场
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">定时例程</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          把重复工作交给
          Agent。每次触发保存独立任务；工作站忙时排队，暂停或删除计划保留已经受理的任务。
        </p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <form
        aria-label="例程计划"
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
        onSubmit={async (event) => {
          event.preventDefault()
          if (
            await mutate(
              editing
                ? { action: "save", ...editing, input: draft }
                : { action: "create", input: draft }
            )
          ) {
            setEditing(null)
            setDraft(empty)
            setMessage("计划已保存。已受理的任务继续使用原计划快照。")
          }
        }}
      >
        <h2 className="font-medium">{editing ? "编辑计划" : "新建计划"}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            名称
            <Input
              required
              maxLength={60}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            执行 Agent
            <select
              aria-label="执行 Agent"
              required
              className={selectClass}
              value={draft.agentId}
              onChange={(e) => set("agentId", e.target.value)}
            >
              <option value="" disabled>
                选择 Agent
              </option>
              {data.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="space-y-2 rounded-lg border p-3 text-sm">
          <legend className="px-1">本计划允许交接的 Agent（默认关闭）</legend>
          <p className="text-xs leading-5 text-muted-foreground">
            每次触发固定这份名单，交接说明、声明文件和相关问答会发送到接手者的模型服务。
            修改名单只影响以后触发；已受理任务继续使用原名单。各段共享同一任务预算。
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {[
              ...data.agents,
              ...draft.delegateAgentIds
                .filter((id) => !data.agents.some((agent) => agent.id === id))
                .map((id) => ({ id, name: `不可用 Agent：${id}（取消勾选后保存）` })),
            ].map((agent) => (
              <label key={agent.id} className="flex items-center gap-2 break-all">
                <input
                  type="checkbox"
                  checked={draft.delegateAgentIds.includes(agent.id)}
                  onChange={(event) =>
                    set(
                      "delegateAgentIds",
                      event.target.checked
                        ? [...draft.delegateAgentIds, agent.id]
                        : draft.delegateAgentIds.filter((id) => id !== agent.id)
                    )
                  }
                />
                {agent.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block space-y-2 text-sm">
          每次要做的工作
          <textarea
            required
            maxLength={4000}
            className="min-h-24 w-full rounded-md border bg-transparent p-3"
            value={draft.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            placeholder="下载上一完整自然周报表，检查日期和字段，汇总变化。"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-2 text-sm">
            计划类型
            <select
              aria-label="计划类型"
              className={selectClass}
              value={draft.schedule.kind}
              onChange={(e) => {
                const kind = e.target.value as RoutineSchedule["kind"]
                set(
                  "schedule",
                  kind === "once"
                    ? { kind, at: "" }
                    : kind === "hourly"
                      ? { kind, every: 6 }
                      : kind === "weekly"
                        ? { kind, day: 1, time: "09:00" }
                        : { kind, time: "09:00" }
                )
              }}
            >
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
              <option value="hourly">每隔几小时</option>
              <option value="once">一次性</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            IANA 时区
            <Input
              required
              value={draft.timeZone}
              onChange={(e) => set("timeZone", e.target.value)}
              placeholder="Asia/Taipei"
            />
          </label>
          {draft.schedule.kind === "once" ? (
            <label className="space-y-2 text-sm">
              当地日期与时间
              <input
                required
                type="datetime-local"
                className={selectClass}
                value={draft.schedule.at}
                onChange={(e) =>
                  set("schedule", { kind: "once", at: e.target.value.slice(0, 16) })
                }
              />
            </label>
          ) : draft.schedule.kind === "hourly" ? (
            <label className="space-y-2 text-sm">
              间隔小时
              <Input
                required
                type="number"
                min={1}
                max={24}
                value={draft.schedule.every}
                onChange={(e) =>
                  set("schedule", { kind: "hourly", every: Number(e.target.value) })
                }
              />
            </label>
          ) : (
            <label className="space-y-2 text-sm">
              当地时间
              <input
                required
                type="time"
                className={selectClass}
                value={draft.schedule.time}
                onChange={(e) =>
                  set("schedule", {
                    ...draft.schedule,
                    time: e.target.value,
                  } as RoutineSchedule)
                }
              />
            </label>
          )}
          {draft.schedule.kind === "weekly" && (
            <label className="space-y-2 text-sm">
              星期
              <select
                aria-label="星期"
                className={selectClass}
                value={draft.schedule.day}
                onChange={(e) =>
                  set("schedule", {
                    ...draft.schedule,
                    day: Number(e.target.value),
                  } as RoutineSchedule)
                }
              >
                {WEEKDAYS.map((name, day) => (
                  <option key={day} value={day}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="space-y-2 text-sm">
            漏跑策略
            <select
              aria-label="漏跑策略"
              className={selectClass}
              value={draft.missedRunPolicy}
              onChange={(e) =>
                set("missedRunPolicy", e.target.value as RoutinePlan["missedRunPolicy"])
              }
            >
              <option value="latest">只补最近一次</option>
              <option value="skip">跳过延迟超过 60 秒的触发</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            日期范围
            <select
              aria-label="日期范围"
              className={selectClass}
              value={draft.dateRange}
              onChange={(e) =>
                set("dateRange", e.target.value as RoutinePlan["dateRange"])
              }
            >
              <option value="none">按任务说明</option>
              <option value="previous_week">上一完整自然周（周一至周日）</option>
            </select>
          </label>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          夏令时缺失的时间顺延；重复时间取后一次。小时计划按固定时长执行。自然周按此计划时区，在触发时固定日期；恢复后沿用。
        </p>
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer">成果检查与单次预算</summary>
          <label className="block space-y-2">
            CSV 路径（留空关闭文件检查）
            <Input
              value={draft.completionContract.artifact?.path ?? ""}
              onChange={(e) =>
                set("completionContract", {
                  ...draft.completionContract,
                  artifact: e.target.value
                    ? {
                        ...(draft.completionContract.artifact ?? {
                          requiredColumns: ["date", "amount"],
                          minRows: 1,
                          dateColumn: "date",
                        }),
                        path: e.target.value,
                      }
                    : undefined,
                })
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            当前编辑器检查 date、amount 字段及 date 日期范围；其他字段可通过例程 API
            配置。
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!draft.completionContract.comparison}
              onChange={(event) => {
                if (event.target.checked) {
                  setDraft((old) => ({
                    ...old,
                    dateRange: "previous_week",
                    completionContract: {
                      ...old.completionContract,
                      artifact: {
                        ...(old.completionContract.artifact ?? {
                          path: "report.csv",
                          requiredColumns: ["date", "amount"],
                          minRows: 1,
                        }),
                        dateColumn: old.completionContract.artifact?.dateColumn ?? "date",
                      },
                      comparison: {
                        baseline: {
                          path: "baseline.csv",
                          requiredColumns: ["date", "amount"],
                          minRows: 1,
                          dateColumn: "date",
                        },
                        valueColumn: "amount",
                        kind: "percent",
                        threshold: "10",
                        direction: "any",
                        notify: "on_change",
                      },
                    },
                  }))
                } else
                  set("completionContract", {
                    ...draft.completionContract,
                    comparison: undefined,
                  })
              }}
            />
            比较前后两周报表
          </label>
          {draft.completionContract.comparison && (
            <div
              aria-label="报表比较规则"
              className="grid gap-3 border-l pl-4 sm:grid-cols-2"
            >
              <label className="space-y-2">
                基期 CSV 路径
                <Input
                  required
                  value={draft.completionContract.comparison.baseline.path}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        baseline: {
                          ...draft.completionContract.comparison!.baseline,
                          path: e.target.value,
                        },
                      },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                求和数值列
                <Input
                  required
                  value={draft.completionContract.comparison.valueColumn}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        valueColumn: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                比较方式
                <select
                  aria-label="比较方式"
                  className={selectClass}
                  value={draft.completionContract.comparison.kind}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        kind: e.target.value as "absolute" | "percent",
                      },
                    })
                  }
                >
                  <option value="percent">百分比变化幅度</option>
                  <option value="absolute">差额绝对值</option>
                </select>
              </label>
              <label className="space-y-2">
                变化阈值
                <Input
                  required
                  inputMode="decimal"
                  value={draft.completionContract.comparison.threshold}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        threshold: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                变化方向
                <select
                  aria-label="变化方向"
                  className={selectClass}
                  value={draft.completionContract.comparison.direction}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        direction: e.target.value as "any" | "increase" | "decrease",
                      },
                    })
                  }
                >
                  <option value="any">任意方向</option>
                  <option value="increase">增加</option>
                  <option value="decrease">减少</option>
                </select>
              </label>
              <label className="space-y-2">
                完成通知
                <select
                  aria-label="完成通知"
                  className={selectClass}
                  value={draft.completionContract.comparison.notify}
                  onChange={(e) =>
                    set("completionContract", {
                      ...draft.completionContract,
                      comparison: {
                        ...draft.completionContract.comparison!,
                        notify: e.target.value as "always" | "on_change",
                      },
                    })
                  }
                >
                  <option value="on_change">仅达到变化条件时</option>
                  <option value="always">每次完成</option>
                </select>
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                本期使用上一完整自然周，基期再前移一周。两份 CSV
                都必须交付；在宿主侧求和比较，含阈值，零差额不触发。基期为零导致百分比无法定义时仍提醒核对。缺文件、无效数值、问题或失败均不会作为“无变化”静默处理。
              </p>
            </div>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.completionContract.requireHumanReview}
              onChange={(e) =>
                set("completionContract", {
                  ...draft.completionContract,
                  requireHumanReview: e.target.checked,
                })
              }
            />
            成果需要我确认
          </label>
          <label className="block space-y-2">
            最多模型决定次数
            <Input
              type="number"
              min={1}
              max={200}
              value={draft.budget.maxSteps}
              onChange={(e) =>
                set("budget", { ...draft.budget, maxSteps: Number(e.target.value) })
              }
            />
          </label>
        </details>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          启用计划
        </label>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || !data.agents.length}>
            {editing ? "保存计划" : "创建计划"}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(null)
                setDraft(empty)
              }}
            >
              取消编辑
            </Button>
          )}
        </div>
        {!data.agents.length && (
          <p className="text-sm">
            先到
            <Link href="/settings" className="underline">
              模型与 Agent 设置
            </Link>
            创建执行 Agent。
          </p>
        )}
      </form>
      <section
        aria-label="已保存计划"
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
      >
        <h2 className="font-medium">已保存计划</h2>
        {!data.routines.length && (
          <p className="text-sm text-muted-foreground">
            还没有例程，创建一条计划开始重复工作。
          </p>
        )}
        {data.routines.map((routine) => (
          <article key={routine.id} className="space-y-3 border-b pb-5">
            <h3 className="font-medium">
              {routine.name}
              <span className="ml-3 text-xs text-muted-foreground">
                v{routine.planVersion} · {routine.enabled ? "已启用" : "已暂停"}
              </span>
            </h3>
            <p className="text-sm">
              {routine.agentName} · {describeSchedule(routine.schedule)} ·{" "}
              {routine.timeZone}
            </p>
            <p className="text-sm text-muted-foreground">
              交接：
              {routine.delegateAgentIds.length
                ? routine.delegateAgentIds
                    .map((id) => data.agents.find((agent) => agent.id === id)?.name ?? id)
                    .join("、")
                : "关闭"}
            </p>
            <p className="text-sm text-muted-foreground">
              下次：{date(routine.nextRunAt, routine.timeZone)}
              {routine.schedule.kind === "once" && !routine.enabled
                ? "；已受理任务见下方历史。"
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing({ id: routine.id, version: routine.planVersion })
                  setDraft({ ...routine, agentId: routine.agentId!, squadId: undefined })
                  setMessage("")
                }}
              >
                编辑 {routine.name}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    await mutate({
                      action: "enabled",
                      id: routine.id,
                      version: routine.planVersion,
                      enabled: !routine.enabled,
                    })
                  )
                    setMessage("已更新启用状态。已受理任务保持不变。")
                }}
              >
                {routine.enabled ? "暂停" : "启用"} {routine.name}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const key = `personal-agent:routine-run:${routine.id}`
                  try {
                    let requestId = sessionStorage.getItem(key)
                    if (!requestId) {
                      requestId = crypto.randomUUID()
                      sessionStorage.setItem(key, requestId)
                    }
                    if (
                      await mutate({
                        action: "run",
                        id: routine.id,
                        version: routine.planVersion,
                        requestId,
                      })
                    ) {
                      setMessage("已受理。工作站忙时等待排队，可在历史中打开任务。")
                      sessionStorage.removeItem(key)
                    }
                  } catch (error) {
                    setError(
                      `请求键存储失败，请先核对运行历史：${error instanceof Error ? error.message : String(error)}`
                    )
                  }
                }}
              >
                立即运行 {routine.name}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    window.confirm(
                      `删除计划“${routine.name}”？已经受理的任务和历史会保留。`
                    )
                  )
                    await mutate({
                      action: "delete",
                      id: routine.id,
                      version: routine.planVersion,
                    })
                }}
              >
                删除 {routine.name}
              </Button>
            </div>
          </article>
        ))}
      </section>
      <section
        aria-label="运行历史"
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-medium">最近 50 次运行</h2>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                const response = await fetch("/api/routines")
                const result = await response.json()
                if (!response.ok) throw new Error(result.error)
                setData(result)
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            刷新状态
          </Button>
        </div>
        {data.runs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            尚未触发。计划运行期间需要 worker 和数据库持续可用，网页服务可独立重启。
          </p>
        )}
        {data.runs.map((run) => (
          <article key={run.id} className="space-y-2 border-b pb-4 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <p>
                {run.name} · v{run.plan_version ?? "旧版"} ·{" "}
                {run.trigger === "manual" ? "手动" : "定时"}
              </p>
              <p>
                {statusLabels[run.task_status ?? run.status] ??
                  run.task_status ??
                  run.status}
              </p>
            </div>
            <p className="text-muted-foreground">
              {date(run.due_at ?? run.started_at, run.time_zone ?? data.ownerTimeZone)} ·{" "}
              {run.time_zone ?? data.ownerTimeZone}
            </p>
            {run.range && (
              <p>
                固定日期：{run.range.from} 至 {run.range.to}
              </p>
            )}
            {run.detail && (
              <p className="break-words text-muted-foreground">{run.detail}</p>
            )}
            {run.comparison && <ReportComparison result={run.comparison} />}
            {run.task_id && (
              <Link
                href={`/?task=${encodeURIComponent(run.task_id)}`}
                className="underline underline-offset-4"
              >
                打开任务
              </Link>
            )}
          </article>
        ))}
      </section>
    </main>
  )
}
