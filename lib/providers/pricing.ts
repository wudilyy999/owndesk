// What a model costs, for the cost shown under each reply and on the Usage
// page. Client-safe: plain data, no network. Prices are in US dollars per
// million tokens, as published by each provider on 20 October 2026. Local
// models are free; anything not listed shows its tokens and no price until
// one is set in Settings → Usage.

import { parseModelSpec } from "@/lib/providers/catalog"

export const PRICES_AS_OF = "20 October 2026"

export type Rate = {
  input: number
  output: number
  // Input read back from the provider's prompt cache
  cached?: number
}

type Priced = Rate & {
  // Requests with more input tokens than this are billed at `long`
  long?: Rate & { above: number }
}

// Several rows when a published price changes on a known date: each applies
// from its `from` date (inclusive) until the next one
type Entry = Priced | (Priced & { from?: string })[]

const OPENAI_LONG = 272_000
const GEMINI_LONG = 200_000

const catalog: Record<string, Entry> = {
  // OpenAI · developers.openai.com/api/docs/pricing (standard tier)
  "openai/gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "openai/gpt-6-luna": {
    input: 0.1,
    cached: 0.01,
    output: 0.5,
    long: { above: OPENAI_LONG, input: 0.2, cached: 0.02, output: 0.75 },
  },
  "openai/gpt-6-sol": {
    input: 2,
    cached: 0.2,
    output: 10,
    long: { above: OPENAI_LONG, input: 4, cached: 0.4, output: 15 },
  },
  "openai/gpt-6.1-sol": {
    input: 2,
    cached: 0.1,
    output: 10,
    long: { above: OPENAI_LONG, input: 4, cached: 0.2, output: 15 },
  },
  "openai/gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "openai/gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "openai/gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "openai/gpt-5.5": {
    input: 5,
    cached: 0.5,
    output: 30,
    long: { above: OPENAI_LONG, input: 10, cached: 1, output: 45 },
  },
  "openai/gpt-5.5-pro": { input: 30, output: 180 },
  "openai/gpt-5.4": {
    input: 2.5,
    cached: 0.25,
    output: 15,
    long: { above: OPENAI_LONG, input: 5, cached: 0.5, output: 22.5 },
  },
  "openai/gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "openai/gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
  "openai/gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
  "openai/gpt-5.2": { input: 1.75, cached: 0.175, output: 14 },
  "openai/gpt-5.1": { input: 1.25, cached: 0.125, output: 10 },
  "openai/gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "openai/gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "openai/gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "openai/gpt-4.1": { input: 2, cached: 0.5, output: 8 },
  "openai/gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "openai/gpt-4.1-nano": { input: 0.1, cached: 0.025, output: 0.4 },
  "openai/gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  "openai/o3": { input: 2, cached: 0.5, output: 8 },
  "openai/o4-mini": { input: 1.1, cached: 0.275, output: 4.4 },

  // Anthropic · claude.com/pricing
  "anthropic/claude-fable-5-1": { input: 10, cached: 0.25, output: 50 },
  "anthropic/claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
  "anthropic/claude-sonnet-5-5": { input: 2, cached: 0.1, output: 10 },
  "anthropic/claude-haiku-5-5": {
    input: 0.1,
    cached: 0.01,
    output: 0.5,
    long: { above: 100_000, input: 0.5, cached: 0.05, output: 2.5 },
  },
  "anthropic/claude-fable-5": { input: 10, cached: 1, output: 50 },
  "anthropic/claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  "anthropic/claude-sonnet-5": { input: 2, cached: 0.2, output: 10 },
  "anthropic/claude-opus-4-8": { input: 5, cached: 0.5, output: 25 },
  "anthropic/claude-opus-4-7": { input: 5, cached: 0.5, output: 25 },
  "anthropic/claude-opus-4-6": { input: 5, cached: 0.5, output: 25 },
  "anthropic/claude-opus-4-5": { input: 5, cached: 0.5, output: 25 },
  "anthropic/claude-sonnet-4-6": { input: 3, cached: 0.3, output: 15 },
  "anthropic/claude-sonnet-4-5": { input: 3, cached: 0.3, output: 15 },
  "anthropic/claude-haiku-4-5": { input: 1, cached: 0.1, output: 5 },

  // Google · ai.google.dev/gemini-api/docs/pricing (paid tier)
  "google/gemini-4-argon": [
    { input: 2, cached: 0.1, output: 10 },
    { from: "2026-12-01", input: 4, cached: 0.2, output: 20 },
  ],
  "google/gemini-3.8-flash": [
    { input: 0.75, cached: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cached: 0.15, output: 7.5 },
  ],
  "google/gemini-3.6-flash": [
    { input: 0.75, cached: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cached: 0.15, output: 7.5 },
  ],
  "google/gemini-3.5-flash-lite": { input: 0.3, cached: 0.03, output: 2.5 },
  "google/gemini-3.1-flash-lite": { input: 0.25, cached: 0.025, output: 1.5 },
  "google/gemini-3.1-pro-preview": {
    input: 2,
    cached: 0.2,
    output: 12,
    long: { above: GEMINI_LONG, input: 4, cached: 0.4, output: 18 },
  },
  "google/gemini-3-flash-preview": { input: 0.5, cached: 0.05, output: 3 },
  "google/gemini-2.5-pro": {
    input: 1.25,
    cached: 0.125,
    output: 10,
    long: { above: GEMINI_LONG, input: 2.5, cached: 0.25, output: 15 },
  },
  "google/gemini-2.5-flash": { input: 0.3, cached: 0.03, output: 2.5 },
  "google/gemini-2.5-flash-lite": { input: 0.1, cached: 0.01, output: 0.4 },
}

