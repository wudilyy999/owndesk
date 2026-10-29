"use client"
// Adapted from the pinned MIT upstream components/vault/vault-form.tsx (MIT).

import * as React from "react"
import { LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { VaultKind } from "@/lib/vault-schema"
import { cn } from "@/lib/utils"

// One form for everything the vault holds. Values go from here to the
// server, are encrypted there and never come back to the browser.

type FieldSpec = {
  name: string
  label: string
  placeholder?: string
  secret?: boolean
  numeric?: boolean
  optional?: boolean
  wide?: boolean
  autoComplete?: string
}

export const VAULT_FORMS: Record<VaultKind, { title: string; fields: FieldSpec[] }> = {
  card: {
    title: "银行卡",
    fields: [
      {
        name: "number",
        label: "卡号",
        placeholder: "1234 5678 9012 3456",
        numeric: true,
        wide: true,
        autoComplete: "cc-number",
      },
      { name: "expiry", label: "有效期", placeholder: "MM/YY", autoComplete: "cc-exp" },
      {
        name: "name",
        label: "持卡人",
        optional: true,
        wide: true,
        autoComplete: "cc-name",
      },
    ],
  },
  upi: {
    title: "UPI ID",
    fields: [{ name: "id", label: "UPI ID", placeholder: "name@bank", wide: true }],
  },
  login: {
    title: "网站账号",
    fields: [
      {
        name: "username",
        label: "用户名或邮箱",
        wide: true,
        autoComplete: "username",
      },
      {
        name: "password",
        label: "密码",
        secret: true,
        wide: true,
        autoComplete: "current-password",
      },
    ],
  },
  identity: {
    title: "身份资料",
    fields: [
      {
        name: "name",
        label: "姓名",
        optional: true,
        wide: true,
        autoComplete: "name",
      },
      { name: "email", label: "Email", optional: true, autoComplete: "email" },
      { name: "phone", label: "Phone", optional: true, autoComplete: "tel" },
      {
        name: "address_line1",
        label: "Address",
        optional: true,
        wide: true,
        autoComplete: "address-line1",
      },
      {
        name: "address_line2",
        label: "Address line 2",
        optional: true,
        wide: true,
        autoComplete: "address-line2",
      },
      { name: "city", label: "City", optional: true, autoComplete: "address-level2" },
      { name: "state", label: "State", optional: true, autoComplete: "address-level1" },
      {
        name: "postcode",
        label: "PIN / postcode",
        optional: true,
        autoComplete: "postal-code",
      },
      { name: "country", label: "Country", optional: true, autoComplete: "country-name" },
    ],
  },
  code: {
    title: "验证码",
    fields: [
      {
        name: "code",
        secret: true,
        label: "验证码",
        placeholder: "123456",
        numeric: true,
        wide: true,
        autoComplete: "one-time-code",
      },
    ],
  },
}

export function VaultForm({
  kind,
  defaults = {},
  initialLabel = "",
  saveOption = false,
  label: withLabel = true,
  submitLabel = "加密保存",
  onSubmit,
  onCancel,
  compact = false,
}: {
  kind: VaultKind
  defaults?: Record<string, string>
  initialLabel?: string
  // Offer "save for next time" (otherwise it's kept for this task only)
  saveOption?: boolean
  label?: boolean
  submitLabel?: string
  onSubmit: (
    data: Record<string, string>,
    options: { save: boolean; label?: string }
  ) => Promise<string | null>
  onCancel?: () => void
  compact?: boolean
}) {
  const spec = VAULT_FORMS[kind]
  const [values, setValues] = React.useState<Record<string, string>>(() => ({
    ...defaults,
  }))
  const [label, setLabel] = React.useState(initialLabel)
  const [save, setSave] = React.useState(kind !== "code")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  return (
    <form
      autoComplete="off"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        const problem = await onSubmit(values, {
          save: saveOption ? save : true,
          label: label.trim() || undefined,
        })
        setBusy(false)
        if (problem) setError(problem)
        // Nothing typed stays in the page once it's in the vault
        else setValues({ ...defaults })
      }}
      className="flex flex-col gap-3"
    >
      <div className={cn("grid gap-2.5", !compact && "sm:grid-cols-2")}>
        <label className={cn("flex flex-col gap-1", !compact && "sm:col-span-2")}>
          <span className="label-mono">目标站点（精确协议、主机和端口）</span>
          <Input
            aria-label="凭据目标站点"
            type="url"
            value={values.origin ?? ""}
            onChange={(event) =>
              setValues((current) => ({ ...current, origin: event.target.value }))
            }
            placeholder="https://reports.example.com"
            required
            autoComplete="off"
          />
        </label>
        {spec.fields.map((field) => (
          <label
            key={field.name}
            className={cn(
              "flex flex-col gap-1",
              field.wide && !compact && "sm:col-span-2"
            )}
          >
            <span className="label-mono">
              {field.label}
              {field.optional && (
                <span className="ml-1 text-faint normal-case">可选</span>
              )}
            </span>
            <Input
              aria-label={field.label}
              type={field.secret ? "password" : "text"}
              inputMode={field.numeric ? "numeric" : undefined}
              autoComplete={field.autoComplete ?? "off"}
              spellCheck={false}
              value={values[field.name] ?? ""}
              placeholder={field.placeholder}
              required={!field.optional && kind !== "identity"}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
              className="font-mono"
            />
          </label>
        ))}
        {withLabel && kind !== "code" && (
          <label className={cn("flex flex-col gap-1", !compact && "sm:col-span-2")}>
            <span className="label-mono">
              名称<span className="ml-1 text-faint normal-case">可选</span>
            </span>
            <Input
              aria-label="凭据名称"
              value={label}
              placeholder={kind === "card" ? "e.g. HDFC credit card" : "e.g. Personal"}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        )}
      </div>

      {saveOption && kind !== "code" && (
        <label className="flex items-center gap-2 text-[12.5px]">
          <Checkbox checked={save} onCheckedChange={(checked) => setSave(checked)} />
          保存到保险箱供以后使用；取消勾选则仅本任务有效
        </label>
      )}

      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <LockIcon data-icon="inline-start" />
          )}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-faint">
          <LockIcon className="size-3" />
          服务器加密保存；标签与提示可供 Agent 查看
        </span>
      </div>
    </form>
  )
}
