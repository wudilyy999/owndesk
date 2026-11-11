"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { ConnectionReference } from "@/lib/connection-schema"
type View = ConnectionReference & { kind: string; enabled: boolean; authorized: boolean }
export function Connections() {
  const [editing, setEditing] = useState<string | null>(null)
  const [rows, setRows] = useState<View[]>([]),
    [name, setName] = useState(""),
    [kind, setKind] = useState("mcp_http"),
    [endpoint, setEndpoint] = useState(""),
    [allowLoopback, setAllowLoopback] = useState(false),
    [bearer, setBearer] = useState(""),
    [command, setCommand] = useState(""),
    [args, setArgs] = useState("[]"),
    [environment, setEnvironment] = useState("{}"),
    [clientId, setClientId] = useState(""),
    [clientSecret, setClientSecret] = useState(""),
    [authorizationUrl, setAuthorizationUrl] = useState(""),
    [tokenUrl, setTokenUrl] = useState(""),
    [scope, setScope] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const refresh = async () => {
    const response = await fetch("/api/connections")
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    setRows(result)
  }
  useEffect(() => {
    refresh().catch((cause) => setError(String(cause)))
  }, [])
  function resetForm() {
    setEditing(null)
    setName("")
    setKind("mcp_http")
    setEndpoint("")
    setAllowLoopback(false)
    setBearer("")
    setCommand("")
    setArgs("[]")
    setEnvironment("{}")
    setClientId("")
    setClientSecret("")
    setAuthorizationUrl("")
    setTokenUrl("")
    setScope("")
    setError("")
  }
  async function post(url: string, body: unknown) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      await refresh()
      if (result.url) location.assign(result.url)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <section id="connections" className="space-y-4 rounded-xl border border-border p-4">
      <h2 className="font-medium">应用连接</h2>
      <p className="text-xs text-muted-foreground">
        连接可用于新任务。修改、禁用或断开后，正在运行的任务需要重新确认连接。MCP
        调用（包括自称只读的工具）显示参数并等你确认。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault()
          void (async () => {
            try {
              const config =
                kind === "google"
                  ? { kind, clientId, clientSecret }
                  : kind === "mcp_stdio"
                    ? {
                        kind,
                        command,
                        args: JSON.parse(args),
                        env: JSON.parse(environment),
                      }
                    : {
                        kind,
                        url: endpoint,
                        allowLoopback,
                        ...(bearer ? { bearer } : {}),
                        ...(authorizationUrl
                          ? {
                              oauth: {
                                authorizationUrl,
                                tokenUrl,
                                clientId,
                                clientSecret,
                                scope,
                              },
                            }
                          : {}),
                      }
              if (
                await post("/api/connections", {
                  ...(editing ? { id: editing } : {}),
                  name,
                  config,
                })
              ) {
                resetForm()
              }
            } catch (cause) {
              setError(String(cause))
            }
          })()
        }}
      >
        <label className="block">
          连接名称
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="block w-full rounded border p-2"
          />
        </label>
        <label className="block">
          连接类型
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="block w-full rounded border p-2"
          >
            <option value="mcp_http">远程 MCP</option>
            <option value="mcp_stdio">本机 MCP</option>
            <option value="google">Google 邮箱与日历</option>
          </select>
        </label>
        {kind === "mcp_http" && (
          <>
            <label className="block">
              MCP 地址
              <input
                required
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
            <label className="block">
              访问令牌（可选）
              <input
                type="password"
                autoComplete="off"
                value={bearer}
                onChange={(event) => setBearer(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
            <label className="block">
              <input
                type="checkbox"
                checked={allowLoopback}
                onChange={(event) => setAllowLoopback(event.target.checked)}
              />
              允许此连接访问本机回环地址（仅 localhost、127.0.0.1、::1；请确认服务可信）
            </label>
            <details>
              <summary>OAuth（可选）</summary>
              <label className="block">
                授权地址
                <input
                  type="url"
                  value={authorizationUrl}
                  onChange={(event) => setAuthorizationUrl(event.target.value)}
                  className="block w-full rounded border p-2"
                />
              </label>
              <label className="block">
                令牌地址
                <input
                  type="url"
                  value={tokenUrl}
                  onChange={(event) => setTokenUrl(event.target.value)}
                  className="block w-full rounded border p-2"
                />
              </label>
              <label className="block">
                权限范围
                <input
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                  className="block w-full rounded border p-2"
                />
              </label>
            </details>
          </>
        )}
        {kind === "mcp_stdio" && (
          <>
            <label className="block">
              启动程序
              <input
                required
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
            <label className="block">
              参数（JSON 数组）
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
            <label className="block">
              环境变量（JSON）
              <textarea
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
          </>
        )}
        {(kind === "google" || authorizationUrl) && (
          <>
            <label className="block">
              OAuth Client ID
              <input
                required
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
            <label className="block">
              OAuth Client Secret
              <input
                type="password"
                autoComplete="off"
                required={kind === "google"}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                className="block w-full rounded border p-2"
              />
            </label>
          </>
        )}
        <Button disabled={busy} type="submit">
          {editing ? "替换连接配置" : "保存连接"}
        </Button>
        {editing && (
          <Button disabled={busy} type="button" variant="outline" onClick={resetForm}>
            取消重新配置
          </Button>
        )}
      </form>
      {rows.map((row) => (
        <article key={row.id} className="space-y-2 border-t pt-3">
          <p>
            {row.name} · {row.enabled ? "已启用" : "已停用"} · {row.tools.length} 个工具
          </p>
          <p className="text-xs break-all">
            OAuth 回调地址：{typeof location === "undefined" ? "" : location.origin}
            /api/connections/{row.id}/oauth
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                resetForm()
                setEditing(row.id)
                setName(row.name)
                setKind(row.kind)
                document.getElementById("connections")?.scrollIntoView()
              }}
            >
              重新配置
            </Button>
            {["discover", "authorize", "disconnect", "delete"].map((action, index) => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={busy || (action === "authorize" && row.kind === "mcp_stdio")}
                onClick={async () => {
                  if (
                    (await post(`/api/connections/${row.id}`, { action })) &&
                    action === "delete" &&
                    editing === row.id
                  )
                    resetForm()
                }}
              >
                {["发现工具", "授权登录", "断开", "删除"][index]}
              </Button>
            ))}
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void post(`/api/connections/${row.id}`, {
                  action: "enable",
                  enabled: !row.enabled,
                })
              }
            >
              {row.enabled ? "停用" : "启用"}
            </Button>
          </div>
          <details>
            <summary className="text-xs">查看工具和参数</summary>
            <pre className="max-h-64 overflow-auto text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(row.tools, null, 2)}
            </pre>
          </details>
        </article>
      ))}
    </section>
  )
}
