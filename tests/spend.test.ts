import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Usage } from "@/components/usage"
import {
  monthlyBlock,
  priceMutationSchema,
  reconciliationSchema,
  type MonthlyUsage,
} from "@/lib/spend"

const month: MonthlyUsage = {
  month: "2026-10",
  timeZone: "Asia/Taipei",
  startsAt: new Date("2026-09-30T16:00:00Z"),
  endsAt: new Date("2026-10-31T16:00:00Z"),
  budgetMicros: 10000,
  knownCostMicros: "9999",
  unknown: 0,
  pendingPaid: 0,
  attempts: 1,
  legacy: 0,
}
const paid = {
  kind: "priced" as const,
  source: "custom" as const,
  price: { input: 1, output: 2 },
}
test("monthly gate blocks exhausted/unpriced/unknown paid usage; zero pauses paid and local remains available", () => {
  assert.equal(monthlyBlock(month, paid), null)
  assert.match(monthlyBlock({ ...month, knownCostMicros: "10000" }, paid)!, /达到/)
  assert.match(monthlyBlock({ ...month, budgetMicros: 0 }, paid)!, /达到/)
  assert.match(monthlyBlock(month, null)!, /定价/)
  assert.match(monthlyBlock({ ...month, unknown: 1 }, paid)!, /核对/)
  assert.equal(
    monthlyBlock({ ...month, unknown: 4, budgetMicros: 0 }, { kind: "local" }),
    null
  )
  assert.equal(monthlyBlock({ ...month, budgetMicros: null, unknown: 4 }, null), null)
  assert.match(
    monthlyBlock({ ...month, knownCostMicros: "9007199254740993" }, paid)!,
    /达到/
  )
})
test("custom price and manual-cost boundaries reject invalid monetary inputs", () => {
  assert.equal(
    priceMutationSchema.parse({
      model: "custom/test",
      rate: { input: 0, output: 0.5, cached: 0 },
    }).rate?.input,
    0
  )
  assert.throws(() =>
    priceMutationSchema.parse({ model: "custom/test", rate: { input: -1, output: 2 } })
  )
  assert.throws(() =>
    priceMutationSchema.parse({
      model: "custom/test",
      rate: { input: Infinity, output: 2 },
    })
  )
  assert.throws(() =>
    priceMutationSchema.parse({
      model: "custom/test",
      rate: { input: 1, output: 2, typo: 3 },
    })
  )
  assert.throws(() =>
    reconciliationSchema.parse({
      id: "1",
      costMicros: Number.MAX_SAFE_INTEGER + 1,
      note: "too large",
    })
  )
  assert.throws(() => reconciliationSchema.parse({ id: "1", costMicros: 0, note: " " }))
})

test("exhausted monthly budget renders an accessible warning, not a healthy progress state", () => {
  const markup = renderToStaticMarkup(
    createElement(Usage, {
      initial: {
        month: { ...month, budgetMicros: 0, knownCostMicros: "3000000000" },
        prices: {},
        attempts: [],
        models: [],
        hasMore: false,
      },
    })
  )
  assert.match(markup, /role="progressbar"/)
  assert.match(markup, /bg-destructive/)
  assert.match(markup, /新的付费请求已暂停/)
})

test("request timestamps use the owner's timezone and a stable locale across server/browser settings", () => {
  const markup = renderToStaticMarkup(
    createElement(Usage, {
      initial: {
        month: { ...month, timeZone: "UTC" },
        prices: {},
        models: [],
        hasMore: false,
        attempts: [
          {
            id: "1",
            taskId: "task",
            model: "custom/test",
            status: "succeeded",
            attemptNo: 1,
            startedAt: new Date("2026-10-31T16:00:00Z"),
            costMicros: "0",
            reconciledCostMicros: null,
            reconciliationNote: null,
            usage: null,
            legacy: false,
          },
        ],
      },
    })
  )
  assert.match(markup, /2026\/10\/31 16:00:00/)
})
