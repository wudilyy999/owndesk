"use client"
// Companion page: chat, the companion's own days, notes it keeps about you, and settings.
// Chat-bubble and "life feed" ideas follow common companion apps (SillyTavern, AIRI); no code taken.
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Room } from "@/components/companion-room"
import { Channels } from "@/components/companion-channels"
import { cn } from "@/lib/utils"
import type { Companion as CompanionRow, CompanionMessage } from "@/db/schema"
import type { TypingPace } from "@/lib/companion/pacing"

type View = CompanionRow & { name: string }
type Note = {
  id: string
  content: string
  source: string
  status: "active" | "candidate"
  createdAt: string
}
const tabs = [
  ["chat", "聊天"],
  ["life", "房间"],
  ["memory", "记忆"],
  ["channels", "聊天软件"],
  ["settings", "设置"],
] as const
type Tab = (typeof tabs)[number][0]

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })
const when = (value: string | Date, zone: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: zone,
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
const safeUrl = (value: string | null) =>
  value && /^https?:\/\//.test(value) ? value : null

export function Companion() {
  const [tab, setTab] = useState<Tab>("chat")
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    try {
      setView(await api<View>("/api/companion"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-4 py-4">
      <header className="flex items-center justify-between pb-3">
        <div>
          <h1 className="text-lg font-medium">{view?.name ?? "…"}</h1>
          <Link href="/" className="text-xs text-faint underline underline-offset-4">
            返回工作现场
          </Link>
        </div>
        <nav className="flex gap-1">
          {tabs.map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={tab === id ? "secondary" : "ghost"}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
      </header>
      {error && <p className="pb-2 text-sm text-destructive">{error}</p>}
      {view && tab === "chat" && <Chat zone={view.timeZone} pace={view.typingPace} />}
      {view && tab === "life" && <Room agentId={view.agentId} zone={view.timeZone} />}
      {view && tab === "memory" && <Notes zone={view.timeZone} />}
      {view && tab === "channels" && <Channels />}
      {view && tab === "settings" && <SettingsForm view={view} onSaved={setView} />}
    </main>
  )
}

// Copy that also works on plain http (clipboard API needs a secure context)
async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    const area = document.createElement("textarea")
    area.value = value
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    if (!ok) throw new Error("复制失败")
  }
}

function Bubble({
  message,
  zone,
  onAnswer,
  onMemory,
  actions,
}: {
  message: CompanionMessage
  zone: string
  onAnswer: (id: string, action: "confirm" | "cancel") => void
  onMemory: (memoryId: string, action: "accept" | "dismiss") => void
  actions?: React.ReactNode
}) {
  const mine = message.role === "user"
  const meta = (message.metadata ?? {}) as {
    goal?: string
    status?: string
    memoryId?: string
    activityId?: string
    hasImage?: boolean
  }
  return (
    <div
      className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}
      data-message-id={message.id}
      data-role={message.role}
    >
      <div
        title={when(message.createdAt, zone)}
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
          mine ? "bg-primary text-primary-foreground" : "bg-elevated"
        )}
      >
        {message.kind === "errand_proposal" ? (
          <div className="space-y-2">
            <p className="text-xs text-faint">要我去电脑上办这件事吗？</p>
            <p>{meta.goal}</p>
            {meta.status === "pending" ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onAnswer(message.id, "confirm")}>
                  确认，去办
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onAnswer(message.id, "cancel")}
                >
                  不用了
                </Button>
              </div>
            ) : (
              <p className="text-xs text-faint">
                {meta.status === "cancelled" ? "已取消" : "已确认"}
              </p>
            )}
          </div>
        ) : message.kind === "memory_candidate" ? (
          <div className="space-y-2">
            <p className="text-xs text-faint">我想把这件事记下来，可以吗？</p>
            <p>{message.content}</p>
            {meta.status === "pending" ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onMemory(meta.memoryId!, "accept")}>
                  记住
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onMemory(meta.memoryId!, "dismiss")}
                >
                  不用记
                </Button>
              </div>
            ) : (
              <p className="text-xs text-faint">
                {meta.status === "accepted" ? "已记住" : "没有记"}
              </p>
            )}
          </div>
        ) : (
          <>
            {message.content}
            {meta.hasImage && meta.activityId && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/companion/images/${meta.activityId}`}
                alt="页面截图"
                loading="lazy"
                className="mt-2 max-h-60 rounded-lg border border-border"
              />
            )}
          </>
        )}
      </div>
      {actions}
    </div>
  )
}

const actionButton =
  "rounded px-1.5 py-0.5 text-xs text-faint hover:bg-elevated hover:text-foreground disabled:opacity-50"

function Chat({ zone, pace }: { zone: string; pace: TypingPace }) {
  const [messages, setMessages] = useState<CompanionMessage[]>([])
  const [text, setText] = useState(""),
    [streaming, setStreaming] = useState(""),
    [typing, setTyping] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<{ id: string; text: string } | null>(null),
    [copied, setCopied] = useState("")
  const bottom = useRef<HTMLDivElement>(null)
  const refresh = useCallback(async () => {
    try {
      setMessages(await api<CompanionMessage[]>("/api/companion/messages"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    void refresh()
    // Shares and errand results arrive from the worker while this page is open
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, 15000)
    return () => clearInterval(timer)
  }, [refresh])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [messages, streaming, typing])

  // One request: a new message, or a redo of the latest turn. Events come as bubbles are "typed".
  async function run(body: unknown) {
    setBusy(true)
    setError("")
    setTyping(true)
    try {
      const response = await fetch("/api/companion/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body)
        throw new Error((await response.json()).error ?? "发送失败")
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        buffer += chunk
        const events = buffer.split("\n\n")
        buffer = events.pop()!
        for (const raw of events) {
          const name = /^event: (.*)$/m.exec(raw)![1]
          const data = JSON.parse(/^data: (.*)$/m.exec(raw)![1])
          if (name === "user") setMessages((old) => [...old, data.message])
          else if (name === "superseded")
            setMessages((old) => old.filter((row) => !data.ids.includes(row.id)))
          else if (name === "typing") setTyping(data.on)
          // With "off" the text streams in as before; otherwise she is "typing" until a bubble lands
          else if (name === "delta") {
            if (pace === "off") setStreaming((old) => old + data.text)
          } else if (name === "messages") {
            setStreaming("")
            setTyping(false)
            setMessages((old) => [...old, ...data.messages])
          } else if (name === "error") throw new Error(data.error)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      // A failed redo puts the old answer back; the server has already restored it
      await refresh()
    } finally {
      setStreaming("")
      setTyping(false)
      setBusy(false)
    }
  }

  async function submit() {
    const value = text.trim()
    if (!value || busy) return
    setText("")
    await run({ text: value })
  }

  async function copy(message: CompanionMessage) {
    try {
      await copyText(message.content)
      setCopied(message.id)
      setTimeout(() => setCopied((id) => (id === message.id ? "" : id)), 1500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function remember(memoryId: string, action: "accept" | "dismiss") {
    try {
      await api(`/api/companion/memories/${memoryId}/review`, send("POST", { action }))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function answer(id: string, action: "confirm" | "cancel") {
    try {
      await api(`/api/companion/errands/${id}`, send("POST", { action }))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Same rule as the server: only the latest web turn can be redone
  const lastUser = messages.findLastIndex((row) => row.role === "user")
  const round = lastUser === -1 ? [] : messages.slice(lastUser + 1)
  const userRow = lastUser === -1 ? null : messages[lastUser]
  const redone = Number((userRow?.metadata as { redo?: number } | null)?.redo ?? 0)
  const redoable =
    !busy &&
    !!userRow &&
    userRow.kind === "chat" &&
    userRow.channel === "web" &&
    round.every(
      (row) =>
        row.channel === "web" &&
        (row.kind === "chat" ||
          ((row.kind === "memory_candidate" || row.kind === "errand_proposal") &&
            (row.metadata as { status?: string } | null)?.status === "pending"))
    )
  const lastReply = redoable && round.length ? round[round.length - 1] : null

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-border bg-surface p-4"
        data-testid="chat-log"
      >
        {messages.length === 0 && !busy && (
          <p className="text-center text-sm text-faint">说点什么吧</p>
        )}
        {messages.map((message) => {
          const plain = message.kind === "chat"
          const mine = message.role === "user"
          const isEditing = editing?.id === message.id
          return isEditing ? (
            <div key={message.id} className="flex flex-col items-end gap-1">
              <Textarea
                aria-label="编辑消息"
                rows={2}
                value={editing.text}
                maxLength={4000}
                onChange={(event) =>
                  setEditing({ id: message.id, text: event.target.value })
                }
                className="max-w-[80%]"
              />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  disabled={!editing.text.trim() || busy}
                  onClick={() => {
                    const value = editing.text.trim()
                    setEditing(null)
                    void run({ redo: "edit", text: value })
                  }}
                >
                  保存并重发
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <Bubble
              key={message.id}
              message={message}
              zone={zone}
              onAnswer={answer}
              onMemory={remember}
              actions={
                plain ? (
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      className={actionButton}
                      onClick={() => void copy(message)}
                    >
                      {copied === message.id ? "已复制" : "复制"}
                    </button>
                    {mine && redoable && message.id === userRow?.id && (
                      <button
                        type="button"
                        className={actionButton}
                        onClick={() =>
                          setEditing({ id: message.id, text: message.content })
                        }
                      >
                        编辑
                      </button>
                    )}
                    {!mine && lastReply?.id === message.id && redone < 3 && (
                      <button
                        type="button"
                        className={actionButton}
                        onClick={() => void run({ redo: "regenerate" })}
                      >
                        重说
                      </button>
                    )}
                  </div>
                ) : lastReply?.id === message.id && redone < 3 ? (
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      className={actionButton}
                      onClick={() => void run({ redo: "regenerate" })}
                    >
                      重说
                    </button>
                  </div>
                ) : undefined
              }
            />
          )
        })}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl bg-elevated px-3 py-2 text-sm whitespace-pre-wrap">
              {streaming}
            </div>
          </div>
        )}
        {typing && !streaming && (
          <div className="flex justify-start" data-testid="typing-indicator">
            <div
              role="status"
              aria-label="正在输入"
              className="flex items-center gap-1 rounded-2xl bg-elevated px-3 py-3"
            >
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1.5 animate-bounce rounded-full bg-faint"
                  style={{ animationDelay: `${dot * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="发消息"
          disabled={busy}
          maxLength={4000}
        />
        <Button type="submit" disabled={busy || !text.trim()}>
          发送
        </Button>
      </form>
    </section>
  )
}

function Notes({ zone }: { zone: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [draft, setDraft] = useState(""),
    [editing, setEditing] = useState<{ id: string; content: string } | null>(null),
    [error, setError] = useState("")
  const run = async <T,>(task: () => Promise<T>) => {
    setError("")
    try {
      return await task()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const load = useCallback(
    () => run(async () => setNotes(await api<Note[]>("/api/companion/memories"))),
    []
  )
  useEffect(() => {
    void load()
  }, [load])
  return (
    <section className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <p className="text-xs text-faint">
        这些是她记住的关于你的事，会在聊天时用到。你可以随时改或删；删掉就是真的删除。
        之前的聊天记录里说过的话不会因此消失。
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await api("/api/companion/memories", send("POST", { content: draft }))
            setDraft("")
            await load()
          })
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="让她记住一件事"
          maxLength={500}
        />
        <Button type="submit" disabled={!draft.trim()}>
          添加
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notes?.some((note) => note.status === "candidate") && (
        <h2 className="pt-1 text-xs font-medium text-faint">
          等你确认（确认前她不会用）
        </h2>
      )}
      {notes
        ?.filter((note) => note.status === "candidate")
        .map((note) => (
          <article
            key={note.id}
            className="flex items-start justify-between gap-2 rounded-xl border border-dashed border-border bg-surface p-3 text-sm"
          >
            <p>{note.content}</p>
            <div className="flex shrink-0 gap-1">
              {(["accept", "dismiss"] as const).map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === "accept" ? "secondary" : "ghost"}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/api/companion/memories/${note.id}/review`,
                        send("POST", { action })
                      )
                      await load()
                    })
                  }
                >
                  {action === "accept" ? "记住" : "不用记"}
                </Button>
              ))}
            </div>
          </article>
        ))}
      {notes
        ?.filter((note) => note.status === "active")
        .map((note) => (
          <article
            key={note.id}
            className="flex items-start justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-sm"
          >
            {editing?.id === note.id ? (
              <Input
                value={editing.content}
                onChange={(event) =>
                  setEditing({ id: note.id, content: event.target.value })
                }
                maxLength={500}
              />
            ) : (
              <div>
                <p>{note.content}</p>
                <p className="text-xs text-faint">
                  {note.source === "agent" ? "她记的" : "你加的"} ·{" "}
                  {when(note.createdAt, zone)}
                </p>
              </div>
            )}
            <div className="flex shrink-0 gap-1">
              {editing?.id === note.id ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/api/companion/memories/${note.id}`,
                        send("PATCH", { content: editing.content })
                      )
                      setEditing(null)
                      await load()
                    })
                  }
                >
                  保存
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing({ id: note.id, content: note.content })}
                >
                  编辑
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    await api(`/api/companion/memories/${note.id}`, { method: "DELETE" })
                    await load()
                  })
                }
              >
                删除
              </Button>
            </div>
          </article>
        ))}
      {notes?.length === 0 && <p className="text-sm text-faint">还没有记下什么。</p>}
    </section>
  )
}

