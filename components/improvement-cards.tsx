"use client"

// Self-improvement cards in the chat (B1): the proposal (editable checklist, confirm) and the
// lab's report (tests, checklist verdicts, adopt / revise / abandon).
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { CompanionMessage } from "@/db/schema"

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
  return result
}

type Proposal = {
  title: string
  request: string
  checklist: string[]
  budget: { maxCostMicros?: number; maxRounds?: number; deadlineAt?: string }
}

export function ImprovementProposalCard({
  message,
  onChanged,
}: {
  message: CompanionMessage
  onChanged: () => void
}) {
  const meta = (message.metadata ?? {}) as {
    proposal: Proposal
    status: string
    checklist?: string[]
  }
  const [items, setItems] = useState(meta.checklist ?? meta.proposal.checklist)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = meta.status === "pending"
  async function act(action: "confirm" | "cancel") {
    setBusy(true)
    setError(null)
    try {
      await post(`/api/companion/improvements/${message.id}`, {
        action,
        ...(action === "confirm"
          ? { checklist: items.map((item) => item.trim()).filter(Boolean) }
          : {}),
      })
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const budget = meta.proposal.budget
  return (
    <div className="space-y-2" data-testid="improvement-proposal">
      <p className="text-xs text-faint">改进提议：要在实验室里改我自己吗？</p>
      <p className="font-medium">{meta.proposal.title}</p>
      <p>{meta.proposal.request}</p>
      <div className="space-y-1">
        <p className="text-xs">验收清单（会在候选版本上实际检查）：</p>
        {items.map((item, index) =>
          pending ? (
            <div key={index} className="flex gap-1">
              <Textarea
                aria-label={`验收项 ${index + 1}`}
                rows={1}
                value={item}
                maxLength={300}
                onChange={(event) =>
                  setItems(
                    items.map((old, i) => (i === index ? event.target.value : old))
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`删除验收项 ${index + 1}`}
                onClick={() => setItems(items.filter((_, i) => i !== index))}
                disabled={items.length <= 1}
              >
                ×
              </Button>
            </div>
          ) : (
            <p key={index} className="text-xs">
              ☐ {item}
            </p>
          )
        )}
        {pending && items.length < 12 && (
          <Button size="sm" variant="ghost" onClick={() => setItems([...items, ""])}>
            加一项
          </Button>
        )}
      </div>
      <p className="text-xs text-faint">
        {[
          budget.maxCostMicros !== undefined &&
            `花费上限 $${(budget.maxCostMicros / 1_000_000).toFixed(2)}`,
          budget.maxRounds !== undefined && `最多 ${budget.maxRounds} 轮`,
          budget.deadlineAt && `截止 ${new Date(budget.deadlineAt).toLocaleString()}`,
        ]
          .filter(Boolean)
          .join(" · ") || "没有上限（每月预算照常生效）"}
      </p>
      <p className="text-xs text-faint">
        第一版只改界面和行为：不改测试、评测、预算、登录、密码库、工作站，不加第三方包，不改数据库结构。
      </p>
      {pending ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => act("confirm")}>
            确认，开始改进
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("cancel")}>
            不用了
          </Button>
        </div>
      ) : (
        <p className="text-xs text-faint">
          {meta.status === "cancelled" ? (
            "已取消"
          ) : (
            <a href="/improvements" className="underline underline-offset-4">
              已开始，到自我改进页查看
            </a>
          )}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export type ReportStage = {
  name: string
  status: "pass" | "fail" | "skip"
  counts?: { passed: number; total: number }
}
export const stageNames: Record<string, string> = {
  policy: "范围与密钥检查",
  build: "构建",
  checks: "自动测试",
  stack: "候选环境",
  e2e: "真实实测",
}

export function ImprovementReportCard({ message }: { message: CompanionMessage }) {
  const meta = (message.metadata ?? {}) as {
    summary?: string
    stages?: ReportStage[]
    acceptance?: { item: string; status: string; note: string }[]
  }
  return (
    <div className="space-y-2" data-testid="improvement-report">
      <p className="text-xs text-faint">改进报告：全部测试通过</p>
      <p className="font-medium">{message.content}</p>
      {meta.summary && <p>{meta.summary}</p>}
      <ul className="text-xs">
        {meta.stages?.map((stage) => (
          <li key={stage.name}>
            {stage.status === "pass" ? "✅" : stage.status === "skip" ? "➖" : "❌"}{" "}
            {stageNames[stage.name] ?? stage.name}
            {stage.counts ? ` ${stage.counts.passed}/${stage.counts.total}` : ""}
          </li>
        ))}
        {meta.acceptance?.map((item) => (
          <li key={item.item}>
            {item.status === "pass" ? "✅" : "❌"} {item.item}
          </li>
        ))}
      </ul>
      <a href="/improvements" className="text-xs underline underline-offset-4">
        到自我改进页看报告，决定采用、再改改或放弃
      </a>
    </div>
  )
}
