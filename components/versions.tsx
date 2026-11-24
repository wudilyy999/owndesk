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
  const [fork, setFork] = useState<{
    id: string
    roundNo: number
    note: string
    requestId: string
  } | null>(null)
  const [created, setCreated] = useState("")
  async function submitFork() {
    if (!fork || busy) return
    setBusy(true)
    setError("")
    try {
      const response = await fetch(`/api/improvements/${encodeURIComponent(fork.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "fork",
          roundNo: fork.roundNo,
          note: fork.note,
          requestId: fork.requestId,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setCreated(result.objectiveId)
      setFork(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
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
      {active?.kind === "local" && data.enabled && (
        <section className="space-y-2 rounded-xl border p-4" aria-label="官方升级">
          <h2>合并官方升级</h2>
          {data.officialOffer?.fromId === active.id && (
            <p>
              官方 {data.officialOffer.revision.slice(0, 12)} ·{" "}
              {data.officialOffer.requests.length} 项本地需求
            </p>
          )}
          {[
            "discover",
            ...(data.officialOffer?.fromId === active.id ? ["merge", "discard"] : []),
          ].map((action) => (
            <Button
              key={action}
              disabled={busy || !!running}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  const r = await fetch("/api/versions/official", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action,
                      fromId: active.id,
                      revision: data.officialOffer?.revision,
                    }),
                  })
                  const out = await r.json()
                  if (!r.ok) throw new Error(out.error)
                  if (out.objectiveId) setCreated(out.objectiveId)
                  await refresh()
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {action === "discover"
                ? "检查官方更新"
                : action === "discard"
                  ? "只用官方版（保留需求）"
                  : "合并升级并评测"}
            </Button>
          ))}
        </section>
      )}
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
      <section aria-label="版本谱系" className="space-y-3">
        <h2 className="font-medium">版本谱系</h2>
        <ul className="space-y-2 text-sm">
          {data.versions.map((v) => (
            <li key={v.id} id={`version-${v.id}`}>
              {v.parentId && (
                <>
                  <a className="underline" href={`#version-${v.parentId}`}>
                    {label(v.parentId)}
                  </a>{" "}
                  →{" "}
                </>
              )}
              {v.label} · {statusLabels[v.status]}
            </li>
          ))}
        </ul>
        {data.lineage.map((c) => {
          const id = `${c.objectiveId}:${c.roundNo}`
          const parent = data.lineage.find(
            (other) => other.commit && other.commit === c.parent
          )
          const version = data.versions.find((v) => v.id === c.versionId)
          const base = data.versions.find(
            (v) => v.gitCommit === c.parent || v.sourceRevision === c.parent
          )
          return (
            <article
              key={id}
              id={`round-${id}`}
              className="space-y-2 rounded-xl border p-3 text-sm"
            >
              <strong>
                {c.title} · 第 {c.roundNo} 轮
              </strong>
              <p>{c.request}</p>
              <p>
                源自{" "}
                {parent ? (
                  <a
                    className="underline"
                    href={`#round-${parent.objectiveId}:${parent.roundNo}`}
                  >
                    {parent.title} · 第 {parent.roundNo} 轮
                  </a>
                ) : base ? (
                  <a className="underline" href={`#version-${base.id}`}>
                    {base.label}
                  </a>
                ) : (
                  c.parent.slice(0, 12)
                )}{" "}
                → {c.commit?.slice(0, 12) ?? "生成中"}
              </p>
              <p>
                {version
                  ? statusLabels[version.status]
                  : c.abandoned
                    ? "已放弃"
                    : c.passed === false
                      ? "评测未通过"
                      : c.passed
                        ? "评测通过"
                        : c.phase === "done"
                          ? "本轮已结束"
                          : "进行中"}{" "}
                · 已知花费 ${(Number(c.costMicros) / 1e6).toFixed(6)}
                {c.unknownCosts > 0 ? `（另有 ${c.unknownCosts} 笔待核算）` : ""}
              </p>
              {c.checks?.length ? (
                <p>评测：{c.checks.map((x) => `${x.name} ${x.status}`).join(" · ")}</p>
              ) : (
                <p>尚无评测结果</p>
              )}
              {c.phase === "done" && c.commit && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setCreated("")
                    setFork({
                      id: c.objectiveId,
                      roundNo: c.roundNo,
                      note: c.request,
                      requestId: crypto.randomUUID(),
                    })
                  }}
                >
                  从这一版继续改
                </Button>
              )}
              {fork?.id === c.objectiveId && fork.roundNo === c.roundNo && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void submitFork()
                  }}
                  className="space-y-2"
                >
                  <label className="block">
                    新目标
                    <textarea
                      className="block w-full rounded border p-2"
                      required
                      maxLength={4000}
                      value={fork.note}
                      onChange={(e) => setFork({ ...fork, note: e.target.value })}
                    />
                  </label>
                  <Button type="submit" disabled={busy || !fork.note.trim()}>
                    创建改进目标
                  </Button>
                </form>
              )}
            </article>
          )
        })}
        {created && (
          <p role="status">
            已创建新目标。
            <a className="underline" href="/improvements">
              查看改进
            </a>
          </p>
        )}
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
