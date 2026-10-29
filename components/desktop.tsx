"use client"

// Adapted from the pinned MIT upstream components/workbench/screen.tsx at the pinned MIT baseline.
// Retains one movable canvas; reconnects with a new server ticket whenever ownership changes.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type RFB from "@novnc/novnc"
import { ExpandIcon, MonitorIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function Desktop({
  agentId,
  epoch,
  takeover,
  enabled,
}: {
  agentId: string
  epoch: number
  takeover: boolean
  enabled: boolean
}) {
  const screen = useRef<HTMLDivElement | null>(null)
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null)
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [requested, setRequested] = useState(false)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState("未连接")
  const [error, setError] = useState("")

  useLayoutEffect(() => {
    if (!screen.current) {
      screen.current = document.createElement("div")
      screen.current.className = "absolute inset-0"
    }
    const slot = expanded && overlaySlot ? overlaySlot : panelSlot
    if (slot && screen.current.parentElement !== slot) slot.appendChild(screen.current)
  }, [expanded, overlaySlot, panelSlot])

  useEffect(() => {
    if (takeover) {
      setRequested(true)
      setExpanded(true)
    }
  }, [takeover])

  useEffect(() => {
    if (!requested || !enabled) {
      setState(enabled ? "未连接" : "控制切换中")
      return
    }
    let disposed = false
    let client: RFB | undefined
    setState("连接中")
    setError("")
    void (async () => {
      const [response, { default: Client }] = await Promise.all([
        fetch("/api/desktop-tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, mode: takeover ? "control" : "watch" }),
        }),
        import("@novnc/novnc"),
      ])
      const ticket = await response.json()
      if (!response.ok) throw new Error(ticket.error)
      if (disposed) return
      const target = screen.current!
      target.replaceChildren()
      client = new Client(target, ticket.url, {
        credentials: { username: "", password: ticket.password, target: "" },
        wsProtocols: ["binary", `pa-token.${ticket.token}`],
      })
      client.scaleViewport = true
      client.background = "transparent"
      client.viewOnly = !takeover
      client.addEventListener("connect", () => {
        if (!disposed) {
          setState("已连接")
          if (takeover) client!.focus()
        }
      })
      client.addEventListener("disconnect", () => {
        client = undefined
        if (!disposed) setState("连接已关闭，请重新连接")
      })
      client.addEventListener("securityfailure", () => {
        if (!disposed) setError("桌面认证失败，请重新获取连接")
      })
    })().catch((cause) => {
      if (!disposed) {
        setState("连接失败")
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })
    return () => {
      disposed = true
      client?.disconnect()
    }
  }, [agentId, epoch, takeover, enabled, requested, retry])

  function connect() {
    setRequested(true)
    setRetry((value) => value + 1)
  }
  const display = (
    <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border/80 bg-[#1c1917] shadow-inner">
      <div ref={setPanelSlot} className="absolute inset-0" />
      {expanded && (
        <div className="absolute inset-0 grid place-items-center text-sm text-[#e7e0d6]/80">
          桌面已在大窗口中打开
        </div>
      )}
      {!expanded && state !== "已连接" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-sm text-[#f3ede4]/85">
          <MonitorIcon className="size-6 opacity-80" />
          <p>{state === "未连接" ? "连接服务器上的独立桌面" : state}</p>
          {error && <p role="alert">{error}</p>}
          {enabled && state !== "连接中" && (
            <Button variant="secondary" size="sm" onClick={connect}>
              连接桌面
            </Button>
          )}
        </div>
      )}
    </div>
  )
  return (
    <section
      aria-label="工作站桌面"
      className="mt-5 space-y-3 rounded-xl border border-border bg-muted/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p
          className={cn("font-medium", takeover && "text-amber-800 dark:text-amber-300")}
        >
          {takeover ? "你正在控制桌面，Agent 已暂停" : "只读观看"}
        </p>
        <div className="flex items-center gap-1">
          <span className="mr-2 text-xs text-muted-foreground" role="status">
            {state}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新连接桌面"
            disabled={!enabled}
            onClick={connect}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大桌面"
            disabled={!enabled}
            onClick={() => {
              setExpanded(true)
              if (!requested) connect()
            }}
          >
            <ExpandIcon />
          </Button>
        </div>
      </div>
      {display}
      <p className="text-xs leading-5 text-muted-foreground">
        观看连接由服务器强制只读。接管准备完成后，你才能输入；交还会关闭旧连接，并让 Agent
        重新观察。
      </p>
      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        disablePointerDismissal={takeover}
      >
        <DialogContent
          initialFocus={false}
          className="flex h-[min(92svh,900px)] max-w-[min(96vw,1280px)] flex-col sm:max-w-[min(96vw,1280px)]"
        >
          <DialogTitle>{takeover ? "你拥有桌面控制权" : "只读观看桌面"}</DialogTitle>
          <DialogDescription>
            {takeover
              ? "关闭此窗口会保持 Agent 暂停。回到任务详情后点击交还。"
              : "Agent 可以继续工作，当前连接无法发送输入。"}
          </DialogDescription>
          <div ref={setOverlaySlot} className="relative min-h-0 flex-1 bg-[#1c1917]" />
          {state !== "已连接" && <p className="text-sm">{error || state}</p>}
        </DialogContent>
      </Dialog>
    </section>
  )
}
