"use client"
// Notifications: lets this phone or browser get her messages when the chat page is not open.
// Standard Web Push (VAPID); the service worker in public/sw.js shows the notification.
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

type Device = { id: string; endpoint: string; label: string; lastSentAt: string | null }
type PushStatus = {
  configured: boolean
  publicKey: string | null
  preview: boolean
  devices: Device[]
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
const post = <T,>(body: unknown) =>
  call<T>("/api/companion/push", { method: "POST", body: JSON.stringify(body) })

const supported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

function keyBytes(base64url: string) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

async function localSubscription() {
  if (!supported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

// Runs while the companion page is open: tells the server a page is being looked at (so she does
// not buzz the phone in your hand), and re-sends this browser's subscription in case the push
// service changed its address.
export function usePresence(onVisible?: () => void) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const beat = () => {
      if (!document.hidden) void post({ action: "seen" }).catch(() => undefined)
    }
    const changed = () => {
      beat()
      if (!document.hidden) onVisible?.()
    }
    beat()
    timer = setInterval(beat, 20_000)
    document.addEventListener("visibilitychange", changed)
    if (supported() && Notification.permission === "granted")
      void localSubscription()
        .then((sub) => sub && post({ action: "subscribe", subscription: sub.toJSON() }))
        .catch(() => undefined)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener("visibilitychange", changed)
    }
  }, [onVisible])
}

export function PushSettings({
  preview,
  onPreview,
}: {
  preview: boolean
  onPreview: (value: boolean) => void
}) {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [here, setHere] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | "none">("none")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [hint, setHint] = useState<"ios" | "unsupported" | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await call<PushStatus>("/api/companion/push"))
      if (supported()) {
        setPermission(Notification.permission)
        setHere((await localSubscription())?.endpoint ?? null)
        setHint(null)
      } else setHint(isIos() && !isStandalone() ? "ios" : "unsupported")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function enable() {
    if (!status?.publicKey) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      // Must run from this click: iPhone and Safari refuse to ask otherwise
      const answer = await Notification.requestPermission()
      setPermission(answer)
      if (answer !== "granted") throw new Error("没有允许通知")
      const registration = await navigator.serviceWorker.ready
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(status.publicKey),
        }))
      await post({ action: "subscribe", subscription: subscription.toJSON() })
      setMessage("通知开好了")
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function disable() {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const subscription = await localSubscription()
      if (subscription) {
        await post({ action: "unsubscribe", endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      setMessage("这台设备的通知已关闭")
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function test() {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const result = await post<{ sent: number; gone: number; failed: number }>({
        action: "test",
      })
      setMessage(
        result.sent
          ? `已发出（${result.sent} 台设备）`
          : "没发出去，可能设备已失效，请关掉再重新打开通知"
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const on = here !== null && status?.devices.some((device) => device.endpoint === here)
  return (
    <fieldset className="space-y-2 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm">
        手机 / 浏览器通知
        <span className="ml-2 text-xs text-faint">
          {on ? "这台设备已开" : "这台设备未开"}
        </span>
      </legend>
      <p className="text-xs text-faint">
        你没开着这个页面时，她主动找你或有事要告诉你，会像微信一样弹一条通知，点一下直接进聊天。免打扰时段内不会弹，等结束后再弹。
      </p>
      {status && !status.configured && (
        <p className="text-xs text-destructive">
          这台服务器还没生成通知密钥。管理员运行 npm run push:keys 后重启即可。
        </p>
      )}
      {hint === "ios" && (
        <p className="text-xs">
          iPhone / iPad 上要先用 Safari
          打开这个网页，点“分享”→“添加到主屏幕”，再从主屏幕上的图标打开，才能开通知（需要
          iOS 16.4 或更新）。
        </p>
      )}
      {hint === "unsupported" && (
        <p className="text-xs">
          这个浏览器不支持网页通知，可以换 Chrome、Edge、Firefox 或 Safari。
        </p>
      )}
      {permission === "denied" && (
        <p className="text-xs">
          浏览器里已经把通知设成了“禁止”，到浏览器的网站设置里改成“允许”后再点开启。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {on ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void disable()}
            >
              关闭这台设备的通知
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void test()}
            >
              发一条测试通知
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={
              busy || !status?.configured || hint !== null || permission === "denied"
            }
            onClick={() => void enable()}
          >
            开启通知
          </Button>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preview}
          onChange={(event) => onPreview(event.target.checked)}
        />
        通知里显示她说的那句话（关掉就只显示“发来一条消息”，锁屏更隐私）
      </label>
      {status && status.devices.length > 0 && (
        <p className="text-xs text-faint">
          已开通：{status.devices.map((device) => device.label).join("、")}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-ok">{message}</p>}
    </fieldset>
  )
}
