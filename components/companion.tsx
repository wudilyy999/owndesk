"use client"
// Companion page: chat, the companion's own days, notes it keeps about you, and settings.
// Chat-bubble and "life feed" ideas follow common companion apps (SillyTavern, AIRI); no code taken.
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type {
  Companion as CompanionRow,
  CompanionMessage,
  LifeActivity,
  LifeShare,
} from "@/db/schema"

type View = CompanionRow & { name: string }
type Note = { id: string; content: string; source: string; createdAt: string }
type Life = {
  activities: LifeActivity[]
  shares: LifeShare[]
  spentTodayMicros: number
  unknownCostRequests: number
  dailyBudgetMicros: number
}
const tabs = [
  ["chat", "聊天"],
  ["life", "她的生活"],
  ["memory", "记忆"],
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
      {view && tab === "chat" && <Chat zone={view.timeZone} />}
      {view && tab === "life" && <LifeFeed zone={view.timeZone} />}
      {view && tab === "memory" && <Notes zone={view.timeZone} />}
      {view && tab === "settings" && <SettingsForm view={view} onSaved={setView} />}
    </main>
  )
}

function Bubble({
  message,
  zone,
  onAnswer,
}: {
  message: CompanionMessage
  zone: string
  onAnswer: (id: string, action: "confirm" | "cancel") => void
}) {
  const mine = message.role === "user"
  const meta = (message.metadata ?? {}) as { goal?: string; status?: string }
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
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
        ) : (
          message.content
        )}
      </div>
    </div>
  )
}

function Chat({ zone }: { zone: string }) {
  const [messages, setMessages] = useState<CompanionMessage[]>([])
  const [text, setText] = useState(""),
    [streaming, setStreaming] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
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
  }, [messages, streaming])

  async function submit() {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setError("")
    setText("")
    try {
      const response = await fetch("/api/companion/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
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
          else if (name === "delta") setStreaming((old) => old + data.text)
          else if (name === "messages") {
            setStreaming("")
            setMessages((old) => [...old, ...data.messages])
          } else if (name === "error") throw new Error(data.error)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStreaming("")
      setBusy(false)
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

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-border bg-surface p-4">
        {messages.length === 0 && !busy && (
          <p className="text-center text-sm text-faint">说点什么吧</p>
        )}
        {messages.map((message) => (
          <Bubble key={message.id} message={message} zone={zone} onAnswer={answer} />
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl bg-elevated px-3 py-2 text-sm whitespace-pre-wrap">
              {streaming}
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

const kindLabels: Record<string, string> = {
  read: "读到",
  watch: "看了",
  diary: "日记",
  save: "收藏",
  other: "其他",
}
const shareLabels: Record<string, string> = {
  pending: "待分享",
  sent: "已发给你",
  skipped: "没有发",
}

function LifeFeed({ zone }: { zone: string }) {
  const [life, setLife] = useState<Life | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    api<Life>("/api/companion/life").then(setLife, (cause) => setError(String(cause)))
  }, [])
  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!life) return null
  const shares = new Map(life.shares.map((share) => [share.activityId, share]))
  return (
    <section className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <p className="text-xs text-faint">
        今天已用 ${(life.spentTodayMicros / 1e6).toFixed(4)} / 上限 $
        {(life.dailyBudgetMicros / 1e6).toFixed(2)}
        {life.unknownCostRequests > 0 &&
          `；有 ${life.unknownCostRequests} 次调用没有价格，费用未计入（先在“用量与预算”里给模型设价格）`}
      </p>
      {life.activities.length === 0 && (
        <p className="text-sm text-faint">
          她还没有记录过自己的生活。在设置里打开“自己的生活”。
        </p>
      )}
      {life.activities.map((activity) => {
        const share = shares.get(activity.id)
        const url = safeUrl(activity.url)
        return (
          <article
            key={activity.id}
            className="space-y-1 rounded-xl border border-border bg-surface p-3 text-sm"
          >
            <div className="flex justify-between text-xs text-faint">
              <span>{kindLabels[activity.kind]}</span>
              <span>{when(activity.createdAt, zone)}</span>
            </div>
            <p className="font-medium">{activity.title}</p>
            <p className="whitespace-pre-wrap text-muted-foreground">
              {activity.summary}
            </p>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="block text-xs break-all underline underline-offset-4"
              >
                {url}
              </a>
            )}
            {share && (
              <p className="text-xs text-faint">
                {shareLabels[share.status]}
                {share.skipReason ? `（${share.skipReason}）` : ""}：{share.text}
              </p>
            )}
          </article>
        )
      })}
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
      {notes?.map((note) => (
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
