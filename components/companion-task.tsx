"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { TaskRequest, type PendingRequest } from "@/components/task-request"
import { UploadPicker } from "@/components/upload-picker"
import type { UploadReference } from "@/lib/uploads"
import { Composer } from "@/components/thread/composer"

type TaskView = {
  id: string
  agentId: string
  attachments: UploadReference[]
  status: string
  canSupplement: boolean
  supplements: { seq: number; text: string; attachments?: UploadReference[] }[]
  requests: PendingRequest[]
  artifacts: { id: string; name: string }[]
}

export function CompanionTask({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<UploadReference[]>([])
  const [uploading, setUploading] = useState(false)
  const ended = !!task && ["completed", "cancelled", "failed"].includes(task.status)
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    setTask(result)
    setError("")
  }, [taskId])
  useEffect(() => {
    if (ended) return
    let active = true
    const update = () =>
      refresh().catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    void update()
    const timer = setInterval(() => {
      if (!document.hidden) void update()
    }, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [refresh, ended])
  async function post(url: string, payload: Record<string, unknown>) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  const active = task && !["completed", "cancelled", "failed"].includes(task.status)
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "正在处理",
    waiting_user: "等你回复",
    verifying: "核对中",
    waiting_human: "等你回复",
    needs_review: "需要复核",
    completed: "已完成",
    cancelled: "已停止",
    failed: "执行失败",
  }
  return (
    <section aria-label="聊天任务" className="mt-3 space-y-2 border-t border-border pt-2">
      <p className="flex flex-wrap gap-3 text-xs text-faint">
        <span>{task ? (labels[task.status] ?? task.status) : "正在读取任务…"}</span>
        <Link className="underline" href={`/?task=${encodeURIComponent(taskId)}`}>
          打开工作现场
        </Link>
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {task?.supplements.map((supplement) => (
        <p key={supplement.seq} className="text-xs whitespace-pre-wrap">
          你的补充：{supplement.text}
          {supplement.attachments?.map((file) => (
            <a
              key={file.id}
              href={`/api/uploads/${file.id}`}
              className="block text-xs underline"
            >
              {file.name}
            </a>
          ))}
        </p>
      ))}
      {task?.requests
        .filter((request) => ["pending", "decided"].includes(request.status))
        .map((request) =>
          request.kind === "takeover" ? (
            <p key={request.id} className="text-sm">
              {String(request.payload.reason ?? "需要你接管电脑")}
              <Link
                className="ml-2 underline"
                href={`/?task=${encodeURIComponent(taskId)}`}
              >
                前往接管
              </Link>
            </p>
          ) : (
            <TaskRequest
              key={request.id}
              request={request}
              busy={busy}
              onRespond={(decision, response) => {
                void post(`/api/task-requests/${request.id}/respond`, {
                  decision,
                  response,
                  payloadVersion: request.payloadVersion,
                })
              }}
            />
          )
        )}
      {task?.attachments.map((file) => (
        <a
          key={file.id}
          href={`/api/uploads/${file.id}`}
          className="block text-xs underline"
        >
          输入文件：{file.name}
        </a>
      ))}
      {task?.artifacts.map((file) => (
        <a
          key={file.id}
          className="block text-sm underline"
          href={`/api/artifacts/${file.id}`}
        >
          {file.name}
        </a>
      ))}
      {active && task.canSupplement && (
        <Composer
          draftKey={`companion-task:${taskId}`}
          label="补充当前任务"
          busy
          allowSupplement
          sending={busy || uploading}
          disabled={false}
          onStop={() => {
            void post(`/api/tasks/${taskId}/cancel`, {})
          }}
          onSend={async (text) => {
            try {
              const key = `personal-agent:supplement:${taskId}`
              const saved = sessionStorage.getItem(key)
              const previous = saved
                ? (JSON.parse(saved) as {
                    text: string
                    clientRequestId: string
                    attachmentIds?: string[]
                  })
                : null
              const payload =
                previous?.text === text &&
                JSON.stringify(previous.attachmentIds ?? []) ===
                  JSON.stringify(attachments.map((file) => file.id))
                  ? previous
                  : {
                      text,
                      clientRequestId: crypto.randomUUID(),
                      ...(attachments.length
                        ? { attachmentIds: attachments.map((file) => file.id) }
                        : {}),
                    }
              sessionStorage.setItem(key, JSON.stringify(payload))
              const sent = await post(`/api/tasks/${taskId}/supplements`, payload)
              if (sent) {
                sessionStorage.removeItem(key)
                setAttachments([])
              }
              return sent
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
              return false
            }
          }}
        >
          <UploadPicker
            agentId={task.agentId}
            files={attachments}
            onChange={setAttachments}
            disabled={busy}
            onBusy={setUploading}
          />
        </Composer>
      )}
    </section>
  )
}
