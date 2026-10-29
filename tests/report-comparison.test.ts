import assert from "node:assert/strict"
import { test } from "node:test"
import { compareReports } from "@/lib/report-comparison"
import { comparisonSchema, completionContractSchema } from "@/db/schema"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { ReportComparison } from "@/components/report-comparison"

const current = {
  path: "current.csv",
  requiredColumns: ["date", "amount"],
  minRows: 1,
  dateColumn: "date",
  dateFrom: "2026-10-12",
  dateTo: "2026-10-18",
}
const rule = comparisonSchema.parse({
  baseline: {
    ...current,
    path: "baseline.csv",
    dateFrom: "2026-10-05",
    dateTo: "2026-10-11",
  },
  valueColumn: "amount",
  kind: "percent",
  threshold: "10",
  direction: "any",
  notify: "on_change",
})
const csv = (amount: string, date = "2026-10-12") => `date,amount\n${date},${amount}\n`

test("Exact CSV decimal sum and inclusive percentage threshold, direction and zero baseline decisions", () => {
  const compare = (value: string, baseline = "100") =>
    compareReports(csv(value), csv(baseline, "2026-10-05"), current, rule)
  assert.equal(compare("110").matched, true)
  assert.equal(compare("109.999999").notification.send, false)
  assert.equal(compare("90").matched, true)
  assert.equal(
    compareReports(csv("90"), csv("100", "2026-10-05"), current, {
      ...rule,
      direction: "increase",
    }).matched,
    false
  )
  assert.equal(compare("10", "0").needsAttention, true)
  assert.equal(compare("10", "0").notification.send, true)
  assert.equal(compare("0", "0").notification.send, false)
  assert.equal(compare("-90", "-100").percentChange, "10")
  const exact = compareReports(
    "date,amount\n2026-10-12,0.1\n2026-10-13,0.2\n",
    csv("0.3", "2026-10-05"),
    current,
    { ...rule, kind: "absolute", threshold: "0" }
  )
  assert.equal(exact.delta, "0")
  assert.equal(exact.notification.send, false)
  assert.equal(
    compareReports(csv("0.000002"), csv("0.000001", "2026-10-05"), current, {
      ...rule,
      kind: "absolute",
      threshold: "0.000001",
    }).matched,
    true
  )
})
test("Invalid CSV values, absent baseline, wrong week and invalid conditions cannot produce quiet success", () => {
  for (const value of ["NaN", "", "1e3", "1.0000001", " 1", "Infinity", "0x10"])
    assert.throws(
      () => compareReports(csv(value), csv("100", "2026-10-05"), current, rule),
      /Invalid decimal/
    )
  assert.throws(
    () => compareReports(csv("1", "2026-10-19"), csv("1", "2026-10-05"), current, rule),
    /exceeds/
  )
  assert.throws(() => compareReports(csv("1"), csv("1"), current, rule), /exceeds/)
  assert.throws(
    () =>
      compareReports(
        "date,amount\n",
        "date,amount\n",
        { ...current, minRows: 0 },
        { ...rule, baseline: { ...rule.baseline, minRows: 0 } }
      ),
    /at least one/
  )
  assert.equal(completionContractSchema.safeParse({ comparison: rule }).success, false)
  for (const threshold of ["-1", "NaN", "1e3", "0.0000001"])
    assert.equal(comparisonSchema.safeParse({ ...rule, threshold }).success, false)
})
test("Program comparison UI distinguishes suppression and shows immutable artifact links and scope", () => {
  const comparison = {
    ...compareReports(csv("100"), csv("100", "2026-10-05"), current, rule),
    currentArtifactId: "current",
    baselineArtifactId: "baseline",
  }
  const html = renderToStaticMarkup(
    createElement(ReportComparison, { result: comparison })
  )
  assert.match(html, /程序比较结果/)
  assert.match(html, /保持安静/)
  assert.match(html, /\/api\/artifacts\/baseline/)
  assert.match(html, /未证明下载源数据真实/)
})
