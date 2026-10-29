import type { CompletionContract, ReportComparison } from "@/db/schema"
import { parseCsv, verifyCsv } from "@/lib/artifact-checks"

const scale = 1000000n
function decimal(value: string) {
  if (!/^-?\d{1,15}(?:\.\d{1,6})?$/.test(value))
    throw new Error(
      `Invalid decimal value: ${value.slice(0, 100)}; use at most six fractional digits, no grouping or exponent`
    )
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".")
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"))
  return value.startsWith("-") ? -result : result
}
function format(value: bigint) {
  const absolute = value < 0n ? -value : value
  const fraction = String(absolute % scale)
    .padStart(6, "0")
    .replace(/0+$/, "")
  return `${value < 0n ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`
}

function total(
  content: string,
  contract: NonNullable<CompletionContract["artifact"]>,
  column: string
) {
  const verification = verifyCsv(content, contract)
  const [header, ...rows] = parseCsv(content.replace(/^\uFEFF/, ""))
  if (!rows.length)
    throw new Error("A comparison report must contain at least one data row")
  const index = header.indexOf(column)
  if (index < 0) throw new Error(`CSV is missing comparison column: ${column}`)
  let sum = 0n
  for (const [i, row] of rows.entries()) {
    try {
      sum += decimal(row[index])
    } catch (error) {
      throw new Error(`CSV row ${i + 2}, column ${column}: ${(error as Error).message}`)
    }
  }
  return { sum, verification }
}

// Exact fixed-point arithmetic. No model-supplied result can decide suppression.
export function compareReports(
  current: string,
  baseline: string,
  currentContract: NonNullable<CompletionContract["artifact"]>,
  rule: ReportComparison
) {
  const now = total(current, currentContract, rule.valueColumn)
  const before = total(baseline, rule.baseline, rule.valueColumn)
  const delta = now.sum - before.sum
  const magnitude = delta < 0n ? -delta : delta
  const baselineMagnitude = before.sum < 0n ? -before.sum : before.sum
  const threshold = decimal(rule.threshold)
  const directionMatches =
    rule.direction === "any" || (rule.direction === "increase" ? delta > 0n : delta < 0n)
  const percentageUndefined = before.sum === 0n && delta !== 0n
  const matched =
    delta !== 0n &&
    directionMatches &&
    (rule.kind === "absolute"
      ? magnitude >= threshold
      : !percentageUndefined && magnitude * 100n * scale >= baselineMagnitude * threshold)
  // A percentage against a zero baseline requires attention, never quiet success.
  const needsAttention = rule.kind === "percent" && percentageUndefined
  return {
    grade: "program_checked" as const,
    valueColumn: rule.valueColumn,
    currentTotal: format(now.sum),
    baselineTotal: format(before.sum),
    delta: format(delta),
    percentChange:
      before.sum === 0n
        ? delta === 0n
          ? "0"
          : null
        : format((delta * 100n * scale) / baselineMagnitude),
    condition: { kind: rule.kind, threshold: rule.threshold, direction: rule.direction },
    matched,
    needsAttention,
    currentChecks: now.verification.checks,
    baselineChecks: before.verification.checks,
    notification: {
      policy: rule.notify,
      send: rule.notify === "always" || matched || needsAttention,
      reason: needsAttention
        ? "基期合计为零，百分比无法定义，需要你核对。"
        : matched
          ? "程序比较达到指定变化条件。"
          : "程序比较未达到指定变化条件，成果仍保留在网页。",
    },
    unverified: [
      "程序检查两份 CSV 的结构、日期和数值计算；未证明下载源数据真实、完整或模型摘要正确。",
    ],
  }
}
export type ComparisonResult = ReturnType<typeof compareReports> & {
  currentArtifactId: string
  baselineArtifactId: string
}

export function comparisonSummary(result: ComparisonResult) {
  return `程序核对 ${result.valueColumn} 合计：本期 ${result.currentTotal}，基期 ${result.baselineTotal}，差额 ${result.delta}；变化率 ${result.percentChange === null ? "无法定义" : `${result.percentChange}%（展示值截取六位小数）`}。${result.notification.reason}`
}
