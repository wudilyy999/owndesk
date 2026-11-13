"use client"
// Long-running objectives: create one, watch its rounds, pause, resume, stop, change limits.
import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ObjectiveOverview } from "@/lib/objectives"

type Agent = { id: string; name: string }
type Item = ObjectiveOverview[number]
type Data = { objectives: Item[]; agents: Agent[] }

const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm"
const area = "min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
export const objectiveStatusLabels: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  achieved: "已达成",
  budget_limited: "到上限停下",
  stopped: "已停止",
}
const verdictLabels: Record<string, string> = {
  progress: "有进展",
  achieved: "达成",
  steps: "步数用完",
  cost: "花费额度用完",
  failed: "没做成",
  cancelled: "被停掉",
}

type Limits = {
  roundMaxSteps: string
  maxCostUsd: string
  maxSteps: string
  maxRounds: string
  deadline: string
}
const emptyLimits: Limits = {
  roundMaxSteps: "40",
  maxCostUsd: "",
  maxSteps: "",
  maxRounds: "",
  deadline: "",
}

function budgetFrom(limits: Limits) {
  const int = (value: string) => (value.trim() ? Number(value) : undefined)
  return {
    roundMaxSteps: int(limits.roundMaxSteps) ?? 40,
    maxCostMicros: limits.maxCostUsd.trim()
      ? Math.round(Number(limits.maxCostUsd) * 1_000_000)
      : undefined,
    maxSteps: int(limits.maxSteps),
    maxRounds: int(limits.maxRounds),
    deadlineAt: limits.deadline ? new Date(limits.deadline).toISOString() : undefined,
  }
}

function limitsFrom(item: Item): Limits {
  const budget = item.budget
  return {
    roundMaxSteps: String(budget.roundMaxSteps ?? 40),
    maxCostUsd:
      budget.maxCostMicros === undefined ? "" : String(budget.maxCostMicros / 1_000_000),
    maxSteps: budget.maxSteps === undefined ? "" : String(budget.maxSteps),
    maxRounds: budget.maxRounds === undefined ? "" : String(budget.maxRounds),
    deadline: budget.deadlineAt
      ? new Date(
          new Date(budget.deadlineAt).getTime() - new Date().getTimezoneOffset() * 60_000
        )
          .toISOString()
          .slice(0, 16)
      : "",
  }
}

function LimitFields({
  value,
  onChange,
  label,
}: {
  value: Limits
  onChange: (value: Limits) => void
  label: string
}) {
  const field = (key: keyof Limits, text: string, type = "number") => (
    <label className="space-y-1 text-sm">
      <span className="text-muted-foreground">{text}</span>
      <Input
        aria-label={`${label}${text}`}
        type={type}
        min={type === "number" ? 0 : undefined}
        step={key === "maxCostUsd" ? "0.01" : undefined}
        value={value[key]}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
      />
    </label>
  )
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      {field("roundMaxSteps", "每轮步数")}
      {field("maxCostUsd", "花费上限（美元）")}
      {field("maxSteps", "总步数上限")}
      {field("maxRounds", "轮数上限")}
      {field("deadline", "截止时间", "datetime-local")}
    </div>
  )
}

