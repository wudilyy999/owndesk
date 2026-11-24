"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  trialViewport,
  type TrialCommand,
  type TrialFrame,
} from "@/lib/evolution/trial-input"

type Event = Extract<TrialCommand, { action: "input" }>["event"]
export function CandidateTrial({
  objectiveId,
  versionId,
}: {
  objectiveId: string
  versionId: string
}) {
  const [frame, setFrame] = useState<TrialFrame | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [path, setPath] = useState("/")
  const flight = useRef(false),
    live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const send = useCallback(
    async (command: TrialCommand) => {
      if (flight.current) return
      flight.current = true
      setBusy(true)
      setError("")
      try {
        const res = await fetch(`/api/improvements/${objectiveId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "trial", command }),
          cache: "no-store",
        })
        const data = await res.json()
        if (!res.ok) {
          if (live.current && (res.status === 410 || res.status === 503)) setFrame(null)
          throw new Error(data.error || "试用请求失败")
        }
        if (live.current) setFrame(data.state === "closed" ? null : data)
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : "试用请求失败")
      } finally {
        flight.current = false
        if (live.current) setBusy(false)
      }
    },
    [objectiveId]
  )
  const awaitingFrame = !!frame && !frame.image
  const session = frame?.session
  useEffect(() => {
    if (!session || !awaitingFrame) return
    const id = setInterval(() => {
      void send({ action: "view", session, versionId })
    }, 1000)
    return () => clearInterval(id)
  }, [session, awaitingFrame, versionId, send])
  const input = (event: Event) => {
    if (session) void send({ action: "input", session, versionId, event })
  }
  return (
    <section className="w-full space-y-2" aria-label="候选试用">
      {!frame ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void send({ action: "open", versionId })}
        >
          试用这个版本
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <strong>候选试用</strong>
            <span className="text-muted-foreground">合成数据 · 不调用付费模型</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void send({ action: "close", session: frame.session, versionId })
              }
            >
              关闭试用
            </Button>
          </div>
          {frame.image ? (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  input({ type: "navigate", path })
                }}
              >
                <input
                  className="grow rounded border px-2"
                  aria-label="候选页面路径"
                  value={path}
                  maxLength={500}
                  onChange={(e) => setPath(e.target.value)}
                />
                <Button type="submit" size="sm" disabled={busy || !path.startsWith("/")}>
                  打开页面
                </Button>
              </form>
              <button
                type="button"
                aria-label="候选网页，点击页面或使用键盘"
                className="block w-full max-w-[1080px] overflow-hidden rounded border text-left"
                onClick={(e) => {
                  if (!e.detail) return
                  const b = e.currentTarget.getBoundingClientRect()
                  const coord = (
                    value: number,
                    start: number,
                    length: number,
                    size: number
                  ) =>
                    Math.min(
                      size - 1,
                      Math.max(0, Math.floor(((value - start) * size) / length))
                    )
                  input({
                    type: "click",
                    x: coord(e.clientX, b.left, b.width, trialViewport.width),
                    y: coord(e.clientY, b.top, b.height, trialViewport.height),
                  })
                }}
                onKeyDown={(e) => {
                  if (e.ctrlKey || e.altKey || e.metaKey) return
                  const key =
                    e.key === "Tab" && e.shiftKey
                      ? "Shift+Tab"
                      : e.key === " "
                        ? "Space"
                        : e.key
                  if (
                    [
                      "Enter",
                      "Escape",
                      "Backspace",
                      "Delete",
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                      "Space",
                    ].includes(key)
                  ) {
                    e.preventDefault()
                    input({
                      type: "key",
                      key: key as Extract<Event, { type: "key" }>["key"],
                    })
                  }
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a private, in-memory browser frame */}
                <img
                  src={`data:image/jpeg;base64,${frame.image}`}
                  alt={frame.title || "候选网页"}
                  width={trialViewport.width}
                  height={trialViewport.height}
                  draggable={false}
                  className="block w-full"
                />
              </button>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (text) {
                    input({ type: "text", text })
                    setText("")
                  }
                }}
              >
                <input
                  aria-label="输入到选中的候选控件"
                  placeholder="先点页面中的输入框，再在这里输入"
                  maxLength={2000}
                  className="grow rounded border px-2 py-1"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button type="submit" size="sm" disabled={busy || !text}>
                  输入
                </Button>
              </form>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["上一屏", { type: "scroll", y: -600 }],
                    ["下一屏", { type: "scroll", y: 600 }],
                    ["下个控件", { type: "key", key: "Tab" }],
                    ["回车", { type: "key", key: "Enter" }],
                  ] as const
                ).map(([label, event]) => (
                  <Button
                    key={label}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => input(event)}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void send({ action: "view", session: frame.session, versionId })
                  }
                >
                  查看当前画面
                </Button>
              </div>
            </>
          ) : (
            <p role="status">正在打开候选网页…</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
