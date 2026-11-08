"use client"
import { useId, useState } from "react"
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
      <label htmlFor={id} className="block">
        添加文件（PDF、Word、Excel、CSV、图片）
      </label>
      <input
        id={id}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.webp,.gif"
        disabled={disabled || busy || !agentId || files.length >= 8}
        className="block w-full min-w-0 text-xs"
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
      {busy && <p>正在上传…</p>}
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