export function Objectives({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [agentId, setAgentId] = useState(initial.agents[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [objective, setObjective] = useState("")
  const [doneCriteria, setDoneCriteria] = useState("")
  const [csvPath, setCsvPath] = useState("")
  const [csvColumns, setCsvColumns] = useState("")
  const [csvRows, setCsvRows] = useState("1")
  const [review, setReview] = useState(false)
  const [limits, setLimits] = useState<Limits>(emptyLimits)
  const [editing, setEditing] = useState<{ id: string; limits: Limits } | null>(null)

  async function call(url: string, method: string, body: unknown) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      const fresh = await fetch("/api/objectives")
      if (fresh.ok) setData(await fresh.json())
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const date = (value: string | Date | null) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回工作现场
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">长期目标</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          交给 Agent
          一个需要很多步的目标，它会一轮一轮接着做，直到达成、你暂停或停止，或者碰到你设的上限。上限都可以不填，不填就不限；每月预算照常生效。
        </p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        aria-label="新目标"
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
        onSubmit={async (event) => {
          event.preventDefault()
          const ok = await call("/api/objectives", "POST", {
            agentId,
            title,
            objective,
            doneCriteria,
            completionContract: {
              requireHumanReview: review,
              ...(csvPath.trim()
                ? {
                    artifact: {
                      path: csvPath.trim(),
                      requiredColumns: csvColumns
                        .split(/[,，]/)
                        .map((column) => column.trim())
                        .filter(Boolean),
                      minRows: Number(csvRows || 1),
                    },
                  }
                : {}),
            },
            budget: budgetFrom(limits),
          })
          if (ok) {
            setTitle("")
            setObjective("")
            setDoneCriteria("")
            setCsvPath("")
            setCsvColumns("")
            setReview(false)
            setLimits(emptyLimits)
          }
        }}
      >
        <h2 className="font-medium">新目标</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">交给谁</span>
            <select
              aria-label="执行的 Agent"
              className={selectClass}
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {data.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">名字</span>
            <Input
              aria-label="目标名字"
              maxLength={60}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">要达成什么</span>
          <textarea
            aria-label="目标内容"
            className={area}
            maxLength={4000}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">怎样算完成（可不填）</span>
          <textarea
            aria-label="完成标准"
            className={area}
            maxLength={2000}
            value={doneCriteria}
            onChange={(event) => setDoneCriteria(event.target.value)}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">要交的 CSV 路径（可不填）</span>
            <Input
              aria-label="CSV 路径"
              placeholder="/home/agent/result.csv"
              value={csvPath}
              onChange={(event) => setCsvPath(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">必须有的列（逗号分隔）</span>
            <Input
              aria-label="CSV 列"
              value={csvColumns}
              onChange={(event) => setCsvColumns(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">至少几行</span>
            <Input
              aria-label="CSV 行数"
              type="number"
              min={0}
              value={csvRows}
              onChange={(event) => setCsvRows(event.target.value)}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={review}
            onChange={(event) => setReview(event.target.checked)}
          />
          完成时需要我确认
        </label>
        <LimitFields value={limits} onChange={setLimits} label="新目标" />
        <Button
          type="submit"
          disabled={busy || !agentId || !title.trim() || !objective.trim()}
        >
          开始
        </Button>
      </form>
      <section aria-label="目标列表" className="space-y-4">
        {data.objectives.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有长期目标。</p>
        )}
        {data.objectives.map((item) => {
          const open = item.status !== "achieved" && item.status !== "stopped"
          const agent = data.agents.find((agent) => agent.id === item.agentId)
          return (
            <article
              key={item.id}
              aria-label={`目标 ${item.title}`}
              className="space-y-3 rounded-2xl border border-border p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">{item.title}</h2>
                <span data-testid="objective-status" className="text-sm">
                  {objectiveStatusLabels[item.status] ?? item.status}
                  {item.statusReason ? `：${item.statusReason}` : ""}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                {item.objective}
              </p>
              <p className="text-xs text-muted-foreground">
                {agent?.name ?? "Agent"} · 已做 {item.usage.rounds} 轮 ·{" "}
                {item.usage.steps} 步 · 花费 $
                {(item.usage.costMicros / 1_000_000).toFixed(4)}
                {item.usage.unknownCost ? `（${item.usage.unknownCost} 次价格未知）` : ""}
                {item.budget.maxRounds ? ` · 轮数上限 ${item.budget.maxRounds}` : ""}
                {item.budget.maxSteps ? ` · 步数上限 ${item.budget.maxSteps}` : ""}
                {item.budget.maxCostMicros
                  ? ` · 花费上限 $${(item.budget.maxCostMicros / 1_000_000).toFixed(2)}`
                  : ""}
                {item.budget.deadlineAt ? ` · 截止 ${date(item.budget.deadlineAt)}` : ""}
              </p>
              {open && (
                <div className="flex flex-wrap gap-2">
                  {item.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        call(`/api/objectives/${item.id}`, "PATCH", { action: "pause" })
                      }
                    >
                      暂停
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        call(`/api/objectives/${item.id}`, "PATCH", { action: "resume" })
                      }
                    >
                      继续
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setEditing(
                        editing?.id === item.id
                          ? null
                          : { id: item.id, limits: limitsFrom(item) }
                      )
                    }
                  >
                    调整上限
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("停止后不能再继续，确定停止？"))
                        void call(`/api/objectives/${item.id}`, "PATCH", {
                          action: "stop",
                        })
                    }}
                  >
                    停止
                  </Button>
                </div>
              )}
              {editing?.id === item.id && (
                <form
                  aria-label="调整上限"
                  className="space-y-3"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    if (
                      await call(`/api/objectives/${item.id}`, "PATCH", {
                        budget: budgetFrom(editing.limits),
                      })
                    )
                      setEditing(null)
                  }}
                >
                  <LimitFields
                    value={editing.limits}
                    onChange={(limits) => setEditing({ id: item.id, limits })}
                    label="调整"
                  />
                  <Button size="sm" type="submit" disabled={busy}>
                    保存上限
                  </Button>
                </form>
              )}
              {item.rounds.length > 0 && (
                <ol className="space-y-2 text-sm">
                  {item.rounds.map((round) => (
                    <li key={round.roundNo} className="rounded border p-2">
                      <span className="font-medium">第 {round.roundNo} 轮</span> ·{" "}
                      {round.verdict
                        ? verdictLabels[round.verdict]
                        : round.taskStatus
                          ? "进行中"
                          : "准备中"}{" "}
                      · {date(round.startedAt)}
                      {round.taskId && (
                        <>
                          {" "}
                          ·{" "}
                          <Link
                            className="underline underline-offset-4"
                            href={`/?task=${encodeURIComponent(round.taskId)}`}
                          >
                            查看任务
                          </Link>
                        </>
                      )}
                      {round.summary && (
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {round.summary}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          )
        })}
      </section>
    </main>
  )
}
