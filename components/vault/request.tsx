"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { VaultForm, VAULT_FORMS } from "@/components/vault/vault-form"
import type { PendingRequest } from "@/components/task-request"
import type { VaultItemView, VaultKind } from "@/lib/vault-schema"

export function VaultRequest({
  request,
  busy,
  onRespond,
}: {
  request: PendingRequest
  busy: boolean
  onRespond: (decision: string, response: Record<string, unknown>) => void
}) {
  const kind = request.payload.secretKind as VaultKind
  const origin = String(request.payload.origin)
  const [items, setItems] = useState<VaultItemView[]>([])
  const [selected, setSelected] = useState("")
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const [itemId] = useState(() => crypto.randomUUID())
  const waiting = request.status === "decided"
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/vault")
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        setItems(
          data.filter(
            (item: VaultItemView) => item.kind === kind && item.origin === origin
          )
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [kind, origin])
  async function provide(body: Record<string, unknown>) {
    const response = await fetch(`/api/task-requests/${request.id}/secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payloadVersion: request.payloadVersion, ...body }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
  }
  return (
    <section
      aria-label="待处理请求"
      className="mt-5 space-y-4 rounded-lg border border-amber-500/35 p-4 text-sm"
    >
      <h4 className="font-medium">安全提供{VAULT_FORMS[kind].title}</h4>
      <p className="leading-6 break-words">{String(request.payload.reason)}</p>
      <p className="break-all">
        指定站点：<strong>{origin}</strong>
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        表单通过认证网页加密保存，只把条目编号和版本回复给任务。此步骤不填写网页、不授权付款。临时条目仅本任务有效，10
        分钟过期；验证码始终临时保存。
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {waiting ? (
        <p role="status">凭据决定已保存，正在继续任务…</p>
      ) : (
        <>
          {!!items.length && (
            <div className="space-y-2">
              <label className="block space-y-2">
                选择这个站点的已有条目
                <select
                  aria-label="选择已有凭据"
                  className="block w-full rounded border border-input bg-background px-3 py-2"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">提供新资料</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} — {item.hint}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <Button
                  type="button"
                  disabled={busy || sending}
                  onClick={async () => {
                    setSending(true)
                    setError("")
                    try {
                      const item = items.find((item) => item.id === selected)!
                      await provide({
                        action: "select",
                        itemId: item.id,
                        revision: item.revision,
                      })
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    } finally {
                      setSending(false)
                    }
                  }}
                >
                  使用这个条目的引用
                </Button>
              )}
            </div>
          )}
          {!selected && (
            <VaultForm
              kind={kind}
              defaults={{ origin }}
              saveOption
              submitLabel="安全提供并继续"
              onSubmit={async (data, options) => {
                const { origin: target, ...fields } = data
                try {
                  await provide({
                    action: "provide",
                    save: options.save,
                    item: {
                      id: itemId,
                      kind,
                      origin: target,
                      label: options.label ?? "",
                      fields,
                    },
                  })
                  return null
                } catch (cause) {
                  return cause instanceof Error ? cause.message : String(cause)
                }
              }}
            />
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || waiting}
          onClick={() => onRespond("decline", {})}
        >
          不提供，重新考虑
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
