"use client"
// List/add/remove flow adapted from the pinned MIT upstream components/settings/vault-panel.tsx (MIT).
import { useEffect, useState } from "react"
import { LockIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VaultForm, VAULT_FORMS } from "@/components/vault/vault-form"
import type { VaultItemView, VaultKind } from "@/lib/vault-schema"

const addable: VaultKind[] = ["login", "identity", "card", "upi"]
export function VaultPanel() {
  const [items, setItems] = useState<VaultItemView[] | null>(null)
  const [form, setForm] = useState<{
    kind: VaultKind
    id: string
    item?: VaultItemView
  } | null>(null)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/vault")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setItems(data)
    })().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause))
    )
  }, [])
  return (
    <section
      aria-label="凭据保险箱"
      className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
    >
      <h2 className="flex items-center gap-2 text-lg font-medium">
        <LockIcon className="size-4" />
        凭据保险箱
      </h2>
      <p className="text-sm leading-6 text-muted-foreground">
        账号、身份和支付资料在服务器加密保存。这里只显示标签、脱敏提示和允许站点；编辑时重新输入资料，旧值不会返回网页。验证码由任务安全表单临时提供，卡片不保存
        CVV。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        网站账号和验证码可逐次授权填写；身份、支付资料和特殊控件仍可接管操作。填写后的值及登录态可被目标网站和同一工作站代码接触，遮罩无法提供隔离。
      </p>
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
      <div className="flex flex-wrap gap-2">
        {addable.map((kind) => (
          <Button
            type="button"
            key={kind}
            size="sm"
            variant="outline"
            onClick={() => {
              setError("")
              setMessage("")
              setForm({ kind, id: crypto.randomUUID() })
            }}
          >
            <PlusIcon className="size-3.5" />
            添加{VAULT_FORMS[kind].title}
          </Button>
        ))}
      </div>
      {items === null ? (
        <p className="text-sm text-muted-foreground">正在读取条目…</p>
      ) : items.length === 0 ? (
        <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">
          还没有保存凭据。先添加一个网站账号，或在任务请求时提供临时资料。
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{item.label}</p>
                <p className="text-xs break-all text-muted-foreground">{item.hint}</p>
                <p className="mt-1 text-xs break-all text-muted-foreground">
                  {item.origin ?? "目标站点待确认，不能自动使用"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError("")
                  setMessage("")
                  setForm({ kind: item.kind, id: item.id, item })
                }}
              >
                替换{item.label}
              </Button>
              {confirm === item.id ? (
                <>
                  <span className="text-xs">确定删除？</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError("")
                      try {
                        const response = await fetch("/api/vault", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: item.id, revision: item.revision }),
                        })
                        const data = await response.json()
                        if (!response.ok) throw new Error(data.error)
                        setItems((previous) =>
                          previous!.filter((row) => row.id !== item.id)
                        )
                        setConfirm(null)
                        setMessage("凭据已删除，新的使用将被拒绝。")
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    确认删除
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm(null)}
                  >
                    保留
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`删除凭据：${item.label}`}
                  onClick={() => setConfirm(item.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {form && (
        <div className="space-y-4 rounded-lg border p-4">
          <h3 className="text-sm font-medium">
            {form.item
              ? "重新输入全部资料以替换条目；旧授权会失效"
              : `添加${VAULT_FORMS[form.kind].title}`}
          </h3>
          <VaultForm
            key={`${form.id}:${form.item?.revision ?? 0}`}
            kind={form.kind}
            defaults={{ origin: form.item?.origin ?? "" }}
            initialLabel={form.item?.label}
            onCancel={() => setForm(null)}
            onSubmit={async (data, options) => {
              const { origin, ...fields } = data
              try {
                const response = await fetch("/api/vault", {
                  method: form.item ? "PATCH" : "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    id: form.id,
                    kind: form.kind,
                    origin,
                    label: options.label ?? "",
                    fields,
                    ...(form.item ? { revision: form.item.revision } : {}),
                  }),
                })
                const result = await response.json()
                if (!response.ok) return result.error
                setItems((previous) => [
                  result,
                  ...(previous ?? []).filter((row) => row.id !== result.id),
                ])
                setForm(null)
                setMessage("凭据已加密保存。网页和模型只读取脱敏信息。")
                return null
              } catch (cause) {
                return cause instanceof Error ? cause.message : String(cause)
              }
            }}
          />
        </div>
      )}
    </section>
  )
}
