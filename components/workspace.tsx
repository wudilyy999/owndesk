"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { MenuIcon } from "lucide-react"
import { AppNavLinks } from "@/components/navigation"
import { DeliveryOptions, defaultDelivery } from "@/components/workspace/delivery-options"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { UploadPicker } from "@/components/upload-picker"
import type { UploadReference } from "@/lib/uploads"
import { Composer } from "@/components/thread/composer"
import { Transcript } from "@/components/thread/transcript"
import type { ThreadSummary } from "@/lib/threads"

import {
  TaskDetail,
  labels,
  type Detail,
  type Summary,
  type TaskEvent,
} from "@/components/workspace/task-detail"

export function Workspace({
  agents,
  initialTasks,
  initialThreads,
  initialSelected,
  maxSteps,
}: {
  agents: { id: string; name: string; role: string; model: string | null }[]
  initialTasks: Summary[]
  initialThreads: ThreadSummary[]
  initialSelected?: string
  maxSteps: number
}) {
  const sortThreads = (list: ThreadSummary[]) =>
    [...list].sort(
      (a, b) =>
        Date.parse(b.activeAt) - Date.parse(a.activeAt) || b.id.localeCompare(a.id)
    )
  const defaultSelected =
    initialSelected ?? initialThreads[0]?.latestTaskId ?? initialTasks[0]?.id ?? ""
  const [tasks, setTasks] = useState(initialTasks)
  const [threads, setThreads] = useState(() => sortThreads(initialThreads))
  const [selected, setSelected] = useState(defaultSelected)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<UploadReference[]>([])
  const [uploading, setUploading] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [idleTakeover, setIdleTakeover] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const [streamState, setStreamState] = useState("连接中")
  const preferred = agents[0]
  const initialAgentId =
    initialTasks.find((t) => t.id === defaultSelected)?.conversationAgentId ??
    initialThreads.find((th) => th.latestTaskId === defaultSelected)?.agentId ??
    preferred?.id ??
    ""
  const [agentId, setAgentId] = useState(initialAgentId)
  const [stepLimit, setStepLimit] = useState(maxSteps)
  const [delegateAgentIds, setDelegateAgentIds] = useState<string[]>([])
  const [handbackNote, setHandbackNote] = useState("")
  const [delivery, setDelivery] = useState(defaultDelivery)
  const pendingRequest = useRef<{ key: string; payload: string } | null>(null)
  const selectedSummary = tasks.find((task) => task.id === selected)
  const matchedThread =
    threads.find((th) => th.latestTaskId === selected) ??
    (selectedSummary?.threadId
      ? threads.find((th) => th.id === selectedSummary.threadId)
      : undefined)
  const conversationId =
    (selectedSummary?.conversationAgentId === agentId
      ? selectedSummary.threadId
      : null) ??
    (detail?.id === selected && detail.conversationAgentId === agentId
      ? detail.threadId
      : null) ??
    (matchedThread?.agentId === agentId ? matchedThread.id : null)

  function selectTask(id: string, targetAgentId?: string) {
    setNavigationOpen(false)
    setSelected(id)
    setIdleTakeover(false)
    setDetail(null)
    setError("")
    const nextAgent =
      targetAgentId ??
      tasks.find((t) => t.id === id)?.conversationAgentId ??
      threads.find((th) => th.latestTaskId === id)?.agentId
    if (nextAgent) setAgentId(nextAgent)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("task", id)
    else url.searchParams.delete("task")
    window.history.pushState({}, "", url)
  }

  useEffect(() => {
    const restore = () => {
      setSelected(new URL(window.location.href).searchParams.get("task") ?? "")
      setDetail(null)
    }
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [])

  useEffect(() => {
    if (!selected) {
      setEvents([])
      setDetail(null)
      setStreamState("未选择任务")
      return
    }
    const controller = new AbortController()
    setEvents([])
    setDetail(null)
    setStreamState("连接中")
    let latestRefresh = 0
    async function refresh() {
      const requestNumber = ++latestRefresh
      const response = await fetch(`/api/tasks/${selected}`, {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`读取任务失败 (${response.status})`)
      const task: Detail = await response.json()
      if (requestNumber === latestRefresh && !controller.signal.aborted) {
        setDetail(task)
        setAgentId(task.conversationAgentId)
        setTasks((previous) =>
          previous.some((t) => t.id === task.id)
            ? previous.map((t) =>
                t.id === task.id
                  ? {
                      ...t,
                      agentId: task.agentId,
                      conversationAgentId: task.conversationAgentId,
                      status: task.status,
                    }
                  : t
              )
            : [task, ...previous]
        )
        if (task.threadId)
          setThreads((previous) => {
            const existing = previous.find((thread) => thread.id === task.threadId)
            if (existing && existing.turnCount > task.threadTurn!) return previous
            const activeAt = existing
              ? new Date(
                  Math.max(Date.parse(existing.activeAt), Date.parse(task.updatedAt))
                ).toISOString()
              : task.updatedAt
            return sortThreads([
              {
                id: task.threadId!,
                agentId: task.conversationAgentId,
                title: task.thread?.title ?? existing?.title ?? task.goal.slice(0, 80),
                latestTaskId: task.id,
                status: task.status,
                turnCount: task.threadTurn!,
                activeAt,
              },
              ...previous.filter((thread) => thread.id !== task.threadId),
            ])
          })
      }
    }
    const fail = (error: unknown) => {
      if (!controller.signal.aborted) setError(String(error))
    }
    refreshRef.current = refresh
    refresh().catch(fail)
    const stream = new EventSource(`/api/tasks/${selected}/events?after=0`)
    stream.onopen = () => setStreamState("已连接")
    stream.onerror = () => setStreamState("连接中断，自动续接")
    stream.onmessage = (message) => {
      const event: TaskEvent = JSON.parse(message.data)
      setEvents((previous) =>
        previous.some((e) => e.seq === event.seq) ? previous : [...previous, event]
      )
      refresh().catch(fail)
    }
    return () => {
      controller.abort()
      stream.close()
      refreshRef.current = async () => {}
    }
  }, [selected])

  async function controlAction(url: string, body: Record<string, unknown> = {}) {
    setControlBusy(true)
    setError("")
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      await refreshRef.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setControlBusy(false)
    }
  }

  const conversationActive =
    conversationId &&
    threads.some(
      (thread) =>
        thread.id === conversationId &&
        !["completed", "cancelled", "failed"].includes(thread.status)
    )
  const draftKey = conversationId ? `thread:${conversationId}` : `new:${agentId}`
  useEffect(() => {
    setAttachments([])
  }, [draftKey])

  const navigation = (
    <>
      <div className="shrink-0 border-b border-hairline px-5 py-5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full bg-primary shadow-2xs"
          />
          <span className="text-lg font-semibold tracking-tight">OwnDesk</span>
        </div>
      </div>
      <div className="mx-3 mt-3 shrink-0 rounded-xl border border-border/80 bg-surface p-3 shadow-2xs">
        <p className="text-xs font-medium text-muted-foreground">当前 Agent</p>
        <select
          aria-label="选择 Agent"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value)
            selectTask("")
          }}
          disabled={busy}
          className="mt-2 w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm font-medium"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {agents.find((a) => a.id === agentId)?.role}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-3.5 w-full"
          disabled={busy}
          onClick={() => selectTask("")}
        >
          新对话
        </Button>
      </div>
      <div
        aria-label="会话列表"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mt-4 px-5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground">
          最近对话
        </div>
        <nav aria-label="最近对话" className="px-3 pb-3">
          {threads.map((thread) => {
            const isSelected =
              conversationId === thread.id || selected === thread.latestTaskId
            return (
              <button
                key={thread.id}
                type="button"
                disabled={busy}
                aria-current={isSelected ? "page" : undefined}
                onClick={() => selectTask(thread.latestTaskId, thread.agentId)}
                className={cn(
                  "relative mb-1.5 w-full rounded-xl border border-transparent px-3.5 py-2.5 text-left transition-all hover:bg-elevated/80 focus-visible:outline-2 focus-visible:outline-ring",
                  isSelected &&
                    "border-primary/45 bg-surface font-medium text-foreground shadow-xs ring-1 ring-primary/15"
                )}
              >
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="absolute top-2.5 bottom-2.5 left-1.5 w-1 rounded-full bg-primary"
                  />
                )}
                <span className="block truncate text-sm">{thread.title}</span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {thread.turnCount} 轮 · {labels[thread.status] ?? thread.status}
                  </span>
                  <time
                    dateTime={thread.activeAt}
                    className="shrink-0 font-mono text-[11px]"
                  >
                    {new Date(thread.activeAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                </span>
              </button>
            )
          })}
          {threads.length === 0 && (
            <p className="px-2.5 py-1 text-xs leading-6 text-muted-foreground">
              选择 Agent 并开始第一段对话。
            </p>
          )}
        </nav>
        {(tasks.some((task) => !task.threadId) || tasks.length === 0) && (
          <div className="px-5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground">
            独立任务
          </div>
        )}
        <nav aria-label="最近任务" className="px-3 pb-4">
          {tasks
            .filter((task) => !task.threadId)
            .map((task) => {
              const isSelected = selected === task.id
              return (
                <button
                  key={task.id}
                  type="button"
                  aria-current={isSelected ? "page" : undefined}
                  onClick={() => selectTask(task.id, task.conversationAgentId)}
                  disabled={busy}
                  className={cn(
                    "relative mb-1.5 w-full rounded-xl border border-transparent px-3.5 py-2.5 text-left transition-all hover:bg-elevated/80 focus-visible:outline-2 focus-visible:outline-ring",
                    isSelected &&
                      "border-primary/45 bg-surface font-medium text-foreground shadow-xs ring-1 ring-primary/15"
                  )}
                >
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="absolute top-2.5 bottom-2.5 left-1.5 w-1 rounded-full bg-primary"
                    />
                  )}
                  <span className="block truncate text-sm">{task.goal}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {labels[task.status] ?? task.status}
                  </span>
                </button>
              )
            })}
          {tasks.length === 0 && (
            <p className="px-2.5 py-1 text-xs leading-6 text-muted-foreground">
              还没有任务。选择 Agent 后即可交办。
            </p>
          )}
        </nav>
      </div>
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-hairline px-3 py-2">
        <AppNavLinks onNavigate={() => setNavigationOpen(false)} />
        <div className="pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start px-3 text-muted-foreground hover:text-foreground"
            onClick={async () => {
              try {
                const response = await fetch("/api/auth/sign-out", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                })
                if (!response.ok) throw new Error(`退出登录失败 (${response.status})`)
                window.location.assign("/login")
              } catch (error) {
                setError(String(error))
              }
            }}
          >
            退出登录
          </Button>
        </div>
      </div>
    </>
  )

  return (
    <main className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <aside
        aria-label="会话导航"
        className="hidden h-full w-76 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/55 md:flex"
      >
        {navigation}
      </aside>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/55 px-4 py-3 md:hidden">
        <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm" />}>
            <MenuIcon className="size-4" />
            会话
          </DialogTrigger>
          <DialogContent className="top-0 left-0 flex h-dvh w-76 max-w-[calc(100%-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none bg-background p-0 sm:max-w-76">
            <DialogTitle className="sr-only">会话导航</DialogTitle>
            {navigation}
          </DialogContent>
        </Dialog>
        <span className="text-sm font-semibold">OwnDesk</span>
      </div>
      <section
        aria-label="对话工作区"
        className="mx-auto min-h-0 w-full max-w-3xl min-w-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-4 py-5 sm:px-8 md:py-7"
      >
        {!conversationId && (
          <header className="space-y-1 border-b border-hairline pb-4">
            <h1 className="text-2xl font-semibold tracking-tight">工作区</h1>
            {!agentId && (
              <p className="text-sm text-muted-foreground">
                <Link href="/settings" className="underline underline-offset-4">
                  配置 Agent
                </Link>
                后即可开始。
              </p>
            )}
          </header>
        )}
        {conversationId && (
          <Transcript
            key={conversationId}
            threadId={conversationId}
            selectedTaskId={selected}
            refreshKey={`${detail?.status}:${detail?.usage.decisions}:${detail?.artifacts.length}:${detail?.supplements.length}`}
            agentName={agents.find((agent) => agent.id === agentId)!.name}
            onSelectTask={selectTask}
            onRename={(id, title) =>
              setThreads((previous) =>
                previous.map((thread) =>
                  thread.id === id ? { ...thread, title } : thread
                )
              )
            }
          />
        )}
        <Composer
          key={draftKey}
          draftKey={draftKey}
          label={conversationId ? "继续对话" : "交办任务"}
          busy={!!conversationActive}
          allowSupplement={detail?.canSupplement === true}
          sending={busy || controlBusy || uploading}
          disabled={!agentId || (!!selected && !detail)}
          onStop={() => {
            const current = threads.find((thread) => thread.id === conversationId)
            if (current) void controlAction(`/api/tasks/${current.latestTaskId}/cancel`)
          }}
          onSend={async (goal) => {
            setBusy(true)
            setError("")
            if (conversationActive) {
              const activeTaskId = threads.find(
                (thread) => thread.id === conversationId
              )!.latestTaskId
              const storageKey = `personal-agent:supplement:${activeTaskId}`
              try {
                const saved = sessionStorage.getItem(storageKey)
                const previous = saved
                  ? (JSON.parse(saved) as {
                      text: string
                      clientRequestId: string
                      attachmentIds?: string[]
                    })
                  : null
                const payload =
                  previous?.text === goal &&
                  JSON.stringify(previous.attachmentIds ?? []) ===
                    JSON.stringify(attachments.map((file) => file.id))
                    ? previous
                    : {
                        text: goal,
                        clientRequestId: crypto.randomUUID(),
                        ...(attachments.length
                          ? { attachmentIds: attachments.map((file) => file.id) }
                          : {}),
                      }
                sessionStorage.setItem(storageKey, JSON.stringify(payload))
                const response = await fetch(`/api/tasks/${activeTaskId}/supplements`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                })
                const result = await response.json()
                if (!response.ok) throw new Error(result.error)
                sessionStorage.removeItem(storageKey)
                await refreshRef.current()
                setAttachments([])
                return true
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
                return false
              } finally {
                setBusy(false)
              }
            }
            const completionContract = {
              requireHumanReview: delivery.review,
              ...(delivery.path.trim()
                ? {
                    artifact: {
                      path: delivery.path.trim(),
                      requiredColumns: delivery.columns
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                      minRows: delivery.minRows,
                      ...(delivery.dateColumn.trim()
                        ? { dateColumn: delivery.dateColumn.trim() }
                        : {}),
                      ...(delivery.dateFrom ? { dateFrom: delivery.dateFrom } : {}),
                      ...(delivery.dateTo ? { dateTo: delivery.dateTo } : {}),
                    },
                  }
                : {}),
            }
            const payload = {
              agentId,
              ...(attachments.length
                ? { attachmentIds: attachments.map((file) => file.id) }
                : {}),
              ...(delegateAgentIds.length ? { delegateAgentIds } : {}),
              goal,
              ...(conversationId ? { threadId: conversationId } : {}),
              budget: { maxSteps: stepLimit },
              completionContract,
            }
            const serialized = JSON.stringify(payload)
            try {
              const storageKey = `personal-agent:pending:${draftKey}`
              const stored = sessionStorage.getItem(storageKey)
              if (stored) {
                const candidate: unknown = JSON.parse(stored)
                if (
                  !candidate ||
                  typeof candidate !== "object" ||
                  !("key" in candidate) ||
                  typeof candidate.key !== "string" ||
                  !("payload" in candidate) ||
                  typeof candidate.payload !== "string"
                )
                  throw new Error("本地待提交记录损坏，请清理此站点的会话存储后重试")
                if (candidate.payload === serialized)
                  pendingRequest.current = {
                    key: candidate.key,
                    payload: candidate.payload,
                  }
              }
              if (
                !pendingRequest.current ||
                pendingRequest.current.payload !== serialized
              )
                pendingRequest.current = { key: crypto.randomUUID(), payload: serialized }
              const clientRequestId = pendingRequest.current.key
              sessionStorage.setItem(storageKey, JSON.stringify(pendingRequest.current))
              const response = await fetch("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...payload, clientRequestId }),
              })
              const result = await response.json()
              if (!response.ok) throw new Error(result.error)
              pendingRequest.current = null
              setTasks((previous) =>
                previous.some((task) => task.id === result.taskId)
                  ? previous
                  : [
                      {
                        id: result.taskId,
                        agentId,
                        conversationAgentId: agentId,
                        threadId: result.threadId,
                        threadTurn: result.threadTurn,
                        goal,
                        status: "queued",
                        createdAt: new Date().toISOString(),
                      },
                      ...previous,
                    ]
              )
              setAttachments([])
              selectTask(result.taskId)
              setDelegateAgentIds([])
              setDelivery(defaultDelivery)
              try {
                sessionStorage.removeItem(storageKey)
              } catch (cause) {
                setError(
                  `任务已受理，本地待提交记录清理失败：${cause instanceof Error ? cause.message : String(cause)}`
                )
              }
              return true
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error))
              return false
            } finally {
              setBusy(false)
            }
          }}
        >
          <UploadPicker
            agentId={agentId}
            files={attachments}
            onChange={setAttachments}
            disabled={busy || controlBusy}
            onBusy={setUploading}
          />
          <details className="rounded-xl border border-border/80 bg-surface/80 px-4 py-3 text-sm shadow-2xs open:space-y-3">
            <summary className="cursor-pointer font-medium">
              本轮允许交接的 Agent（默认关闭）
            </summary>
            <p className="text-xs text-muted-foreground">
              只允许勾选的 Agent
              接手本轮剩余任务；交接说明、选定文件及相关问答可能发送到接手者的模型服务。
            </p>
            {agents.map((agent) => (
              <label key={agent.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`允许交接给 ${agent.name}`}
                  checked={delegateAgentIds.includes(agent.id)}
                  onChange={(event) =>
                    setDelegateAgentIds((previous) =>
                      event.target.checked
                        ? [...previous, agent.id]
                        : previous.filter((id) => id !== agent.id)
                    )
                  }
                />
                {agent.name} · {agent.role}
              </label>
            ))}
          </details>
          <DeliveryOptions
            maxSteps={maxSteps}
            stepLimit={stepLimit}
            setStepLimit={setStepLimit}
            delivery={delivery}
            setDelivery={setDelivery}
          />
        </Composer>
        {error && (
          <p
            role="alert"
            aria-label="任务错误"
            className="rounded border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {detail?.id === selected && (
          <TaskDetail
            detail={detail}
            events={events}
            streamState={streamState}
            inConversation={!!conversationId}
            controlBusy={controlBusy}
            idleTakeover={idleTakeover}
            toggleIdleTakeover={() => setIdleTakeover((value) => !value)}
            handbackNote={handbackNote}
            setHandbackNote={setHandbackNote}
            controlAction={controlAction}
          />
        )}
      </section>
    </main>
  )
}
