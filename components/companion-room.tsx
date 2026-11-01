"use client"
// The room: her days as a timeline, her diary, and the things worth keeping, plus a
// time-limited read-only peek at her desktop. The feed layout follows common companion apps
// (SillyTavern, AIRI); no code taken.
import { useCallback, useEffect, useState } from "react"
import { StarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Desktop } from "@/components/desktop"
import { cn } from "@/lib/utils"
import type { LifeActivity, LifeShare } from "@/db/schema"

type Activity = Omit<LifeActivity, "imagePath"> & { hasImage: boolean }
type Life = {
  activities: Activity[]
  shares: LifeShare[]
  spentTodayMicros: number
  unknownCostRequests: number
  dailyBudgetMicros: number
  rhythm: { state: "online" | "asleep" | "nap" | "away"; label: string | null }
  peek: { live: boolean; caption: string }
}
const sections = [
  ["timeline", "时间线"],
  ["diary", "日记"],
  ["favorites", "收藏"],
] as const
type Section = (typeof sections)[number][0]

const kindLabels: Record<string, string> = {
  read: "读到",
  watch: "看了",
  diary: "日记",
  save: "收藏",
  coview: "和你一起看",
  other: "其他",
}
const shareLabels: Record<string, string> = {
  pending: "待分享",
  sent: "已发给你",
  skipped: "没有发",
}
const stateLabels = {
  online: "在线",
  asleep: "睡觉中",
  nap: "午休中",
  away: "不在电脑前",
}
const PEEK_SECONDS = 60
const DAY = 24 * 3600_000

const safeUrl = (value: string | null) =>
  value && /^https?:\/\//.test(value) ? value : null
const clock = (value: string | Date, zone: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })
const day = (value: string | Date, zone: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    timeZone: zone,
    month: "long",
    day: "numeric",
    weekday: "short",
  })

export function Room({ agentId, zone }: { agentId: string; zone: string }) {
  const [life, setLife] = useState<(Life & { loadedAt: number }) | null>(null)
  const [section, setSection] = useState<Section>("timeline")
  const [peeking, setPeeking] = useState(false)
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    const response = await fetch("/api/companion/life", { cache: "no-store" })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    setLife({ ...result, loadedAt: Date.now() })
  }, [])
  useEffect(() => {
    load().catch((cause) => setError(String(cause)))
    const timer = setInterval(() => {
      if (!document.hidden && !peeking) load().catch((cause) => setError(String(cause)))
    }, 30000)
    return () => clearInterval(timer)
  }, [load, peeking])

  async function star(activity: Activity) {
    try {
      const response = await fetch(`/api/companion/life/${activity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: !activity.starred }),
      })
      if (!response.ok) throw new Error((await response.json()).error)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!life) return null
  const shares = new Map(life.shares.map((share) => [share.activityId, share]))
  const shown = life.activities.filter((a) =>
    section === "timeline"
      ? life.loadedAt - new Date(a.createdAt).getTime() < 7 * DAY
      : section === "diary"
        ? a.kind === "diary"
        : a.starred || a.kind === "save"
  )
  const days = new Map<string, Activity[]>()
  for (const activity of shown) {
    const key = day(activity.createdAt, zone)
    days.set(key, [...(days.get(key) ?? []), activity])
  }
  const empty = {
    timeline: "最近 7 天她还没有记录过什么。在设置里打开“自己的生活”。",
    diary: "她还没有写过日记。",
    favorites: "还没有收藏。点条目右上角的星标，可以把它留在这里。",
  }[section]

  return (
    <section className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-6">
      <div className="space-y-2 rounded-xl border border-border bg-surface p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p>
            <span className="font-medium">{stateLabels[life.rhythm.state]}</span>
            {life.rhythm.label && ` · ${life.rhythm.label}`}
            <span className="text-faint"> · {life.peek.caption}</span>
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!life.peek.live || peeking}
            onClick={() => setPeeking(true)}
          >
            偷看一下
          </Button>
        </div>
        {peeking && (
          <>
            <Desktop
              agentId={agentId}
              epoch={0}
              takeover={false}
              enabled
              peekSeconds={PEEK_SECONDS}
            />
            <Button size="sm" variant="ghost" onClick={() => setPeeking(false)}>
              关闭
            </Button>
          </>
        )}
      </div>
      <nav className="flex items-center gap-1">
        {sections.map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={section === id ? "secondary" : "ghost"}
            onClick={() => setSection(id)}
          >
            {label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-faint">
          今天已用 ${(life.spentTodayMicros / 1e6).toFixed(4)} / $
          {(life.dailyBudgetMicros / 1e6).toFixed(2)}
        </span>
      </nav>
      {life.unknownCostRequests > 0 && (
        <p className="text-xs text-faint">
          有 {life.unknownCostRequests}{" "}
          次调用没有价格，费用未计入（先在“用量与预算”里给模型设价格）
        </p>
      )}
      {shown.length === 0 && <p className="text-sm text-faint">{empty}</p>}
      {[...days].map(([label, items]) => (
        <div key={label} className="space-y-2">
          <h2 className="pt-1 text-xs font-medium text-faint">{label}</h2>
          {items.map((activity) => {
            const share = shares.get(activity.id)
            const url = safeUrl(activity.url)
            return (
              <article
                key={activity.id}
                className="space-y-1 rounded-xl border border-border bg-surface p-3 text-sm"
              >
                <div className="flex items-center justify-between text-xs text-faint">
                  <span>
                    {kindLabels[activity.kind]} · {clock(activity.createdAt, zone)}
                  </span>
                  <button
                    type="button"
                    aria-label={activity.starred ? "取消收藏" : "收藏"}
                    aria-pressed={activity.starred}
                    onClick={() => void star(activity)}
                  >
                    <StarIcon
                      className={cn(
                        "size-4",
                        activity.starred && "fill-current text-amber-500"
                      )}
                    />
                  </button>
                </div>
                <p className="font-medium">{activity.title}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {section === "diary" && activity.body
                    ? activity.body
                    : activity.summary}
                </p>
                {activity.hasImage && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/companion/images/${activity.id}`}
                    alt={activity.title}
                    loading="lazy"
                    className="max-h-64 rounded-lg border border-border"
                  />
                )}
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block text-xs break-all underline underline-offset-4"
                  >
                    {url}
                  </a>
                )}
                {share && (
                  <p className="text-xs text-faint">
                    {shareLabels[share.status]}
                    {share.skipReason ? `（${share.skipReason}）` : ""}：{share.text}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      ))}
    </section>
  )
}
