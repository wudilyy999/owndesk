"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { MenuIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { TaskRequest } from "@/components/task-request"
import { Button } from "@/components/ui/button"
import { Desktop } from "@/components/desktop"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { UploadPicker } from "@/components/upload-picker"
import type { UploadReference } from "@/lib/uploads"
import { Composer } from "@/components/thread/composer"
import { Transcript } from "@/components/thread/transcript"
import type { ThreadSummary } from "@/lib/threads"
import { ReportComparison } from "@/components/report-comparison"
import type { ComparisonResult } from "@/lib/report-comparison"
import { PaymentResultEvidence } from "@/components/vault/payment-submit"
import type { PaymentResultReceipt } from "@/lib/payment-schema"

type Summary = {
  id: string
  agentId: string
  conversationAgentId: string
  threadId: string | null
  threadTurn: number | null
  goal: string
  status: string
  createdAt: string
}
type Event = {
  seq: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}
type Detail = Summary & {
  canSupplement: boolean
  supplements: { seq: number; text: string }[]
  thread: { id: string; title: string | null } | null
  updatedAt: string
  agentId: string
  configSnapshot: { runtime: "fixture" | "agent" }
  usage: {
    decisions: number
    known_cost_micros: string
    unknown_cost_attempts: number
    uncertain_attempts: number
  }
  cancelRequestedAt: string | null
  control: { mode: string; epoch: number; desiredMode: string | null } | null
  requests: {
    id: string
    kind: string
    status: string
    payloadVersion: number
    payload: Record<string, unknown>
  }[]
  actions: { segmentNo: number; actionNo: number; kind: string; status: string }[]
  paymentResults: PaymentResultReceipt[]
  activeSegment: number
  segments: {
    segmentNo: number
    agentId: string
    name: string
    model: string
    brief: string | null
  }[]
  error: string | null
  result: Record<string, unknown> | null
  workflowRun?: {
    versionId: string
    purpose: string
    totalSteps: number
    step: number
    phase: string
    blockedReason: string | null
    allowRepair: boolean
    repairStatus: string | null
    repairCursor: number | null
    draftVersionId: string | null
  } | null
  artifacts: { id: string; name: string; size: number; verification: { grade: string } }[]
}
const labels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  waiting_user: "等待你处理",
  needs_review: "待复核",
  cancelled: "已取消",
  verifying: "核对中",
}

