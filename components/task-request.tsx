"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import Link from "next/link"
import { ReportComparison } from "@/components/report-comparison"
import type { ComparisonResult } from "@/lib/report-comparison"
import { VaultRequest } from "@/components/vault/request"
import { VaultFillApproval, VAULT_FIELD_LABELS } from "@/components/vault/fill-approval"
import { PaymentRequest } from "@/components/vault/payment"
import { PaymentSubmitApproval } from "@/components/vault/payment-submit"
export type PendingRequest = {
  id: string
  kind: string
  status: string
  payloadVersion: number
  payload: Record<string, unknown>
}
export function TaskRequest({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (decision: string, response: Record<string, unknown>) => void
}) {
  const [note, setNote] = useState("")
  const budget = request.payload.budget as
    { maxSteps?: number; maxCostMicros?: number } | undefined
  const [steps, setSteps] = useState(Math.min(200, (budget?.maxSteps ?? 40) + 20))
  const [cost, setCost] = useState(
    budget?.maxCostMicros === undefined ? "" : String(budget.maxCostMicros / 1000000)
  )
  const [removeCap, setRemoveCap] = useState(false)
  const purpose = request.payload.purpose
  const waiting = request.status === "decided"
  if (purpose === "vault_secret")
    return <VaultRequest request={request} busy={busy} onRespond={onRespond} />
  if (purpose === "vault_fill")
    return <VaultFillApproval request={request} busy={busy} onRespond={onRespond} />
  if (purpose === "payment")
    return <PaymentRequest request={request} busy={busy} onRespond={onRespond} />
  if (purpose === "payment_submit")
    return <PaymentSubmitApproval request={request} busy={busy} onRespond={onRespond} />
  return (
    <section
      aria-label="待处理请求"
      className="mt-5 space-y-3 rounded-lg border border-amber-500/35 p-4 text-sm"
    >
      <h4 className="font-medium">
        {request.kind === "approval"
          ? "需要你的回答或确认"
          : request.kind === "budget"
            ? "需要追加执行额度"
            : purpose === "completion"
              ? "请检查交付结果"
              : "需要复核后继续"}
      </h4>
      <p className="leading-6 break-words whitespace-pre-wrap">
        {String(
          request.payload.question ??
            request.payload.summary ??
            request.payload.reason ??
            request.payload.message ??
            "请确认下一步"
        )}
      </p>
      {purpose === "completion" && !!request.payload.comparison && (
        <>
          <p className="text-xs text-muted-foreground">
            下面是宿主程序的核对结果；确认交付后才提交完成状态和通知决策。
          </p>
          <ReportComparison result={request.payload.comparison as ComparisonResult} />
        </>
      )}
      {request.kind === "budget" && purpose === "limits" && (
        <div className="space-y-3">
          <label className="block space-y-1">
            新的步骤上限
            <Input
              aria-label="新的步骤上限"
              type="number"
              min={1}
              max={200}
              value={steps}
              onChange={(event) => setSteps(+event.target.value)}
            />
          </label>
          {budget?.maxCostMicros !== undefined && (
            <>
              <label className="block space-y-1">
                新的费用上限（美元估算）
                <Input
                  aria-label="新的费用上限"
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={removeCap}
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={removeCap}
                  onChange={(event) => setRemoveCap(event.target.checked)}
                />
                移除费用上限，允许费用未知的请求
              </label>
            </>
          )}
        </div>
      )}
      {purpose === "monthly" && (
        <p className="text-sm leading-6">
          先到{" "}
          <Link href="/usage" className="underline underline-offset-4">
            用量与预算
          </Link>{" "}
          调整额度、单价或核对未知费用，再点击重新检查。新自然月会自动重新检查。
        </p>
      )}
      {request.payload.tool === "vault_fill" && !!request.payload.details && (
        <div className="space-y-1 text-xs leading-5">
          <p>
            已返回填入成功的字段：
            {(
              request.payload.details as { filled: (keyof typeof VAULT_FIELD_LABELS)[] }
            ).filled
              .map((field) => VAULT_FIELD_LABELS[field])
              .join("、") || "暂无"}
          </p>
          <p>
            尝试过的字段：
            {(
              request.payload.details as {
                attempted: (keyof typeof VAULT_FIELD_LABELS)[]
              }
            ).attempted
              .map((field) => VAULT_FIELD_LABELS[field])
              .join("、") || "暂无"}
            。请核对当前页面，系统不会自动再填一次。
          </p>
        </div>
      )}
      <label className="block space-y-2">
        {request.kind === "approval" ? "你的回答 / 补充条件" : "说明（可选）"}
        <Textarea
          aria-label="请求答复"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={4000}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || waiting}
          onClick={() =>
            onRespond(
              request.kind === "approval"
                ? "approve"
                : purpose === "completion"
                  ? "complete"
                  : "continue",
              {
                note,
                ...(request.kind === "approval" ? { answer: note } : {}),
                ...(request.kind === "budget" && purpose === "limits"
                  ? {
                      budget: {
                        maxSteps: steps,
                        ...(removeCap
                          ? { maxCostMicros: null }
                          : cost
                            ? { maxCostMicros: Math.round(+cost * 1000000) }
                            : {}),
                      },
                    }
                  : {}),
              }
            )
          }
        >
          {waiting
            ? "正在处理决定…"
            : purpose === "completion"
              ? "确认交付"
              : purpose === "model_retry"
                ? "同意再次请求模型"
                : purpose === "monthly"
                  ? "重新检查月预算"
                  : request.kind === "approval"
                    ? "确认并继续"
                    : "继续处理"}
        </Button>
        {request.kind === "approval" && (
          <Button
            variant="outline"
            disabled={busy || waiting}
            onClick={() => onRespond("decline", { note, answer: note })}
          >
            不同意，重新考虑
          </Button>
        )}
        {purpose === "completion" && (
          <Button
            variant="outline"
            disabled={busy || waiting}
            onClick={() => onRespond("continue", { note })}
          >
            退回修改
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy || waiting}
          onClick={() => onRespond("cancel", { note })}
        >
          取消这项任务
        </Button>
      </div>
      {request.kind === "approval" && (
        <p className="text-xs leading-5 text-muted-foreground">
          密码、验证码和付款信息请通过安全表单或接管桌面填写，不要写入答复框。
        </p>
      )}
      {purpose === "model_retry" && (
        <p className="text-xs leading-5 text-muted-foreground">
          上次模型请求可能已经计费。再次请求需你明确同意，未知费用会保留在用量记录里。
        </p>
      )}
    </section>
  )
}
