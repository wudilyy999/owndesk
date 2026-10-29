"use client"
import { Button } from "@/components/ui/button"
import type { PendingRequest } from "@/components/task-request"
import type { VaultGrant } from "@/lib/vault-schema"

export const VAULT_FIELD_LABELS: Record<VaultGrant["fields"][number]["field"], string> = {
  username: "用户名",
  password: "密码",
  code: "验证码",
  name: "姓名",
  email: "邮箱",
  phone: "电话",
  address: "完整地址",
  address_line1: "地址第一行",
  address_line2: "地址第二行",
  city: "城市",
  state: "省/州",
  postcode: "邮编",
  country: "国家/地区",
  number: "卡号",
  expiry: "有效期",
  expiry_month: "有效期月份",
  expiry_year: "有效期年份",
  expiry_year_short: "有效期年份（两位）",
  id: "UPI ID",
}
export function VaultFillApproval({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (decision: string, response: Record<string, unknown>) => void
}) {
  const grant = request.payload as VaultGrant
  const waiting = request.status === "decided"
  return (
    <section
      aria-label="待处理请求"
      className="mt-5 space-y-4 rounded-lg border border-amber-500/35 p-4 text-sm"
    >
      <h4 className="font-medium">授权一次凭据填写</h4>
      <dl className="space-y-2 break-words">
        <div>
          <dt className="text-xs text-muted-foreground">目标站点</dt>
          <dd className="mt-1 font-medium break-all">{grant.origin}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">使用条目</dt>
          <dd className="mt-1">
            {grant.label} · {grant.hint} · 版本 {grant.revision}
          </dd>
        </div>
      </dl>
      {grant.payment && (
        <p className="rounded border p-3 leading-6">
          支付准备：{grant.payment.merchant} / {grant.payment.amount}。网页原文：
          {grant.payment.evidence.merchant.text} / {grant.payment.evidence.amount.text}
          。本次仅填入所列字段，不提交付款。
        </p>
      )}
      <ul aria-label="本次填写字段" className="space-y-2 rounded border p-3">
        {grant.fields.map((binding) => (
          <li key={binding.field}>
            <strong>
              {binding.field === "name" && grant.kind === "card"
                ? "持卡人"
                : VAULT_FIELD_LABELS[binding.field]}
            </strong>
            ：填写到 {binding.descriptor.name || binding.ref}
            <span className="ml-2 text-xs text-muted-foreground">
              {binding.descriptor.tag}/{binding.descriptor.type}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-5 text-muted-foreground">
        仅此任务、页面和操作有效，最长五分钟。页面、控件、条目或控制权变化会使批准失效。截止{" "}
        <time dateTime={grant.expiresAt}>
          {grant.expiresAt.replace("T", " ").slice(0, 19)} UTC
        </time>
        。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        批准后秘密进入 Agent
        工作站，站点和同一工作站代码可接触它们；输入框遮罩只减少意外显示。工具只输入，不点击提交或授权付款；站点脚本仍可能产生联动请求。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy || waiting}
          onClick={() => onRespond("approve", {})}
        >
          {waiting ? "正在处理填写决定…" : "同意本次填写"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || waiting}
          onClick={() => onRespond("decline", {})}
        >
          不填写，重新考虑
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || waiting}
          onClick={() => onRespond("cancel", {})}
        >
          取消这项任务
        </Button>
      </div>
    </section>
  )
}
