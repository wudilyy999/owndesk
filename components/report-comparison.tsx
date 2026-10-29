import { comparisonSummary, type ComparisonResult } from "@/lib/report-comparison"

export function ReportComparison({ result }: { result: ComparisonResult }) {
  const direction = { any: "任意方向", increase: "增加", decrease: "减少" }[
    result.condition.direction
  ]
  return (
    <section
      aria-label="程序比较结果"
      className="mt-5 space-y-3 rounded-md border p-4 text-sm leading-6"
    >
      <h2 className="font-medium">程序比较结果</h2>
      <p>{comparisonSummary(result)}</p>
      <p className="text-muted-foreground">
        条件：{direction}，变化幅度至少 {result.condition.threshold}
        {result.condition.kind === "percent" ? "%" : "（原数值单位）"}
        （含阈值；零差额不触发）。
      </p>
      <p>
        {result.notification.send
          ? "通知决策：需要通知；实际投递状态以渠道回执为准。"
          : "通知决策：保持安静；本次成果和核对记录已保存。"}
      </p>
      <div className="flex flex-wrap gap-4">
        <a
          href={`/api/artifacts/${encodeURIComponent(result.currentArtifactId)}`}
          className="underline underline-offset-4"
        >
          下载本期 CSV
        </a>
        <a
          href={`/api/artifacts/${encodeURIComponent(result.baselineArtifactId)}`}
          className="underline underline-offset-4"
        >
          下载基期 CSV
        </a>
      </div>
      <p className="text-xs text-muted-foreground">{result.unverified.join(" ")}</p>
    </section>
  )
}
