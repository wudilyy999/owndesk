"use client"
// BudgetCard/price controls adapted from the pinned MIT upstream components/usage/spend-controls.tsx (MIT).
import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatUsd, PRICES_AS_OF } from "@/lib/providers/pricing"
import type { usageOverview } from "@/lib/spend"

type Overview = Awaited<ReturnType<typeof usageOverview>>
const dollars = (micros: string | number) => formatUsd(Number(micros) / 1000000)
export function Usage({ initial }: { initial: Overview }) {
  const [data, setData] = useState(initial)
  const [budget, setBudget] = useState(
    initial.month.budgetMicros === null
      ? ""
      : String(initial.month.budgetMicros / 1000000)
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("")
  const [model, setModel] = useState(""),
    [input, setInput] = useState(""),
    [output, setOutput] = useState(""),
    [cached, setCached] = useState("")
  async function save(body: Record<string, unknown>) {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const response = await fetch("/api/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setData(result)
      setMessage("已保存。历史请求的原始回执与价格快照保持不变。")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const used = Number(data.month.knownCostMicros),
    limit = data.month.budgetMicros
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回工作现场
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">用量与预算</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          每次模型请求分别记账，恢复读取旧回答不重复收费。这里显示本地估算和人工核对，服务商实际账单以其记录为准。
        </p>
      </header>
      {error && (
        <p role="alert" aria-label="用量错误" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <section
        aria-label="本月用量"
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">
            {data.month.month} · {data.month.timeZone}
          </h2>
          <p className="font-mono text-sm tabular-nums">
            已知费用 {dollars(used)}
            {limit !== null && ` / ${dollars(limit)}`}
          </p>
        </div>
        {limit !== null && (
          <div
            role="progressbar"
            aria-label="月预算使用比例"
            aria-valuemin={0}
            aria-valuemax={Math.max(1, limit)}
            aria-valuenow={Math.min(Math.max(1, limit), used)}
            className="h-2 w-full overflow-hidden rounded-full bg-border"
          >
            <div
              className={`h-full ${used >= limit || data.month.unknown ? "bg-destructive" : "bg-rigel"}`}
              style={{ width: `${Math.min(1, used / Math.max(1, limit)) * 100}%` }}
            />
          </div>
        )}
        {limit !== null && (used >= limit || data.month.unknown > 0) && (
          <p className="text-sm text-destructive">
            新的付费请求已暂停，请调整预算或核对未知费用。
          </p>
        )}
        <p className="text-sm">
          {data.month.attempts} 次请求 · {data.month.pendingPaid} 次付费请求在途 ·{" "}
          {data.month.unknown} 次费用待核对
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save({ action: "budget", value: budget })
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="min-w-40 flex-1 space-y-2 text-sm">
            每月预算（美元；0 暂停付费）
            <Input
              aria-label="每月预算"
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="留空不设本地上限"
            />
          </label>
          <Button type="submit" disabled={busy}>
            保存月预算
          </Button>
        </form>
        <p className="text-xs leading-5 text-muted-foreground">
          按拥有者时区的请求发起月份统计。达到已知费用上限或存在未核对费用时暂停新的付费请求；已在途请求仍可能使费用超过上限。设置月预算时付费请求串行，本地模型继续运行。下月自动重新检查等待任务。
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          留空移除本地值后会恢复环境变量预算；彻底停用需移除
          OWNDESK_MONTHLY_BUDGET。单价来源为固定目录（{PRICES_AS_OF}
          ）或自定义值，目录不实时更新。
        </p>
        {data.month.legacy > 0 && (
          <p className="text-xs text-muted-foreground">
            含 {data.month.legacy} 条迁移记录；旧重试时间缺失时按原决定首次记录时间归档。
          </p>
        )}
      </section>
      <section className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6">
        <h2 className="text-lg font-medium">自定义模型单价</h2>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void save({
              action: "price",
              model,
              rate: {
                input: Number(input),
                output: Number(output),
                ...(cached === "" ? {} : { cached: Number(cached) }),
              },
            })
          }}
        >
          <label className="block space-y-2 text-sm">
            模型 ID
            <Input
              aria-label="定价模型 ID"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="custom/your-model"
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["输入单价", input, setInput],
              ["输出单价", output, setOutput],
              ["缓存输入单价（可选）", cached, setCached],
            ].map(([label, value, update]) => (
              <label key={String(label)} className="space-y-2 text-sm">
                {String(label)}
                <Input
                  aria-label={String(label)}
                  type="number"
                  min={0}
                  step="any"
                  required={label !== "缓存输入单价（可选）"}
                  value={String(value)}
                  onChange={(event) =>
                    (update as (value: string) => void)(event.target.value)
                  }
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            单位：美元 / 百万 token。仅影响之后的新请求，旧请求不按新单价重新估算。
          </p>
          <Button type="submit" disabled={busy}>
            保存模型单价
          </Button>
        </form>
        {Object.entries(data.prices).map(([spec, rate]) => (
          <div
            key={spec}
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span className="break-all">
              {spec} · 输入 ${rate.input} / 输出 ${rate.output}
              {rate.cached !== undefined && ` / 缓存 $${rate.cached}`}
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void save({ action: "price", model: spec, rate: null })}
            >
              移除 {spec} 自定义单价
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6">
        <h2 className="text-lg font-medium">本月按模型汇总</h2>
        {data.models.length ? (
          data.models.map((row) => (
            <div key={row.model} className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="break-all">{row.model}</span>
              <span>
                {row.attempts} 次 · {dollars(row.costMicros)} · {row.unknown} 次待核对
              </span>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">本月尚无模型请求。</p>
        )}
      </section>
      <section className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6">
        <h2 className="text-lg font-medium">请求明细</h2>
        {!data.attempts.length && (
          <p className="text-sm text-muted-foreground">还没有请求记录。</p>
        )}
        {data.attempts.map((attempt) => (
          <article
            key={attempt.id}
            aria-label={`请求 ${attempt.id}`}
            className="space-y-2 border-b pb-4 text-sm"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <Link
                href={`/?task=${encodeURIComponent(attempt.taskId)}`}
                className="break-all underline underline-offset-4"
              >
                {attempt.model} · 尝试 {attempt.attemptNo}
              </Link>
              <span>
                {attempt.costMicros !== null
                  ? dollars(attempt.costMicros)
                  : attempt.reconciledCostMicros !== null
                    ? `${dollars(attempt.reconciledCostMicros)}（人工核对）`
                    : attempt.status === "pending"
                      ? "请求在途"
                      : "费用未知"}
              </span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {new Date(attempt.startedAt).toLocaleString("zh-CN", {
                timeZone: data.month.timeZone,
              })}{" "}
              ·{" "}
              {attempt.status === "succeeded"
                ? "已收到回答"
                : attempt.status === "pending"
                  ? "尚未保存回答"
                  : "回答/计费结果不确定"}
              {attempt.usage
                ? ` · 输入 ${attempt.usage.input} / 输出 ${attempt.usage.output} / 缓存 ${attempt.usage.cached} / 推理 ${attempt.usage.reasoning}${attempt.usage.missing ? "（用量不完整）" : ""}`
                : " · token 用量未返回"}
              {attempt.legacy ? " · 迁移记录" : ""}
            </p>
            {attempt.reconciliationNote && (
              <p className="text-xs">核对说明：{attempt.reconciliationNote}</p>
            )}
            {attempt.costMicros === null && attempt.status !== "pending" && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  void save({
                    action: "reconcile",
                    id: attempt.id,
                    costMicros: Math.round(Number(form.get("amount")) * 1000000),
                    note: String(form.get("note")),
                  })
                }}
              >
                <label className="min-w-32 flex-1 space-y-1 text-xs">
                  实际费用（美元，未收费填 0）
                  <Input
                    aria-label={`核对费用 ${attempt.id}`}
                    name="amount"
                    type="number"
                    min={0}
                    step="0.000001"
                    required
                    defaultValue={
                      attempt.reconciledCostMicros === null
                        ? ""
                        : String(Number(attempt.reconciledCostMicros) / 1000000)
                    }
                  />
                </label>
                <label className="min-w-40 flex-1 space-y-1 text-xs">
                  账单依据
                  <Input
                    aria-label={`核对说明 ${attempt.id}`}
                    name="note"
                    required
                    maxLength={1000}
                  />
                </label>
                <Button type="submit" variant="outline" disabled={busy}>
                  保存费用核对 {attempt.id}
                </Button>
              </form>
            )}
          </article>
        ))}
        {data.hasMore && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                const response = await fetch(
                  `/api/usage?before=${data.attempts.at(-1)!.id}`
                )
                const result = await response.json()
                if (!response.ok) throw new Error(result.error)
                setData((previous) => ({
                  ...result,
                  attempts: [...previous.attempts, ...result.attempts],
                }))
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            加载更早请求
          </Button>
        )}
      </section>
    </main>
  )
}