export function Workspace({
  ownerName,
  agents,
  initialTasks,
  initialThreads,
  initialSelected,
  maxSteps,
}: {
  ownerName: string
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
  const [events, setEvents] = useState<Event[]>([])
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
  const [delivery, setDelivery] = useState({
    path: "",
    columns: "",
    minRows: 1,
    dateColumn: "",
    dateFrom: "",
    dateTo: "",
    review: false,
  })
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
      const event: Event = JSON.parse(message.data)
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

  const takeoverRequest = detail?.requests.find(
    (request) =>
      request.kind === "takeover" && ["pending", "decided"].includes(request.status)
  )
  const active = !!detail && !["completed", "cancelled", "failed"].includes(detail.status)
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
          <h1 className="text-lg font-semibold tracking-tight">OwnDesk</h1>
        </div>
        <p className="mt-1 pl-5 text-xs text-muted-foreground">
          {ownerName} 的私有工作现场
        </p>
      </div>
      <div className="mx-4 mt-4 shrink-0 rounded-xl border border-border/80 bg-surface p-4 shadow-2xs">
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
      <div className="shrink-0 space-y-1 border-t border-hairline px-3 py-4">
        <Link
          href="/companion"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          陪伴聊天
        </Link>
        <Link
          href="/settings"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          模型与 Agent 设置
        </Link>
        <Link
          href="/usage"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          用量与预算
        </Link>
        <Link
          href="/routines"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          定时例程
        </Link>
        <Link
          href="/objectives"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          长期目标
        </Link>
        <Link
          href="/improvements"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          自我改进
        </Link>
        <Link
          href="/versions"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          版本
        </Link>
        <Link
          href="/workflows"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          电脑操作流程
        </Link>
        <Link
          href="/manuals"
          className="block rounded-lg px-3 py-2 text-sm text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
        >
          操作手册
        </Link>
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
        className="hidden h-full w-76 shrink-0 flex-col border-r border-border bg-muted/55 md:flex"
      >
        {navigation}
      </aside>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/55 px-4 py-3 md:hidden">
        <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm" />}>
            <MenuIcon className="size-4" />
            会话
          </DialogTrigger>
          <DialogContent className="top-0 left-0 flex h-dvh w-76 max-w-[calc(100%-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-background p-0 sm:max-w-76">
            <DialogTitle className="sr-only">会话导航</DialogTitle>
            {navigation}
          </DialogContent>
        </Dialog>
        <span className="text-sm font-semibold">OwnDesk</span>
      </div>
      <section
        aria-label="对话工作区"
        className="mx-auto min-h-0 w-full max-w-3xl min-w-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-8 sm:px-8 md:py-10"
      >
        <header className="space-y-2.5">
          <p className="inline-flex items-center rounded-full border border-border/80 bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-2xs">
            私有工作站 · 后台持续执行
          </p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-[26px]">
            任务进度留在服务器
          </h2>
          <p className="max-w-2xl text-[14.5px] leading-7 text-muted-foreground">
            任务在服务器上运行，你可以关闭网页，随后回来继续查看。需要登录或确认时，Agent
            会暂停等待你。
          </p>
        </header>
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
              setDelivery({
                path: "",
                columns: "",
                minRows: 1,
                dateColumn: "",
                dateFrom: "",
                dateTo: "",
                review: false,
              })
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
          <details className="space-y-3 rounded-xl border border-border/80 bg-surface/80 px-4 py-3 text-sm shadow-2xs">
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
          <details className="space-y-3 rounded-xl border border-border/80 bg-surface/80 px-4 py-3 text-sm shadow-2xs">
            <summary className="cursor-pointer font-medium">
              交付检查与执行额度（可选）
            </summary>
            <label className="mt-3 block space-y-1">
              模型步骤上限
              <input
                aria-label="本次模型步骤上限"
                type="number"
                min={1}
                max={maxSteps}
                value={stepLimit}
                onChange={(event) => setStepLimit(+event.target.value)}
                className="block w-full rounded border border-input bg-background px-2 py-2"
              />
            </label>
            <label className="block space-y-1">
              CSV 文件路径
              <input
                aria-label="CSV 文件路径"
                value={delivery.path}
                onChange={(event) =>
                  setDelivery({ ...delivery, path: event.target.value })
                }
                placeholder="例如 report.csv；相对于工作站 home"
                className="block w-full rounded border border-input bg-background px-2 py-2"
              />
            </label>
            <label className="block space-y-1">
              必需字段（英文逗号分隔）
              <input
                aria-label="CSV 必需字段"
                value={delivery.columns}
                onChange={(event) =>
                  setDelivery({ ...delivery, columns: event.target.value })
                }
                placeholder="date,amount"
                className="block w-full rounded border border-input bg-background px-2 py-2"
              />
            </label>
            <label className="block space-y-1">
              最少数据行
              <input
                aria-label="CSV 最少数据行"
                type="number"
                min={0}
                value={delivery.minRows}
                onChange={(event) =>
                  setDelivery({ ...delivery, minRows: +event.target.value })
                }
                className="block w-full rounded border border-input bg-background px-2 py-2"
              />
            </label>
            <label className="block space-y-1">
              日期字段
              <input
                aria-label="CSV 日期字段"
                value={delivery.dateColumn}
                onChange={(event) =>
                  setDelivery({ ...delivery, dateColumn: event.target.value })
                }
                className="block w-full rounded border border-input bg-background px-2 py-2"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                开始日期
                <input
                  aria-label="CSV 开始日期"
                  type="date"
                  value={delivery.dateFrom}
                  onChange={(event) =>
                    setDelivery({ ...delivery, dateFrom: event.target.value })
                  }
                  className="mt-1 block w-full rounded border border-input bg-background px-2 py-2"
                />
              </label>
              <label>
                结束日期
                <input
                  aria-label="CSV 结束日期"
                  type="date"
                  value={delivery.dateTo}
                  onChange={(event) =>
                    setDelivery({ ...delivery, dateTo: event.target.value })
                  }
                  className="mt-1 block w-full rounded border border-input bg-background px-2 py-2"
                />
              </label>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={delivery.review}
                onChange={(event) =>
                  setDelivery({ ...delivery, review: event.target.checked })
                }
              />
              交付前由我确认
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              CSV 检查核对字段、行数和日期范围；来源数据与文字事实仍需业务核实。
            </p>
          </details>
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
          <section
            aria-label="任务详情"
            className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-xs sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3.5">
              <h3 className="text-lg font-semibold">
                {labels[detail.status] ?? detail.status}
              </h3>
              <span className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-xs text-muted-foreground">
                事件流：{streamState}
              </span>
            </div>
            <p className="font-mono text-xs break-all text-muted-foreground">
              任务 ID：{detail.id}
            </p>
            {detail.segments.length > 1 && (
              <section
                aria-label="Agent 交接记录"
                className="mt-4 rounded border border-border p-3 text-sm"
              >
                <h4 className="font-medium">顺序交接 · 同一个任务与总预算</h4>
                <ol className="mt-2 space-y-3">
                  {detail.segments.map((segment) => (
                    <li key={segment.segmentNo} className="space-y-1 break-words">
                      <p>
                        第 {segment.segmentNo} 段 · {segment.name} ·{" "}
                        {segment.segmentNo === detail.activeSegment
                          ? "当前执行段"
                          : "已交接"}
                      </p>
                      <p className="text-xs text-muted-foreground">{segment.model}</p>
                      {segment.brief && (
                        <p className="text-xs">交接说明：{segment.brief}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {active && detail.control?.mode === "human" && (
              <label className="mt-4 block space-y-2 text-sm">
                交还时的说明（可选）
                <Textarea
                  aria-label="交还说明"
                  value={handbackNote}
                  onChange={(event) => setHandbackNote(event.target.value)}
                  maxLength={4000}
                  placeholder="例如已登录，请继续下载本周报表"
                />
              </label>
            )}
            {active && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {detail.control?.mode === "human" &&
                !detail.control.desiredMode &&
                takeoverRequest ? (
                  <Button
                    disabled={controlBusy}
                    onClick={() =>
                      controlAction(`/api/task-requests/${takeoverRequest.id}/respond`, {
                        decision: "handback",
                        payloadVersion: takeoverRequest.payloadVersion,
                        response: { note: handbackNote },
                      })
                    }
                  >
                    交还给 Agent
                  </Button>
                ) : (
                  detail.control && (
                    <Button
                      variant="secondary"
                      disabled={
                        controlBusy ||
                        !!detail.control.desiredMode ||
                        ["quiescing", "quarantined"].includes(detail.control.mode) ||
                        !!detail.cancelRequestedAt
                      }
                      onClick={() =>
                        controlAction(`/api/tasks/${detail.id}/takeover`, {
                          requestId: crypto.randomUUID(),
                          reason: "拥有者请求接管桌面",
                        })
                      }
                    >
                      {detail.control.desiredMode === "human" ||
                      detail.control.mode === "quiescing"
                        ? "正在停止 Agent 输入…"
                        : "接管桌面"}
                    </Button>
                  )
                )}
                <Button
                  variant="outline"
                  disabled={controlBusy || !!detail.cancelRequestedAt}
                  onClick={() => controlAction(`/api/tasks/${detail.id}/cancel`)}
                >
                  {detail.cancelRequestedAt ? "正在停止实际操作…" : "取消任务"}
                </Button>
              </div>
            )}
            {!active && detail.configSnapshot.runtime !== "fixture" && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant={idleTakeover ? "default" : "secondary"}
                  onClick={() => setIdleTakeover((v) => !v)}
                >
                  {idleTakeover ? "结束接管" : "接管桌面"}
                </Button>
              </div>
            )}
            {detail.configSnapshot.runtime !== "fixture" && (
              <Desktop
                key={detail.agentId}
                agentId={detail.agentId}
                epoch={detail.control?.epoch ?? 0}
                takeover={
                  active
                    ? detail.control?.mode === "human" && !detail.control.desiredMode
                    : idleTakeover
                }
                enabled={
                  !detail.control ||
                  (["human", "agent", "idle"].includes(detail.control.mode) &&
                    !detail.control.desiredMode)
                }
              />
            )}
            {active &&
              detail.requests
                .filter(
                  (request) =>
                    request.kind !== "takeover" &&
                    ["pending", "decided"].includes(request.status)
                )
                .map((request) => (
                  <TaskRequest
                    key={request.id}
                    request={request}
                    busy={controlBusy}
                    onRespond={(decision, response) =>
                      controlAction(`/api/task-requests/${request.id}/respond`, {
                        decision,
                        response,
                        payloadVersion: request.payloadVersion,
                      })
                    }
                  />
                ))}
            {!conversationId && typeof detail.result?.summary === "string" && (
              <article
                aria-label="交付结果"
                className="mt-5 rounded-xl border border-border bg-elevated/55 p-4 text-[14.5px] leading-7 break-words whitespace-pre-wrap sm:p-5"
              >
                {detail.result.summary}
              </article>
            )}
            {detail.workflowRun && (
              <section className="my-4 space-y-2 border-l-2 pl-4 text-sm">
                <h3 className="font-medium">
                  {detail.workflowRun.purpose === "verify"
                    ? "流程样例验证"
                    : "固定流程执行"}{" "}
                  · 步骤{" "}
                  {Math.min(detail.workflowRun.step + 1, detail.workflowRun.totalSteps)}/
                  {detail.workflowRun.totalSteps}
                </h3>
                <p className="text-muted-foreground">
                  {detail.workflowRun.repairStatus
                    ? `局部修订：${({ requesting: "请求中", accepted: "候选已接入", rejected: "已停止" } as Record<string, string>)[detail.workflowRun.repairStatus]}。实际模型调用与费用见用量记录。`
                    : detail.workflowRun.allowRepair
                      ? "按固定计划执行，允许一次有界局部修订。"
                      : "本次按固定计划执行，未请求模型。"}
                  每个实际动作单独记账，最终结果由宿主检查。
                </p>
                {detail.workflowRun.draftVersionId && (
                  <p>修订草稿已保存，独立验证通过后才能启用；原版本保持不变。</p>
                )}
                {detail.workflowRun.blockedReason && (
                  <p className="break-words">
                    停止原因：{detail.workflowRun.blockedReason}
                  </p>
                )}
                <Link href="/workflows" className="underline underline-offset-4">
                  查看流程版本
                </Link>
              </section>
            )}
            {detail.status === "completed" && (
              <Link
                href={
                  detail.result?.manualDraft
                    ? "/manuals"
                    : `/manuals?source=${encodeURIComponent(detail.id)}`
                }
                className="block text-sm underline underline-offset-4"
              >
                {detail.result?.manualDraft ? "审阅操作手册草稿" : "生成操作手册"}
              </Link>
            )}
            {detail.status === "completed" &&
              !!(detail.result?.workflow || detail.result?.directoryTree) && (
                <Link
                  href={
                    detail.result?.workflow
                      ? "/workflows"
                      : `/workflows?source=${encodeURIComponent(detail.id)}`
                  }
                  className="block text-sm underline underline-offset-4"
                >
                  {detail.result?.workflow ? "查看流程候选" : "保存为流程"}
                </Link>
              )}
            {!!detail.result?.comparison && (
              <ReportComparison result={detail.result.comparison as ComparisonResult} />
            )}
            {detail.paymentResults.map((result, index) => (
              <PaymentResultEvidence key={index} result={result} />
            ))}
            {detail.usage.decisions > 0 && (
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                {detail.usage.decisions} 个模型决定 · 已知估算费用 $
                {(Number(detail.usage.known_cost_micros) / 1000000).toFixed(6)}
                {detail.usage.unknown_cost_attempts > 0
                  ? ` · ${detail.usage.unknown_cost_attempts} 次费用未知`
                  : ""}
                {detail.usage.uncertain_attempts > 0
                  ? ` · ${detail.usage.uncertain_attempts} 次请求未获完整回执`
                  : ""}
              </p>
            )}
            <details className="my-5">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                执行记录（{events.length}）
              </summary>
              <ol className="my-6 space-y-4" aria-live="polite">
                {events.map((event) => (
                  <li key={event.seq} className="flex gap-4 text-sm">
                    <span className="w-5 shrink-0 text-muted-foreground">
                      {event.seq}
                    </span>
                    <div>
                      <span className="font-medium">{event.type}</span>
                      <p className="mt-1 break-words text-muted-foreground">
                        {String(
                          event.payload.message ??
                            event.payload.summary ??
                            event.payload.text ??
                            event.payload.goal ??
                            event.payload.error ??
                            ""
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </details>
            {detail.error && (
              <p role="alert" className="text-sm text-destructive">
                {detail.error}
              </p>
            )}
            {detail.artifacts.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between gap-3 border-t border-border py-4"
              >
                <div>
                  <a
                    className="text-sm font-medium break-all underline underline-offset-4"
                    href={`/api/artifacts/${file.id}`}
                  >
                    {file.name}
                  </a>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {file.size} bytes ·{" "}
                    {file.verification.grade === "program_checked"
                      ? "程序检查通过；来源真实性仍需核实"
                      : file.verification.grade === "file_copied"
                        ? "文件已提取，业务内容未核实"
                        : file.verification.grade}
                  </p>
                </div>
                <a className="text-sm underline" href={`/api/artifacts/${file.id}`}>
                  下载
                </a>
              </div>
            ))}
          </section>
        )}
      </section>
    </main>
  )
}