const field = "space-y-1 text-sm"

type Rhythm = CompanionRow["rhythm"]
type Block = Rhythm["sleep"]

function BlockRow({
  block,
  onChange,
  onRemove,
  labeled,
}: {
  block: Block
  onChange: (block: Block) => void
  onRemove?: () => void
  labeled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="time"
        className="w-28"
        value={block.start}
        onChange={(event) => onChange({ ...block, start: event.target.value })}
      />
      <span className="text-xs text-faint">到</span>
      <Input
        type="time"
        className="w-28"
        value={block.end}
        onChange={(event) => onChange({ ...block, end: event.target.value })}
      />
      {labeled && (
        <Input
          className="w-32"
          placeholder="在做什么"
          maxLength={40}
          value={block.label ?? ""}
          onChange={(event) => onChange({ ...block, label: event.target.value })}
        />
      )}
      {onRemove && (
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          删除
        </Button>
      )}
    </div>
  )
}

// While she sleeps, naps or is away she still answers you, but does not browse or message first
function RhythmFields({
  rhythm,
  onChange,
}: {
  rhythm: Rhythm
  onChange: (rhythm: Rhythm) => void
}) {
  return (
    <fieldset className="space-y-2 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm">她的作息（按她的时区）</legend>
      <p className="text-xs text-faint">
        睡觉、午休和外出时，她仍会回复你，但回得短、带着状态；不会自己上网，也不会主动发消息。
      </p>
      <p className="text-xs">睡觉</p>
      <BlockRow
        block={rhythm.sleep}
        onChange={(sleep) => onChange({ ...rhythm, sleep })}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rhythm.nap !== null}
          onChange={(event) =>
            onChange({
              ...rhythm,
              nap: event.target.checked ? { start: "13:00", end: "14:00" } : null,
            })
          }
        />
        午休
      </label>
      {rhythm.nap && (
        <BlockRow block={rhythm.nap} onChange={(nap) => onChange({ ...rhythm, nap })} />
      )}
      <p className="text-xs">外出（上班、通勤等，最多 6 段）</p>
      {rhythm.away.map((block, index) => (
        <BlockRow
          key={index}
          labeled
          block={block}
          onChange={(next) =>
            onChange({
              ...rhythm,
              away: rhythm.away.map((old, i) => (i === index ? next : old)),
            })
          }
          onRemove={() =>
            onChange({ ...rhythm, away: rhythm.away.filter((_, i) => i !== index) })
          }
        />
      ))}
      {rhythm.away.length < 6 && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            onChange({
              ...rhythm,
              away: [...rhythm.away, { start: "09:00", end: "12:00", label: "上班" }],
            })
          }
        >
          添加外出时段
        </Button>
      )}
    </fieldset>
  )
}
const personaFields = [
  ["personality", "性格"],
  ["speakingStyle", "说话方式"],
  ["background", "背景"],
  ["interests", "兴趣"],
  ["callsYou", "怎么称呼你"],
] as const

