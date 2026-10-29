"use client"

// Note-list layout and add/forget interaction adapted from the pinned MIT upstream's MemoryPanel.
import { useEffect, useState } from "react"
import { formatDistanceToNowStrict } from "date-fns"
import { PlusIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

type Note = { id: string; content: string; createdAt: string }
export function MemoryPanel({ agentId }: { agentId: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [draft, setDraft] = useState(""),
    [saving, setSaving] = useState(false)
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}/memory`, {
          cache: "no-store",
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        if (live) setNotes(result)
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      live = false
    }
  }, [agentId, refresh])
  async function mutate(
    method: "POST" | "DELETE",
    body: { content: string } | { id: string }
  ) {
    setSaving(true)
    setError("")
    try {
      const response = await fetch(`/api/agents/${agentId}/memory`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      if (method === "POST") {
        setNotes((previous) => [result, ...previous!])
        setDraft("")
      } else setNotes((previous) => previous!.filter((note) => note.id !== result.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section
      className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
      aria-labelledby="memory-heading"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="memory-heading" className="text-lg font-medium">
          长期记忆
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            setError("")
            setNotes(null)
            setRefresh((previous) => previous + 1)
          }}
        >
          刷新记忆
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        此 Agent 的偏好和长期规则。新任务最多读取最近 30 条、共 12,000
        字符，并随任务发送给所选模型服务。请勿保存密码、密钥和验证码。删除影响未来任务，已受理任务保留审计快照。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void mutate("POST", { content: draft.trim() })
        }}
      >
        <input
          aria-label="新增记忆"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：周报默认使用三条中文要点"
          maxLength={2000}
          className="min-w-0 flex-1 rounded border border-input px-3 py-2 text-sm focus-visible:outline-ring"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!draft.trim() || saving || notes === null}
          aria-label="保存记忆"
        >
          <PlusIcon />
          保存
        </Button>
      </form>
      {notes === null ? (
        <p className="text-xs text-muted-foreground">正在读取记忆…</p>
      ) : !notes.length ? (
        <p className="text-xs text-muted-foreground">
          还没有记忆。可以在此添加，也可以让 Agent 记住你的偏好。
        </p>
      ) : (
        <ul className="divide-y">
          {notes.map((note) => (
            <li key={note.id} className="flex gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm break-words whitespace-pre-wrap">{note.content}</p>
                <p className="mt-1 text-[10px] break-all text-muted-foreground">
                  {note.id} ·{" "}
                  {formatDistanceToNowStrict(new Date(note.createdAt), {
                    addSuffix: true,
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                aria-label={`忘记：${note.content}`}
                onClick={() => mutate("DELETE", { id: note.id })}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
