"use client"

// User/reply layout and grouped tool presentation adapted from the pinned MIT upstream's transcript.
import { useEffect, useState } from "react"
import { useStickToBottom } from "use-stick-to-bottom"
import { Markdown } from "@/components/thread/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ThreadPage, ThreadTurn } from "@/lib/threads"

const statuses: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_user: "等待你处理",
  needs_review: "待复核",
  verifying: "核对中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
}
export function Transcript({
  threadId,
  selectedTaskId,
  refreshKey,
  agentName,
  onSelectTask,
  onRename,
}: {
  threadId: string
  selectedTaskId: string
  refreshKey: string
  agentName: string
  onSelectTask: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [turns, setTurns] = useState<ThreadTurn[]>([]),
    [title, setTitle] = useState("")
  const [draftTitle, setDraftTitle] = useState("")
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [renaming, setRenaming] = useState(false)
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } =
    useStickToBottom({ resize: "smooth", initial: "instant" })
  function merge(page: ThreadPage) {
    setTitle(page.title)
    setTurns((previous) =>
      [
        ...new Map([...previous, ...page.turns].map((turn) => [turn.id, turn])).values(),
      ].sort((a, b) => a.threadTurn - b.threadTurn)
    )
  }
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`/api/threads/${threadId}`, {
          signal: controller.signal,
          cache: "no-store",
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        if (!controller.signal.aborted) {
          merge(result)
          setError("")
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => controller.abort()
  }, [threadId, refreshKey])
  return (
    <section
      aria-label="对话记录"
      className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-xs sm:p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
        <h3 className="min-w-0 text-lg font-medium break-words">
          {title || "正在读取对话…"}
        </h3>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => {
              setDraftTitle(title)
              setRenaming((value) => !value)
            }}
          >
            重命名对话
          </button>
          <a
            href={`/api/threads/${threadId}/export`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            导出对话
          </a>
        </div>
      </header>
      {renaming && (
        <form
          className="flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError("")
            try {
              const response = await fetch(`/api/threads/${threadId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: draftTitle }),
              })
              const result = await response.json()
              if (!response.ok) throw new Error(result.error)
              setTitle(result.title)
              onRename(threadId, result.title)
              setRenaming(false)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Input
            aria-label="对话名称"
            maxLength={80}
            required
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            保存名称
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {turns[0]?.threadTurn > 1 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError("")
            stopScroll()
            try {
              const response = await fetch(
                `/api/threads/${threadId}?before=${turns[0].threadTurn}`,
                { cache: "no-store" }
              )
              const result = await response.json()
              if (!response.ok) throw new Error(result.error)
              merge(result)
              requestAnimationFrame(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = 0
              })
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
              setBusy(false)
            }
          }}
        >
          加载更早的对话
        </Button>
      )}
      <div
        ref={scrollRef}
        className="max-h-[62vh] overflow-y-auto overscroll-contain pr-1.5"
        aria-label="消息列表"
      >
        <div ref={contentRef} className="space-y-7">
          {turns.map((turn) => (
            <article
              key={turn.id}
              aria-label={`第 ${turn.threadTurn} 轮对话`}
              className="space-y-4"
            >
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-br-sm border border-border/80 bg-elevated px-4 py-2.5 text-[14.5px] leading-relaxed break-words whitespace-pre-wrap shadow-2xs">
                  {turn.goal}
                  {turn.attachments?.map((file) => (
                    <a
                      key={file.id}
                      href={`/api/uploads/${file.id}`}
                      className="block text-xs underline"
                    >
                      {file.name}
                    </a>
                  ))}
                </div>
              </div>
              {(turn.supplements ?? []).map((supplement) => (
                <div key={supplement.seq} className="flex justify-end">
                  <div className="max-w-[88%] rounded-2xl border border-border bg-elevated px-4 py-2 text-sm whitespace-pre-wrap">
                    <span className="mb-1 block text-xs text-muted-foreground">
                      补充指令
                    </span>
                    {supplement.text}
                    {supplement.attachments?.map((file) => (
                      <a
                        key={file.id}
                        href={`/api/uploads/${file.id}`}
                        className="block text-xs underline"
                      >
                        {file.name}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
              <div className="space-y-3 pl-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-full bg-primary/80"
                    />
                    {agentName}
                  </span>
                  <button
                    type="button"
                    className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground"
                    onClick={() => onSelectTask(turn.id)}
                    aria-current={selectedTaskId === turn.id ? "step" : undefined}
                  >
                    第 {turn.threadTurn} 轮 · {statuses[turn.status] ?? turn.status} ·
                    查看执行
                  </button>
                </div>
                {turn.tools.length > 0 && (
                  <details className="rounded-xl border border-border/70 bg-muted/45 px-3.5 py-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium">
                      工作站动作（{turn.tools.length}）
                    </summary>
                    <ol className="mt-2 space-y-1.5 border-l border-border pl-3">
                      {turn.tools.map((tool, index) => (
                        <li key={index}>
                          <code>{tool.kind}</code> ·{" "}
                          {tool.status === "succeeded" ? "已执行" : tool.status}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {(turn.interactions ?? []).map((interaction, index) => (
                  <div
                    key={index}
                    className="space-y-1 rounded-r-lg border-l-2 border-betelgeuse/55 bg-betelgeuse-soft/40 py-2 pr-3 pl-3.5 text-xs leading-5 whitespace-pre-wrap"
                  >
                    <p>{interaction.question}</p>
                    <p className="text-muted-foreground">
                      你的处理：{interaction.decision}
                      {interaction.answer ? `；${interaction.answer}` : ""}
                    </p>
                  </div>
                ))}
                {turn.reply ? (
                  <Markdown>{turn.reply}</Markdown>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {turn.status === "cancelled"
                      ? "本轮已停止，已产生的外部效果和文件仍需核对。"
                      : turn.status === "failed"
                        ? `本轮失败：${turn.error}`
                        : "Agent 正在处理这轮任务，进度和需要你的操作见执行详情。"}
                  </p>
                )}
                {turn.artifacts.length > 0 && (
                  <ul className="space-y-1.5 pt-1 text-xs">
                    {turn.artifacts.map((file) => (
                      <li
                        key={file.id}
                        className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
                      >
                        <a
                          aria-label={`历史成果：${file.name}`}
                          className="font-medium break-all text-primary underline underline-offset-4"
                          href={`/api/artifacts/${file.id}`}
                        >
                          {file.name}
                        </a>
                        <span className="ml-2 text-muted-foreground">
                          {file.verification.grade === "program_checked"
                            ? "结构/日期检查通过，来源仍需核实"
                            : "文件已提取，内容未独立核实"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          className="text-xs font-medium text-primary underline underline-offset-4"
          onClick={() => scrollToBottom()}
        >
          滚到最新消息
        </button>
      )}
      {turns.length > 0 && turns.at(-1)!.id !== selectedTaskId && (
        <button
          type="button"
          className="text-xs font-medium text-primary underline underline-offset-4"
          onClick={() => onSelectTask(turns.at(-1)!.id)}
        >
          查看最新一轮执行
        </button>
      )}
      <p className="border-t border-hairline pt-3 text-xs leading-5 text-muted-foreground">
        每轮保留独立任务和成果。追问会读取近期对话快照；过长的历史会明确标注省略，旧审批与桌面引用不会复用。
      </p>
    </section>
  )
}