function SettingsForm({ view, onSaved }: { view: View; onSaved: (view: View) => void }) {
  const [form, setForm] = useState(view)
  const [adult, setAdult] = useState(false),
    [times, setTimes] = useState(view.lifeTimes.join(", ")),
    [message, setMessage] = useState(""),
    [error, setError] = useState("")
  const set = <K extends keyof View>(key: K, value: View[K]) =>
    setForm((old) => ({ ...old, [key]: value }))
  async function save() {
    setMessage("")
    setError("")
    try {
      const lifeTimes = times
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map((time) => time.padStart(5, "0"))
      const saved = await api<CompanionRow>(
        "/api/companion",
        send("PATCH", {
          name: form.name,
          persona: form.persona,
          mode: form.mode,
          ...(adult ? { adultConfirmed: true } : {}),
          timeZone: form.timeZone,
          sharesPaused: form.sharesPaused,
          maxSharesPerDay: form.maxSharesPerDay,
          quietStart: form.quietStart,
          quietEnd: form.quietEnd,
          rhythm: form.rhythm,
          typingPace: form.typingPace,
          lifeEnabled: form.lifeEnabled,
          lifeTimes,
          lifeDailyBudgetMicros: form.lifeDailyBudgetMicros,
          lifeSessionMaxSteps: form.lifeSessionMaxSteps,
        })
      )
      onSaved({ ...saved, name: form.name })
      setMessage("已保存")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <section className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6">
      <label className={field}>
        名字
        <Input
          value={form.name}
          maxLength={40}
          onChange={(event) => set("name", event.target.value)}
        />
      </label>
      {personaFields.map(([key, label]) => (
        <label key={key} className={field}>
          {label}
          <Textarea
            rows={key === "callsYou" ? 1 : 2}
            value={form.persona[key]}
            onChange={(event) =>
              set("persona", { ...form.persona, [key]: event.target.value })
            }
          />
        </label>
      ))}
      <fieldset className={field}>
        <legend>关系</legend>
        <div className="flex gap-2">
          {(["friend", "partner"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={form.mode === mode ? "secondary" : "ghost"}
              onClick={() => set("mode", mode)}
            >
              {mode === "friend" ? "朋友" : "恋人"}
            </Button>
          ))}
        </div>
        {form.mode === "partner" && !view.adultConfirmedAt && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={adult}
              onChange={(event) => setAdult(event.target.checked)}
            />
            我确认自己已年满 18 岁
          </label>
        )}
      </fieldset>
      <label className={field}>
        时区
        <Input
          value={form.timeZone}
          onChange={(event) => set("timeZone", event.target.value)}
        />
      </label>
      <label className={field}>
        打字节奏
        <select
          aria-label="打字节奏"
          value={form.typingPace}
          onChange={(event) => set("typingPace", event.target.value as TypingPace)}
          className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
        >
          <option value="natural">自然（像真人一样一条一条发）</option>
          <option value="fast">快（间隔短一些）</option>
          <option value="off">关闭（一次全部显示）</option>
        </select>
      </label>
      <RhythmFields rhythm={form.rhythm} onChange={(rhythm) => set("rhythm", rhythm)} />
      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm">她自己的生活</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.lifeEnabled}
            onChange={(event) => set("lifeEnabled", event.target.checked)}
          />
          允许她每天自己上网、读东西、写日记（会用到模型额度）
        </label>
        <label className={field}>
          每天几点开始（最多 4 个，逗号分隔，如 10:30, 20:30）
          <Input value={times} onChange={(event) => setTimes(event.target.value)} />
        </label>
        <label className={field}>
          每天费用上限（美元，最高 5）
          <Input
            type="number"
            min={0}
            max={5}
            step={0.05}
            value={form.lifeDailyBudgetMicros / 1e6}
            onChange={(event) =>
              set("lifeDailyBudgetMicros", Math.round(Number(event.target.value) * 1e6))
            }
          />
        </label>
        <label className={field}>
          每次最多步数（5–60）
          <Input
            type="number"
            min={5}
            max={60}
            value={form.lifeSessionMaxSteps}
            onChange={(event) => set("lifeSessionMaxSteps", Number(event.target.value))}
          />
        </label>
        <p className="text-xs text-faint">
          模型要先在“用量与预算”里设好价格，否则不会开始。
        </p>
      </fieldset>
      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm">主动分享</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.sharesPaused}
            onChange={(event) => set("sharesPaused", event.target.checked)}
          />
          暂停分享
        </label>
        <label className={field}>
          每天最多几条（0–5）
          <Input
            type="number"
            min={0}
            max={5}
            value={form.maxSharesPerDay}
            onChange={(event) => set("maxSharesPerDay", Number(event.target.value))}
          />
        </label>
        <div className="flex gap-2">
          <label className={field}>
            免打扰开始
            <Input
              value={form.quietStart}
              onChange={(event) => set("quietStart", event.target.value)}
            />
          </label>
          <label className={field}>
            免打扰结束
            <Input
              value={form.quietEnd}
              onChange={(event) => set("quietEnd", event.target.value)}
            />
          </label>
        </div>
      </fieldset>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-ok">{message}</p>}
      <Button onClick={() => void save()}>保存</Button>
    </section>
  )
}
