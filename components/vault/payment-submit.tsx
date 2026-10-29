"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { PendingRequest } from "@/components/task-request"
import type { PaymentSubmitGrant, PaymentResultReceipt } from "@/lib/payment-schema"

export function PaymentSubmitApproval({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (decision: string, response: Record<string, unknown>) => void
}) {
  const grant = request.payload as PaymentSubmitGrant
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const waiting = request.status === "decided"
  async function approve() {
    setSending(true)
    setError("")
    try {
      const response = await fetch(`/api/task-requests/${request.id}/payment-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payloadVersion: request.payloadVersion }),
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
      <h4 className="font-medium">确认一次付款提交</h4>
      <p className="text-base font-medium break-words">
        {grant.merchant} / {grant.amount}
      </p>
      <dl className="space-y-2 break-words">
        <div>
          <dt className="text-xs text-muted-foreground">站点</dt>
          <dd className="break-all">{grant.origin}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">准备的支付资料</dt>
          <dd>
            {grant.method.label} · {grant.method.hint}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">将点击的网页按钮</dt>
          <dd className="font-medium">{grant.target.label}</dd>
        </div>
        {grant.target.formAction && (
          <div>
            <dt className="text-xs text-muted-foreground">表单目标</dt>
            <dd className="break-all">
              {grant.target.formMethod.toUpperCase()} {grant.target.formAction}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-muted-foreground">独立读取的网页原文</dt>
          <dd>
            {grant.evidence.merchant.text} / {grant.evidence.amount.text}
          </dd>
        </div>
      </dl>
      <p className="leading-6">
        这次确认会点击一次提交按钮，可能产生实际扣款。此前的资料选择和填写确认没有授权这一步。页面或按钮变化会停止派发；结果未知时请先核对账单，系统不会自动再点。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        页面和读取器同属可修改的工作站，文本一致不保证商户身份或最终收款结果。点击回执只证明派发，付款状态需要后续证据。有效至{" "}
        <time dateTime={grant.expiresAt}>
          {grant.expiresAt.replace("T", " ").slice(0, 19)} UTC
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
          disabled={busy || sending || waiting}
          onClick={() => void approve()}
        >
          {waiting ? "正在处理提交决定…" : "确认，点击一次付款按钮"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || sending || waiting}
          onClick={() => onRespond("decline", {})}
        >
          不提交，重新考虑
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

export function PaymentResultEvidence({ result }: { result: PaymentResultReceipt }) {
  return (
    <section
      aria-label="付款页面证据"
      className="my-5 space-y-2 rounded border p-4 text-sm break-words"
    >
      <h4 className="font-medium">付款页面证据 · 尚未独立核销</h4>
      <p>
        {result.evidence.merchant.text} / {result.evidence.amount.text}
      </p>
      <p>网页状态：{result.evidence.status.text}</p>
      <p>网页回执/订单号：{result.evidence.receipt.text}</p>
      <p className="text-xs break-all text-muted-foreground">来源站点：{result.origin}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        程序保存了工作站页面的原文，与模型总结分开展示。页面及读取器可被工作站代码修改；这些文字不证明银行已扣款或商户已核销。
      </p>
    </section>
  )
}
