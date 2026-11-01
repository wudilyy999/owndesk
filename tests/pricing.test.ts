import assert from "node:assert/strict"
import test from "node:test"
import { providers } from "@/lib/providers/catalog"
import { callCost, estimateCost, findPrice } from "@/lib/providers/pricing"

test("DeepSeek models are priced, so a spend cap does not block them", () => {
  for (const spec of [
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
  ])
    assert.equal(findPrice(spec)?.kind, "priced", spec)
})

test("DeepSeek Flash cost uses the cache-hit, cache-miss and output rates", () => {
  const cost = estimateCost("deepseek/deepseek-flash", {
    input: 1_000_000,
    cached: 700_000,
    output: 100_000,
  })
  assert.ok(cost !== null)
  assert.ok(Math.abs(cost - (0.3 * 0.3 + 0.7 * 0.006 + 0.1 * 1.2)) < 1e-9)
})

test("long-context rate applies above the threshold for xAI", () => {
  const price = findPrice("xai/grok-4.7")
  assert.equal(callCost(price, { input: 100_000, output: 0 }), 0.2)
  assert.equal(callCost(price, { input: 300_000, output: 0 }), 1.2)
})

test("OpenRouter passes a maker's price through", () => {
  assert.equal(findPrice("openrouter/google/gemini-3.8-flash")?.kind, "priced")
})

test("every suggested model of every hosted provider has a known price", () => {
  const unpriced = providers
    .filter((p) => !p.local && p.suggested.length)
    .flatMap((p) => p.suggested.map((id) => `${p.id}/${id}`))
    .filter((spec) => findPrice(spec) === null)
  assert.deepEqual(unpriced, [
    "mistral/mistral-medium-latest",
    "mistral/mistral-small-latest",
  ])
})

test("every hosted provider except custom ones suggests at least one model", () => {
  const empty = providers.filter(
    (p) => !p.local && !p.requiresBaseUrl && p.suggested.length === 0
  )
  assert.deepEqual(empty, [])
})
