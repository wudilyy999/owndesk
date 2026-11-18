"use client"
import { useId, useState } from "react"
import { Paperclip } from "lucide-react"
import type { UploadReference } from "@/lib/uploads"

export function UploadPicker({
  agentId,
  files,
  onChange,
  disabled,
  onBusy,
}: {
  agentId: string
  files: UploadReference[]
  onChange: (files: UploadReference[]) => void
  disabled?: boolean
  onBusy?: (busy: boolean) => void
}) {
  const id = useId(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  return (
    <div className="space-y-2 text-xs">
      <input
        id={id}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.webp,.gif"
        disabled={disabled || busy || !agentId || files.length >= 8}
        aria-describedby={`${id}-formats`}
        className="peer sr-only"
        onChange={async (event) => {
          const input = event.currentTarget,
            selected = Array.from(input.files ?? [])
          if (files.length + selected.length > 8) {
            setError("每次最多 8 个附件")
            input.value = ""
            return
          }
          setBusy(true)
          onBusy?.(true)
          setError("")
          const uploaded = [...files]
          try {
            for (const file of selected) {
              const form = new FormData()
              form.set("file", file)
              const response = await fetch(
                `/api/uploads?agentId=${encodeURIComponent(agentId)}`,
                { method: "POST", body: form }
              )
              const result = await response.json()
              if (!response.ok) throw new Error(result.error)
              uploaded.push(result)
              onChange([...uploaded])
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
            onBusy?.(false)
            input.value = ""
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2 peer-focus-visible:[&>label]:ring-2 peer-focus-visible:[&>label]:ring-ring peer-disabled:[&>label]:pointer-events-none peer-disabled:[&>label]:opacity-50">
        <label
          htmlFor={id}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium shadow-2xs transition-colors hover:bg-elevated"
        >
          <Paperclip className="size-3.5" aria-hidden="true" />
          添加文件
        </label>
        <span id={`${id}-formats`} className="text-muted-foreground">
          PDF、Word、Excel、CSV、图片
        </span>
        {files.length > 0 && (
          <span className="text-muted-foreground">已添加 {files.length}/8</span>
        )}
      </div>
      {busy && <p role="status">正在上传…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {files.map((file) => (
        <div key={file.id} className="flex items-center gap-2 break-all">
          <a href={`/api/uploads/${file.id}`} className="underline">
            {file.name}
          </a>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => onChange(files.filter((item) => item.id !== file.id))}
            aria-label={`移除 ${file.name}`}
            className="shrink-0"
          >
            移除
          </button>
        </div>
      ))}
    </div>
  )
}
