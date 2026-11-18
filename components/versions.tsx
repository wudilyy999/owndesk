"use client"
// Versions: what is running, the versions kept for one-click rollback, switch history.
import { PageLayout } from "@/components/page-header"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { VersionsOverview } from "@/lib/versions"

const statusLabels: Record<string, string> = {
  active: "正在使用",
  retained: "保留中",
  rejected: "没通过健康检测",
  pruned: "已清理",
  candidate: "候选",
  evaluating: "评测中",
  ready: "可采用",
}
const actionLabels: Record<string, string> = {
  promote: "升级",
  rollback: "手动切换",
  auto_rollback: "自动回退",
}
const deploymentLabels: Record<string, string> = {
  running: "进行中",
  healthy: "健康",
  rolled_back: "已退回旧版本",
  failed: "失败，需要处理",
}

export function Versions({ initial }: { initial: VersionsOverview }) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const running = data.deployments.find((item) => item.status === "running")

  async function refresh() {
    const fresh = await fetch("/api/versions")
    if (fresh.ok) setData(await fresh.json())
  }
  useEffect(() => {
    const timer = setInterval(
      () => void refresh().catch(() => {}),
      running ? 3000 : 15000
    )
    return () => clearInterval(timer)
  }, [running])

  async function switchTo(versionId: string) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/versions/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const date = (value: string | Date | null) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""
  const label = (id: string | null) =>
    data.versions.find((version) => version.id === id)?.label ?? "未知版本"
  const active = data.versions.find((version) => version.status === "active")
  const kept = data.versions.filter((version) => version.status === "retained")
  return (
    <PageLayout title="版本">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!data.enabled && (
        <p className="text-sm text-muted-foreground">
          这台不是 Docker 部署（scripts/install.sh），版本切换不可用。
        </p>
      )}
      {running && (
        <p role="status" className="rounded-xl border border-border p-4 text-sm">
          正在{actionLabels[running.action]}到 {label(running.toVersionId)}（
          {running.phase}）…
        </p>
      )}
      <section aria-label="当前版本" className="rounded-2xl border border-border p-5">
        <h2 className="font-medium">当前版本</h2>
        {active ? (
          <p className="mt-2 text-sm" data-testid="active-version">
            {active.label}
            <span className="text-muted-foreground">
              {" "}
              · 源码 {active.sourceRevision.slice(0, 12)} · 自 {date(active.promotedAt)}
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">还没有记录。</p>
        )}
      </section>
      <section aria-label="保留的版本" className="space-y-3">
        <h2 className="font-medium">保留的版本</h2>
        {data.enabled && kept.length > 0 && (
          <p className="text-sm text-muted-foreground">
            切换版本会短暂中断服务，任务和文件会保留。
          </p>
        )}
        {kept.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有可以切换的旧版本。</p>
        )}
        {kept.map((version) => (
          <article
            key={version.id}
            aria-label={`版本 ${version.label}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4"
          >
            <div className="text-sm">
              {version.label}
              <span className="text-muted-foreground">
                {" "}
                · {statusLabels[version.status]} · 上次使用 {date(version.promotedAt)}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!running || !data.enabled}
              onClick={() => switchTo(version.id)}
            >
              切换到这个版本
            </Button>
          </article>
        ))}
      </section>
      <section aria-label="切换记录" className="space-y-2">
        <h2 className="font-medium">切换记录</h2>
        {data.deployments.length === 0 && (
          <p className="text-sm text-muted-foreground">还没有切换过。</p>
        )}
        <ul className="space-y-2 text-sm">
          {data.deployments.map((item) => (
            <li key={item.id} className="rounded-xl border border-border p-3">
              <span>
                {date(item.startedAt)} · {actionLabels[item.action]}：
                {label(item.fromVersionId)} → {label(item.toVersionId)} ·{" "}
                {deploymentLabels[item.status]}
              </span>
              {item.reason && (
                <p className="mt-1 text-xs text-muted-foreground">原因：{item.reason}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </PageLayout>
  )
}
