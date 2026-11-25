"use client"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult:
    | ((event: {
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
        resultIndex: number
      }) => void)
    | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
function engine() {
  const host = window as Window & {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  return host.SpeechRecognition ?? host.webkitSpeechRecognition
}
const subscribe = () => () => {}
export function Dictation({
  disabled,
  onText,
}: {
  disabled: boolean
  onText: (value: string) => void
}) {
  const supported = useSyncExternalStore(
    subscribe,
    () => !!engine(),
    () => false
  )
  const [state, setState] = useState<"idle" | "recording">("idle"),
    [error, setError] = useState("")
  const session = useRef<Recognition | null>(null)
  useEffect(() => {
    return () => {
      const s = session.current
      if (s) {
        s.onresult = null
        s.onerror = null
        s.onend = null
        s.abort()
        session.current = null
      }
    }
  }, [])
  useEffect(() => {
    if (disabled) session.current?.abort()
  }, [disabled])
  if (!supported) return null
  function toggle() {
    if (session.current) {
      session.current.stop()
      return
    }
    const Ctor = engine()
    if (!Ctor) return
    const s = new Ctor()
    session.current = s
    s.lang = document.documentElement.lang || navigator.language || "zh-CN"
    s.continuous = false
    s.interimResults = false
    s.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal && r[0].transcript) onText(r[0].transcript)
      }
    }
    s.onend = () => {
      session.current = null
      setState("idle")
    }
    s.onerror = (e) => {
      setError(
        e.error === "not-allowed"
          ? "浏览器未允许使用麦克风"
          : e.error === "no-speech"
            ? "没有听到语音，可再试一次"
            : "听写未完成，请重试或键入文字"
      )
    }
    setError("")
    try {
      setState("recording")
      s.start()
    } catch {
      session.current = null
      setState("idle")
      setError("麦克风未能启动")
    }
  }
  return (
    <div>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={toggle}
        aria-pressed={state === "recording"}
        title="使用浏览器的语音服务转为草稿，确认后再发送"
      >
        {state === "recording" ? "结束听写" : "听写"}
      </Button>
      {error && <small role="status">{error}</small>}
    </div>
  )
}
