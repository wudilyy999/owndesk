"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { workflowPackageMaxBytes, workflowImportSchema } from "@/lib/workflow-package"

export function WorkflowExport({ versionId }: { versionId: string }) {
  const [preview, setPreview] = useState("")
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <section aria-label="导出流程包" className="space-y-3 border-l-2 pl-4 text-sm">
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError("")
          setPreview("")
          setReviewed(false)
          try {
            const response = await fetch(
              `/api/workflows/${encodeURIComponent(versionId)}/export`,
              { cache: "no-store" }
            )
            const result = await response.json()
            if (!response.ok) throw new Error(result.error)
            setPreview(JSON.stringify(result, null, 2))
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? "准备中…" : "准备脱敏流程包"}
      </Button>
      {preview && (
        <>
          <p>
            已使用中性名称、参数和三组虚构样例；跨应用包保留步骤中的固定文本，请逐项审阅。本地任务、费用、轨迹证据、审批及控制引用均不导出。软件环境仅作兼容性声明，接收方必须重新验证。
          </p>
          <details open>
            <summary>审阅导出内容</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs break-all whitespace-pre-wrap">
              {preview}
            </pre>
          </details>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            我已审阅全部内容，确认没有秘密、联系人和生产文件名，可以分享。
          </label>
          <Button
            disabled={!reviewed}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([preview], { type: "application/json" })
              )
              const link = document.createElement("a")
              link.href = url
              link.download = "desktop-workflow.json"
              link.click()
              URL.revokeObjectURL(url)
            }}
          >
            下载已审阅的流程包
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

export function WorkflowImport() {
  const router = useRouter()
  const [content, setContent] = useState("")
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState("")
  const pending = useRef<{ key: string; content: string } | null>(null)
  const storageKey = "personal-agent:workflow-import"
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (!saved) return
      const record = JSON.parse(saved)
      workflowImportSchema.parse({
        clientRequestId: record.key,
        reviewed: true,
        package: JSON.parse(record.content),
      })
      pending.current = record
      setContent(record.content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  return (
    <form
      aria-label="导入流程包"
      className="space-y-4 rounded-2xl border border-border bg-surface p-5 text-sm shadow-2xs sm:p-6"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        setResult("")
        try {
          if (!reviewed) throw new Error("请先审阅流程包及其操作范围")
          const pack: unknown = JSON.parse(content)
          if (pending.current?.content !== content)
            pending.current = { key: crypto.randomUUID(), content }
          const body = JSON.stringify({
            clientRequestId: pending.current.key,
            reviewed: true,
            package: pack,
          })
          if (new TextEncoder().encode(body).byteLength > workflowPackageMaxBytes)
            throw new Error("导入请求上限为128 KiB")
          sessionStorage.setItem(storageKey, JSON.stringify(pending.current))
          const response = await fetch("/api/workflows/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
          const value = await response.json()
          if (!response.ok) throw new Error(value.error)
          pending.current = null
          sessionStorage.removeItem(storageKey)
          setContent("")
          setReviewed(false)
          setResult(
            `已导入草稿 ${value.versionId}。尚未启动工作站；请在下方用三组不同的新参数独立验证。`
          )
          router.refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2 className="font-medium">导入本地流程包</h2>
      <p>
        仅接收有限的 Thunar 目录流程。导入后保留为草稿，不继承 ready
        状态、来源样例成绩或任何授权，也不会执行脚本、创建任务或启动工作站。
      </p>
      <label className="block space-y-2">
        选择 JSON 文件
        <input
          className="block max-w-full"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={async (event) => {
            setError("")
            setReviewed(false)
            setResult("")
            setContent("")
            try {
              const file = event.target.files?.[0]
              if (!file) return
              if (file.size > workflowPackageMaxBytes)
                throw new Error("流程包上限为128 KiB")
              setContent(await file.text())
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          }}
        />
      </label>
      {content && (
        <details open>
          <summary>审阅导入内容</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs break-all whitespace-pre-wrap">
            {content}
          </pre>
        </details>
      )}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        我已核对参数、步骤、环境和检查合同，允许保存这个外部流程草稿。
      </label>
      <Button type="submit" disabled={busy || !content || !reviewed}>
        {busy ? "导入中…" : "导入为待验证草稿"}
      </Button>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="break-words">
          {result}
        </p>
      )}
    </form>
  )
}