// Prices the person set themselves, by model spec
export type CustomPrices = Record<string, Rate>

export type Price =
  { kind: "local" } | { kind: "priced"; source: "catalog" | "custom"; price: Priced }

function pick(entry: Entry, at: Date): Priced {
  if (!Array.isArray(entry)) return entry
  const day = at.toISOString().slice(0, 10)
  let current = entry[0]
  for (const row of entry) if (!row.from || row.from <= day) current = row
  return current
}

// Ids carry dated snapshots ("claude-sonnet-4-5-20250929", "gpt-4o-2024-08-06")
// and aliases ("-latest") that cost the same as the model they name
function variants(model: string) {
  const out = [model]
  const bare = model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "")
  if (bare !== model) out.push(bare)
  return out
}

function lookup(provider: string, model: string, custom: CustomPrices, at: Date) {
  for (const id of variants(model)) {
    const spec = `${provider}/${id}`
    if (custom[spec]) return { source: "custom" as const, price: custom[spec] }
    if (catalog[spec])
      return { source: "catalog" as const, price: pick(catalog[spec], at) }
  }
  return null
}

export function findPrice(
  spec: string,
  { at = new Date(), custom = {} }: { at?: Date; custom?: CustomPrices } = {}
): Price | null {
  const parsed = parseModelSpec(spec)
  if (!parsed)
    return custom[spec] ? { kind: "priced", source: "custom", price: custom[spec] } : null
  if (parsed.meta.local) return { kind: "local" }

  const own = lookup(parsed.provider, parsed.model, custom, at)
  if (own) return { kind: "priced", ...own }

  // OpenRouter passes most models through at their maker's price:
  // "openrouter/anthropic/claude-sonnet-5.5" costs what claude-sonnet-5-5 does
  if (parsed.provider === "openrouter") {
    const slash = parsed.model.indexOf("/")
    if (slash > 0) {
      const maker = parsed.model.slice(0, slash)
      const model = parsed.model.slice(slash + 1)
      const viaMaker =
        lookup(maker, model, custom, at) ??
        lookup(maker, model.replace(/\./g, "-"), custom, at)
      if (viaMaker) return { kind: "priced", ...viaMaker }
    }
  }
  return null
}

export type CallUsage = {
  input: number
  output: number
  cached?: number
}

// The cost of one model call in dollars, or null when the price is unknown.
// `input` counts every prompt token, cached ones included.
export function callCost(price: Price | null, usage: CallUsage) {
  if (!price) return null
  if (price.kind === "local") return 0
  const { long, ...base } = price.price
  const rate: Rate = long && usage.input > long.above ? long : base
  const cached = Math.min(usage.cached ?? 0, usage.input)
  const fresh = usage.input - cached
  return (
    (fresh * rate.input +
      cached * (rate.cached ?? rate.input) +
      usage.output * rate.output) /
    1_000_000
  )
}

// A whole turn priced from its totals. Calls are assumed the same size, which
// only matters for models with a long-context rate.
export function estimateCost(
  spec: string,
  usage: CallUsage & { calls?: number },
  options?: { at?: Date; custom?: CustomPrices }
) {
  const price = findPrice(spec, options)
  const calls = Math.max(1, usage.calls ?? 1)
  const each = callCost(price, {
    input: usage.input / calls,
    output: usage.output / calls,
    cached: (usage.cached ?? 0) / calls,
  })
  return each === null ? null : each * calls
}

export function isFree(spec: string) {
  return parseModelSpec(spec)?.meta.local === true
}

// "$0.42", "$0.0031", "<$0.0001"
export function formatUsd(usd: number) {
  if (usd === 0) return "$0"
  if (usd < 0.0001) return "<$0.0001"
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, "")}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString("en-US")}`
}

// Money is stored as whole millionths of a dollar
export const toMicros = (usd: number) => Math.round(usd * 1_000_000)
export const fromMicros = (micros: number) => micros / 1_000_000
