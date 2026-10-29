"use client"
// Saved-method radio choices and handoff intent adapted from the pinned MIT upstream request-cards.tsx (MIT).
import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { PendingRequest } from "@/components/task-request"
import type { PaymentApproval } from "@/lib/payment-schema"

export function PaymentRequest({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (decision: string, response: Record<string, unknown>) => void
}) {
  const payment = request.payload as PaymentApproval
  const [method, setMethod] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const waiting = request.status === "decided"
  const selected = payment.methods.find((item) => item.id === method)
  async function choose(action: "select" | "takeover") {
    setSending(true)
    setError("")
    try {
      const response = await fetch(`/api/task-requests/${request.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          payloadVersion: request.payloadVersion,
          ...(action === "select"
            ? { itemId: selected!.id, revision: selected!.revision }
            : {}),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }
  return (
    <section
      aria-label="待处理请求"
      className="mt-5 space-y-4 rounded-lg border border-amber-500/35 p-4 text-sm"
    >
      <h4 className="font-medium">选择支付资料或人工处理</h4>
      <dl className="space-y-3 break-words">
        <div>
          <dt className="text-xs text-muted-foreground">Agent 提议（待你确认）</dt>
          <dd className="mt-1 text-base font-medium">
            {payment.amount} · {payment.merchant}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">目标站点</dt>
          <dd className="mt-1 break-all">{payment.origin}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">网页原文（独立读取）</dt>
          <dd className="mt-1">
            {payment.evidence.merchant.text} / {payment.evidence.amount.text}
          </dd>
        </div>
      </dl>
      <p className="leading-6">{payment.reason}</p>
      <fieldset disabled={busy || sending || waiting} className="space-y-2">
        <legend className="mb-2 font-medium">本次可用的保存方式</legend>
        {payment.methods.map((item) => (
          <label
            key={item.id}
            className={`flex cursor-pointer flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${method === item.id ? "border-ring bg-background/70" : "hover:bg-background/40"}`}
          >
            <input
              type="radio"
              name={`pay-${request.id}`}
              checked={method === item.id}
              onChange={() => setMethod(item.id)}
              className="accent-current"
            />
            <span>{item.label}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {item.hint} · 版本{item.revision}
            </span>
          </label>
        ))}
        {!payment.methods.length && (
          <p className="text-muted-foreground">
            暂无同站点可用资料。可人工处理；也可先通过安全表单或保险箱添加资料，再发起新的请求。
          </p>
        )}
      </fieldset>
      <p className="text-xs leading-5 text-muted-foreground">
        本次选择只允许下一次指定条目的资料填写，随后仍会展示具体字段的批准卡，不授权提交或付款。仅核对工作站网页原文一致性；工作站代码可修改页面及读取器，不证明商户身份、最终账单或收款结果。站点脚本仍可能在输入时发出请求。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        页面、观察、金额、条目或控制权变化需重新申请；有效至{" "}
        <time dateTime={payment.expiresAt}>
          {payment.expiresAt.replace("T", " ").slice(0, 19)} UTC
        </time>
        。
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy || sending || waiting || !selected}
          onClick={() => void choose("select")}
        >
          {waiting ? "正在处理选择…" : "同意使用所选资料"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || sending || waiting}
          onClick={() => void choose("takeover")}
        >
          我来处理，接管桌面
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || sending || waiting}
          onClick={() => onRespond("decline", {})}
        >
          拒绝本次支付请求
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || sending || waiting}
          onClick={() => onRespond("cancel", {})}
        >
          取消这项任务
        </Button>
      </div>
    </section>
  )
}
