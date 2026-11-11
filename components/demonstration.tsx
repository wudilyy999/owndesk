"use client"
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  MAX_DEMONSTRATION_EVENTS,
  demonstrationEventSchema,
  type DemonstrationEvent,
} from "@/lib/demonstration-schema"
export function Demonstration({
  agentId,
  screen,
}: {
  agentId: string
  screen: RefObject<HTMLDivElement | null>
}) {
  const [name, setName] = useState(""),
    [session, setSession] = useState<{ id: string; seq: number } | null>(null),
    [paused, setPaused] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [finished, setFinished] = useState(false),
    [note, setNote] = useState("")
  const recording = useRef(session),
    privateMode = useRef(paused),
    queue = useRef(Promise.resolve()),
    failed = useRef(false),
    lastProtected = useRef(false)
  useLayoutEffect(() => {
    recording.current = session
    privateMode.current = paused
  }, [session, paused])
  async function post(body: unknown) {
    const response = await fetch("/api/demonstrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }
  useEffect(() => {
    void fetch(`/api/demonstrations?agentId=${encodeURIComponent(agentId)}`)
      .then(async (response) => {
        const rows = await response.json()
        if (!response.ok) throw new Error(rows.error)
        const active = rows.find((row: { status: string }) => row.status === "recording")
        if (active) setSession({ id: active.id, seq: active.events.length })
      })
      .catch((cause) => setError(String(cause)))
  }, [agentId])
  const enqueue = useRef<(event: DemonstrationEvent) => void>(() => {})
  useLayoutEffect(() => {
    enqueue.current = (event) => {
      const current = recording.current
      if (!current || failed.current || current.seq >= MAX_DEMONSTRATION_EVENTS) return
      if (event.kind === "protected_input" && lastProtected.current) return
      lastProtected.current = event.kind === "protected_input"
      current.seq++
      const seq = current.seq
      setSession({ ...current })
      queue.current = queue.current
        .then(async () => {
          if (failed.current) return
          await post({ action: "record", id: current.id, seq, event })
        })
        .catch((cause) => {
          failed.current = true
          setError(String(cause))
        })
    }
  })
  useEffect(() => {
    const target = screen.current
    if (!target) return
    const pointer = (event: MouseEvent) => {
      if (privateMode.current) return
      const box = target.getBoundingClientRect()
      enqueue.current({
        kind: "pointer",
        button: event.button,
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      })
    }
    const scroll = (event: WheelEvent) => {
      if (!privateMode.current)
        enqueue.current({ kind: "scroll", direction: event.deltaY < 0 ? "up" : "down" })
    }
    const key = (event: KeyboardEvent) => {
      if (privateMode.current) return
      const parsed = demonstrationEventSchema.safeParse({
        kind: "key",
        key: event.key,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      })
      enqueue.current(parsed.success ? parsed.data : { kind: "protected_input" })
    }
    target.addEventListener("mouseup", pointer, true)
    target.addEventListener("wheel", scroll, true)
    target.addEventListener("keyup", key, true)
    return () => {
      target.removeEventListener("mouseup", pointer, true)
      target.removeEventListener("wheel", scroll, true)
      target.removeEventListener("keyup", key, true)
    }
  }, [screen])
  return (
    <section aria-label="示范教学" className="space-y-2 rounded border p-2 text-xs">
      <p>示范教学 · 记录动作和应用名称，输入字符保留为保护步骤。</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {session ? (
        <>
          <p>
            {paused ? "隐私暂停中" : "正在录制"} · {session.seq} 步
          </p>
          {session.seq >= MAX_DEMONSTRATION_EVENTS && (
            <p role="status">
              已达到 {MAX_DEMONSTRATION_EVENTS}{" "}
              步上限，已停止记录新动作；请结束并生成手册，后续操作可另开示范。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!paused) enqueue.current({ kind: "protected_input" })
                setPaused(!paused)
              }}
            >
              {paused ? "恢复录制" : "隐私暂停"}
            </Button>
            <input
              aria-label="这一步的说明"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              className="min-w-0 flex-1 rounded border px-2"
            />
            <Button
              size="sm"
              disabled={!note.trim() || paused || session.seq >= MAX_DEMONSTRATION_EVENTS}
              onClick={() => {
                enqueue.current({ kind: "checkpoint", note: note.trim() })
                setNote("")
              }}
            >
              记录说明
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                recording.current = null
                await queue.current
                try {
                  await post({ action: "cancel", id: session.id })
                  setSession(null)
                } catch (cause) {
                  setError(String(cause))
                } finally {
                  setBusy(false)
                }
              }}
            >
              取消示范
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError("")
                recording.current = null
                await queue.current
                try {
                  if (failed.current) throw new Error("录制未完整保存，请取消后重新示范")
                  await post({ action: "finish", id: session.id })
                  setSession(null)
                  setFinished(true)
                } catch (cause) {
                  setError(String(cause))
                } finally {
                  setBusy(false)
                }
              }}
            >
              结束并生成手册
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="示范名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：整理月度报表"
            maxLength={100}
            className="min-w-0 flex-1 rounded border px-2"
          />
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                const result = await post({ action: "start", agentId, name })
                failed.current = false
                lastProtected.current = false
                setSession({ id: result.id, seq: 0 })
                setPaused(false)
                setFinished(false)
              } catch (cause) {
                setError(String(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            开始示范
          </Button>
        </div>
      )}
      {finished && (
        <Link href="/manuals" className="underline">
          审阅、编辑并保存示范手册
        </Link>
      )}
    </section>
  )
}
