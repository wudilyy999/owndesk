"use client"
// "聊天软件" tab: bind Telegram / QQ / WeChat so the same companion answers there.
// Secrets are write-only here: the page only learns whether one is set.
import { useCallback, useEffect, useState } from "react"
import QRCode from "qrcode"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Base = {
  linked: boolean
  label: string
  proactive: "free" | "limited" | "never"
  heldCount: number
}
type Status = {
  channels: {
    telegram: Base & { paired: boolean; usesThisCompanion: boolean }
    qq: Base & { configured: boolean; webhookUrl: string }
    wechat: Base & { connected: boolean; status: string | null }
    wechat_oa: Base & { configured: boolean; encrypted: boolean; webhookUrl: string }
  }
  relay: { configured: boolean }
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
const post = (body: unknown) =>
  call<Record<string, unknown>>("/api/companion/channels", {
    method: "POST",
    body: JSON.stringify(body),
  })

const reach = {
  free: "她可以主动找你",
  limited: "她只能在你说话后回复；每个时段另有一条召回消息",
  never: "她只能在你说话后回复；你不在时想说的话会等你下次来时一起说",
} as const

function Card({
  title,
  base,
  children,
}: {
  title: string
  base: Base
  children: React.ReactNode
}) {
  return (
    <fieldset className="space-y-2 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm">
        {title}
        <span className="ml-2 text-xs text-faint">
          {base.linked ? "已绑定" : "未绑定"}
        </span>
      </legend>
      <p className="text-xs text-faint">
        {reach[base.proactive]}
        {base.heldCount > 0 && `（现在有 ${base.heldCount} 条在等你）`}
      </p>
      {children}
    </fieldset>
  )
}

export function Channels() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [code, setCode] = useState<{ channel: string; code: string } | null>(null)
  const [qr, setQr] = useState<{ qrcode: string; image: string } | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    try {
      setStatus(await call<Status>("/api/companion/channels"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function act(body: unknown, done?: string) {
    setError("")
    setMessage("")
    try {
      const result = await post(body)
      if (done) setMessage(done)
      await load()
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const field = (name: string, label: string, secret = false) => (
    <label className="block space-y-1 text-sm">
      {label}
      <Input
        type={secret ? "password" : "text"}
        autoComplete="off"
        placeholder={secret ? "已保存的内容不会显示；留空表示不改" : ""}
        value={secrets[name] ?? ""}
        onChange={(event) =>
          setSecrets((old) => ({ ...old, [name]: event.target.value }))
        }
      />
    </label>
  )
  const save = (channel: "qq" | "wechat_oa" | "relay", names: string[]) =>
    act(
      {
        action: "configure",
        channel,
        values: Object.fromEntries(
          names
            .filter((name) => secrets[`${channel}.${name}`])
            .map((name) => [name, secrets[`${channel}.${name}`]])
        ),
      },
      "已保存"
    )
  const f = (channel: string, name: string, label: string, secret = false) =>
    field(`${channel}.${name}`, label, secret)

  // Poll the WeChat login while a QR code is on screen
  useEffect(() => {
    if (!qr) return
    let stop = false
    void (async () => {
      while (!stop) {
        const result = (await post({
          action: "wechat-login-poll",
          qrcode: qr.qrcode,
        }).catch(() => null)) as { status?: string } | null
        if (result?.status === "confirmed") {
          setQr(null)
          setMessage("微信已连接")
          await load()
          return
        }
        if (result?.status === "expired") {
          setQr(null)
          setError("二维码过期了，请重新获取")
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    })()
    return () => {
      stop = true
    }
  }, [qr, load])

  if (!status) return <p className="text-sm text-faint">{error || "…"}</p>
  const { telegram, qq, wechat, wechat_oa } = status.channels
  const bindCode = (channel: "qq" | "wechat_oa") =>
    code?.channel === channel && (
      <p className="rounded-lg bg-muted p-2 text-sm">
        在对应的聊天里发送：<b>绑定 {code.code}</b>（10 分钟内有效，只能用一次）
      </p>
    )
  return (
    <section className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6">
      <p className="text-xs text-faint">
        在这些软件里，她是同一个人：同样的记忆、同样的聊天记录。凭据只存在这台机器上（加密），页面不会再显示。
      </p>
      <Card title="Telegram" base={telegram}>
        {!telegram.paired ? (
          <p className="text-xs">先在“模型与 Agent 设置”里配置并配对 Telegram 机器人。</p>
        ) : telegram.linked ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act({ action: "unbind", channel: "telegram" }, "已解除")}
          >
            解除（普通消息恢复为交办任务）
          </Button>
        ) : (
          <>
            <p className="text-xs text-faint">
              绑定后，你在这个聊天里发的普通文字是和她聊天；要她办事，她会发确认卡到网页。命令（/stop
              等）不变。
            </p>
            <Button
              size="sm"
              onClick={() => void act({ action: "telegram-link" }, "已绑定")}
            >
              用这个 Telegram 和她聊天
            </Button>
          </>
        )}
      </Card>

      <Card title="QQ（官方机器人）" base={qq}>
        <p className="text-xs text-faint">
          回调地址：{qq.webhookUrl}（须为公网 https，端口 80/443/8080/8443）
        </p>
        {f("qq", "appId", "AppID")}
        {f("qq", "appSecret", "AppSecret", true)}
        {f(
          "qq",
          "allowedUrlHosts",
          "已在“消息URL配置”登记的域名（逗号分隔，没有就留空）"
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => void save("qq", ["appId", "appSecret", "allowedUrlHosts"])}
          >
            保存
          </Button>
          {qq.configured && !qq.linked && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const result = (await act({ action: "pair-code", channel: "qq" })) as
                  { code?: string } | undefined
                if (result?.code) setCode({ channel: "qq", code: result.code })
              }}
            >
              生成绑定码
            </Button>
          )}
          {qq.linked && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act({ action: "unbind", channel: "qq" }, "已解除")}
            >
              解除绑定
            </Button>
          )}
        </div>
        {bindCode("qq")}
      </Card>

      <Card title="微信（ClawBot）" base={wechat}>
        {wechat.connected ? (
          <>
            <p className="text-xs">
              状态：
              {wechat.status === "ok"
                ? "已连接"
                : wechat.status === "expired"
                  ? "登录已失效，请重新扫码"
                  : (wechat.status ?? "未知")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act({ action: "wechat-disconnect" }, "已断开")}
            >
              断开
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-faint">
              需要微信里的 ClawBot 插件；扫码的那个微信号就是唯一能和她聊的人。
            </p>
            <Button
              size="sm"
              onClick={async () => {
                setError("")
                try {
                  const result = (await post({ action: "wechat-login-start" })) as {
                    qrcode: string
                    content: string
                  }
                  setQr({
                    qrcode: result.qrcode,
                    image: await QRCode.toDataURL(result.content, {
                      margin: 1,
                      width: 220,
                    }),
                  })
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause))
                }
              }}
            >
              获取二维码
            </Button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr && (
              <img
                src={qr.image}
                alt="微信扫码登录"
                width={220}
                height={220}
                className="rounded-lg bg-white p-1"
              />
            )}
          </>
        )}
      </Card>

      <Card title="微信公众号（备用）" base={wechat_oa}>
        <p className="text-xs text-faint">
          服务器地址：{wechat_oa.webhookUrl}。
          {wechat_oa.encrypted ? "已设置加密密钥（安全模式）。" : ""}
        </p>
        {f("wechat_oa", "appId", "AppID")}
        {f("wechat_oa", "appSecret", "AppSecret", true)}
        {f("wechat_oa", "token", "Token", true)}
        {f("wechat_oa", "aesKey", "EncodingAESKey（明文模式留空）", true)}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              void save("wechat_oa", ["appId", "appSecret", "token", "aesKey"])
            }
          >
            保存
          </Button>
          {wechat_oa.configured && !wechat_oa.linked && (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const result = (await act({
                  action: "pair-code",
                  channel: "wechat_oa",
                })) as { code?: string } | undefined
                if (result?.code) setCode({ channel: "wechat_oa", code: result.code })
              }}
            >
              生成绑定码
            </Button>
          )}
          {wechat_oa.linked && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void act({ action: "unbind", channel: "wechat_oa" }, "已解除")
              }
            >
              解除绑定
            </Button>
          )}
        </div>
        {bindCode("wechat_oa")}
      </Card>

      <fieldset className="space-y-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm">
          固定出口 IP 中转{status.relay.configured ? "（已配置）" : ""}
        </legend>
        <p className="text-xs text-faint">
          QQ 官方接口和公众号要求调用方 IP 在白名单里；这台机器没有固定公网 IP
          时，填你自己服务器上的中转（见 docs/channels.md）。
        </p>
        {f("relay", "url", "中转地址（https://…）")}
        {f("relay", "key", "中转密钥", true)}
        <Button size="sm" onClick={() => void save("relay", ["url", "key"])}>
          保存
        </Button>
      </fieldset>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-ok">{message}</p>}
    </section>
  )
}
