"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { AgentZeroPluginInstallation } from "@/lib/agent-zero"

type CatalogEntry = {
  id: string
  title: string
  description: string
  repository: string
  commit: string | null
  tags: string[]
}
const endpoint = "/api/plugins/agent-zero"
const displayText = (value: string) => value.replace(/Agent\s*Zero/gi, "原平台")

export function AgentZeroPlugins() {
  const [installed, setInstalled] = useState<AgentZeroPluginInstallation[]>([])
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [search, setSearch] = useState("")
  const [repository, setRepository] = useState("")
  const [ref, setRef] = useState("HEAD")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error)
        if (live) setInstalled(body)
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  async function browse() {
    setBusy("catalog")
    setError("")
    try {
      const response = await fetch(`${endpoint}?catalog=1`, { cache: "no-store" })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      setCatalog(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }

  async function mutate(method: "POST" | "PATCH", input: unknown, key: string) {
    setBusy(key)
    setError("")
    setNotice("")
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      setInstalled(body)
      setNotice(
        method === "POST"
          ? "插件源码已安装。查看可用工具后启用；安装过程未执行第三方代码。"
          : "配置已保存。新任务使用新配置，已受理任务保留原版本与配置。"
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }

  const query = search.trim().toLowerCase()
  const matches =
    catalog?.filter((item) =>
      `${item.id} ${item.title} ${item.description} ${item.tags.join(" ")}`
        .toLowerCase()
        .includes(query)
    ) ?? []
  return (
    <section
      id="community-plugins"
      aria-labelledby="community-plugins-heading"
      className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="community-plugins-heading" className="text-lg font-medium">
          社区插件
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!!busy}
          onClick={() => void browse()}
        >
          {busy === "catalog"
            ? "正在获取目录…"
            : catalog
              ? "刷新插件目录"
              : "浏览插件目录"}
        </Button>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        安装社区原版 Python 工具，在你的独立 Linux
        桌面里执行。每个插件分别列出可用工具和当前未接入的扩展。
      </p>
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void mutate(
            "POST",
            { repository: repository.trim(), ref: ref.trim() },
            "install"
          )
        }}
      >
        <label className="block space-y-2 text-sm">
          <span>插件 GitHub 仓库</span>
          <Input
            aria-label="插件 GitHub 仓库"
            type="url"
            required
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/linkliti/a0-plugin-rg"
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 space-y-2 text-sm">
            <span>版本、分支或提交</span>
            <Input
              aria-label="插件版本"
              required
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={!!busy || !repository.trim() || !ref.trim()}>
            {busy === "install" ? "正在安装…" : "安装插件"}
          </Button>
        </div>
      </form>
      {catalog && (
        <div className="space-y-3 border-t border-border pt-4">
          <Input
            aria-label="搜索社区插件"
            placeholder="搜索名称、用途或标签"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            社区插件目录 {catalog.length} 项，匹配 {matches.length}{" "}
            项。安装后检查具体兼容范围。
          </p>
          <ul
            aria-label="社区插件目录"
            className="max-h-80 divide-y divide-border overflow-y-auto"
          >
            {matches.slice(0, 30).map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{displayText(item.title)}</p>
                  <p className="mt-1 line-clamp-3 text-xs leading-5 break-words text-muted-foreground">
                    {displayText(item.description)}
                  </p>
                  <a
                    href={item.repository}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs underline underline-offset-4"
                  >
                    查看源码
                  </a>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    !!busy ||
                    !item.commit ||
                    installed.some(
                      (row) => row.id === item.id && row.commit === item.commit
                    )
                  }
                  onClick={() =>
                    void mutate(
                      "POST",
                      {
                        repository: item.repository,
                        ref: item.commit,
                        expectedName: item.id,
                      },
                      item.id
                    )
                  }
                >
                  {!item.commit
                    ? "索引缺少版本"
                    : busy === item.id
                      ? "安装中…"
                      : installed.some(
                            (row) => row.id === item.id && row.commit === item.commit
                          )
                        ? "已安装"
                        : "安装"}
                </Button>
              </li>
            ))}
          </ul>
          {matches.length > 30 && (
            <p className="text-xs text-muted-foreground">
              当前显示前 30 项，输入更具体的关键词缩小范围。
            </p>
          )}
        </div>
      )}
      <div className="space-y-4 border-t border-border pt-4">
        <h3 className="text-sm font-medium">已安装插件</h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">正在读取…</p>
        ) : (
          !installed.length && (
            <p className="text-sm text-muted-foreground">
              尚未安装。可以先试 Ripgrep Search，或从社区目录选择插件。
            </p>
          )
        )}
        {installed.map((item) => (
          <article
            key={`${item.id}:${item.commit}`}
            className="space-y-3 rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-medium">{displayText(item.title)}</h4>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {item.version} · {item.commit.slice(0, 12)}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={item.enabled ? "outline" : "default"}
                disabled={!!busy || !item.tools.length}
                onClick={() =>
                  void mutate(
                    "PATCH",
                    { id: item.id, enabled: !item.enabled, config: item.config },
                    item.id
                  )
                }
              >
                {item.enabled ? "停用" : item.tools.length ? "启用工具" : "需适配"}
              </Button>
            </div>
            <p className="text-sm leading-6 break-words text-muted-foreground">
              {displayText(item.description)}
            </p>
            <p className="text-xs leading-5 break-words">
              可调用工具：{item.tools.join("、") || "无 Python 工具入口"}
              。启用后仍需验证其运行依赖。
            </p>
            {item.unsupported.length > 0 && (
              <p className="text-xs leading-5 text-muted-foreground">
                当前未接入：{item.unsupported.map(displayText).join("；")}。
              </p>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer">工具配置</summary>
              <form
                className="mt-3 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  try {
                    const config = JSON.parse(
                      drafts[item.id] ?? JSON.stringify(item.config)
                    )
                    void mutate(
                      "PATCH",
                      { id: item.id, enabled: item.enabled, config },
                      item.id
                    )
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  }
                }}
              >
                <Textarea
                  aria-label={`${displayText(item.title)} 工具配置`}
                  className="min-h-32 font-mono text-xs"
                  value={drafts[item.id] ?? JSON.stringify(item.config, null, 2)}
                  maxLength={8000}
                  onChange={(event) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [item.id]: event.target.value,
                    }))
                  }
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  填写普通 JSON
                  参数。此配置会进入任务快照，密钥与密码请继续使用保险箱；当前插件桥未接入保险箱取密。
                </p>
                <Button type="submit" size="sm" variant="outline" disabled={!!busy}>
                  保存工具配置
                </Button>
              </form>
            </details>
          </article>
        ))}
      </div>
    </section>
  )
}
