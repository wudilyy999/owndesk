"use client"
// Self-improvement (B1): turn it on, follow each improvement, read the lab's report, and
// adopt / revise / abandon. Only a candidate whose every test passed can be adopted.
import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { stageNames } from "@/components/improvement-cards"
import type { ImprovementOverview } from "@/lib/evolution/improvements"

const statusLabels: Record<string, string> = {
  working: "实验室进行中",
  ready: "全部通过，等你决定",
  adopting: "正在换成新版本",
  adopted: "已采用",
  abandoned: "已放弃",
}
const objectiveLabels: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  achieved: "已完成",
  budget_limited: "已达上限",
  stopped: "已停止",
}

async function call(path: string, method: string, body: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
  return result
}

export function Improvements({ initial }: { initial: ImprovementOverview }) {
  const [data, setData] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notes, setNotes] = useState<Record<string, string>>({})

  async function refresh() {
    const fresh = await fetch("/api/improvements", { cache: "no-store" })
    if (fresh.ok) setData(await fresh.json())
  }
  useEffect(() => {
    const timer = setInterval(() => void refresh().catch(() => {}), 10000)
    return () => clearInterval(timer)
  }, [])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError("")
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <header>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回工作现场
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">自我改进</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          在聊天里说想怎么改她，她会发一张改进提议卡。确认后，实验室在隔离的副本里修改，
          再由她改不了的评测器跑全套测试和真实实测。全部通过后你点“采用”才换成新版本；
          新版本一旦不健康会先自动退回旧版本，再在副本里修好重测。
        </p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <section
        aria-label="开关"
        className="flex items-center justify-between rounded-2xl border border-border p-5"
      >
        <div className="text-sm">
          自我改进：{data.enabled ? "已打开" : "已关闭"}
          <p className="text-muted-foreground">
            候选版本里只有人设、设置和合成的测试聊天与记忆，没有你的密钥和真实聊天，也不能上网。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(() => call("/api/improvements", "PATCH", { enabled: !data.enabled }))
          }
        >
          {data.enabled ? "关闭" : "打开"}
        </Button>
      </section>
      {data.improvements.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有改进。</p>
      )}
      {data.improvements.map((item) => {
        const last = item.candidates.at(-1)
        const evaluation = last?.evaluation
        const canAdopt = item.status === "ready" && evaluation?.passed && last?.versionId
        return (
          <article
            key={item.objectiveId}
            aria-label={`改进 ${item.title}`}
            className="space-y-3 rounded-2xl border border-border p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{item.title}</h2>
              <span
                className="text-sm text-muted-foreground"
                data-testid="improvement-status"
              >
                {statusLabels[item.status]}
                {item.objective ? ` · 目标${objectiveLabels[item.objective.status]}` : ""}
                {item.objective?.statusReason ? `（${item.objective.statusReason}）` : ""}
              </span>
            </div>
            <p className="text-sm">{item.request}</p>
            <ul className="text-sm">
              {item.checklist.map((entry) => {
                const verdict = evaluation?.acceptance.find((row) => row.item === entry)
                return (
                  <li key={entry}>
                    {verdict ? (verdict.status === "pass" ? "✅" : "❌") : "☐"} {entry}
                    {verdict?.note && (
                      <span className="text-muted-foreground"> — {verdict.note}</span>
                    )}
                  </li>
                )
              })}
            </ul>
            {item.adoption?.outcome === "auto_rolled_back" && (
              <p className="text-sm text-destructive">
                采用后新版本出了问题，已自动退回旧版本：{item.adoption.reason}
              </p>
            )}
            {last && (
              <div className="space-y-1 text-sm" data-testid="improvement-latest">
                <p>
                  第 {last.roundNo} 版{last.version ? `（${last.version.label}）` : ""}：
                  {last.phase === "reforming"
                    ? "改造者正在修改…"
                    : last.phase === "evaluating"
                      ? "正在跑测试…"
                      : evaluation?.passed
                        ? "全部通过"
                        : "没通过"}
                </p>
                {last.claim && (
                  <p className="text-muted-foreground">改造者说明：{last.claim}</p>
                )}
                {evaluation && (
                  <ul>
                    {evaluation.stages.map((stage) => (
                      <li key={stage.name}>
                        {stage.status === "pass"
                          ? "✅"
                          : stage.status === "skip"
                            ? "➖"
                            : "❌"}{" "}
                        {stageNames[stage.name] ?? stage.name}
                        {stage.counts
                          ? ` ${stage.counts.passed}/${stage.counts.total}`
                          : ""}
                        {stage.status === "fail" && (
                          <pre className="mt-1 max-h-40 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
                            {stage.detail}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {last.files && last.files.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      技术细节：改了 {last.files.length} 个文件
                    </summary>
                    <ul className="text-xs">
                      {last.files.map((file) => (
                        <li key={file.path}>
                          {file.status} {file.path} +{file.added} −{file.removed}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {item.status !== "abandoned" && item.status !== "adopted" && (
              <div className="flex flex-wrap items-end gap-2">
                {canAdopt && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        call(`/api/improvements/${item.objectiveId}`, "POST", {
                          action: "adopt",
                        })
                      )
                    }
                  >
                    采用
                  </Button>
                )}
                {item.status !== "adopting" && (
                  <>
                    <Textarea
                      aria-label="哪里要再改"
                      rows={1}
                      className="max-w-sm"
                      placeholder="哪里不满意？"
                      value={notes[item.objectiveId] ?? ""}
                      onChange={(event) =>
                        setNotes({ ...notes, [item.objectiveId]: event.target.value })
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !(notes[item.objectiveId] ?? "").trim()}
                      onClick={() =>
                        run(() =>
                          call(`/api/improvements/${item.objectiveId}`, "POST", {
                            action: "revise",
                            note: notes[item.objectiveId],
                          })
                        )
                      }
                    >
                      再改改
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          call(`/api/improvements/${item.objectiveId}`, "POST", {
                            action: "abandon",
                          })
                        )
                      }
                    >
                      放弃
                    </Button>
                  </>
                )}
              </div>
            )}
          </article>
        )
      })}
    </main>
  )
}
