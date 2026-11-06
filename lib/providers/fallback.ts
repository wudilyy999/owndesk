// Cross-provider model fallback for BYOK installs. Primary fails (timeout / 5xx /
// network) → try `model.fallback` once. Does not invent a second call for 4xx
// config errors (bad key, unknown model) — those need the owner to fix settings.
import type { LanguageModel } from "ai"
import { getSetting } from "@/lib/config"
import { createModel, ModelConfigError, resolveModelSpec } from "@/lib/providers/registry"
import { parseModelSpec } from "@/lib/providers/catalog"

export type ResolvedModels = {
  primary: string
  fallback: string | null
}

export async function resolveModelChain(
  agentModel?: string | null
): Promise<ResolvedModels> {
  const primary = await resolveModelSpec(agentModel)
  if (!primary) return { primary: "", fallback: null }
  const raw = (await getSetting("model.fallback"))?.trim() || ""
  const fallback = raw && raw !== primary ? raw : null
  return { primary, fallback }
}

export function isRetriableModelError(error: unknown) {
  if (error instanceof ModelConfigError) return false
  const err = error as {
    name?: string
    statusCode?: number
    status?: number
    code?: string
    message?: string
  }
  const status = err.statusCode ?? err.status
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true
    if (status >= 500) return true
    if (status >= 400 && status < 500) return false
  }
  const code = (err.code ?? "").toLowerCase()
  if (
    [
      "etimedout",
      "econnreset",
      "econnrefused",
      "enotfound",
      "und_err_connect_timeout",
    ].includes(code)
  )
    return true
  if (err.name === "TimeoutError" || err.name === "AbortError") return true
  const message = (err.message ?? "").toLowerCase()
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset")
  )
    return true
  // Provider SDK sometimes surfaces transport flakes as AI_APICallError with an
  // empty / "<none>" body and no HTTP status — retry those once via fallback.
  if (
    err.name === "AI_APICallError" &&
    typeof status !== "number" &&
    (!message || message === "<none>" || message === "none")
  )
    return true
  return false
}

export async function createModelWithFallback(
  primarySpec: string,
  fallbackSpec: string | null | undefined
): Promise<{ model: LanguageModel; spec: string; usedFallback: boolean }> {
  try {
    return {
      model: await createModel(primarySpec),
      spec: primarySpec,
      usedFallback: false,
    }
  } catch (error) {
    if (!fallbackSpec || !isRetriableModelError(error)) throw error
    console.error(
      `primary model ${primarySpec} failed (${(error as Error).message}); trying fallback ${fallbackSpec}`
    )
    return {
      model: await createModel(fallbackSpec),
      spec: fallbackSpec,
      usedFallback: true,
    }
  }
}

// Run an async model call; on retriable failure of the primary, recreate on the fallback.
export async function withModelFallback<T>(input: {
  primarySpec: string
  fallbackSpec?: string | null
  run: (model: LanguageModel, spec: string) => Promise<T>
}): Promise<{ result: T; spec: string; usedFallback: boolean }> {
  const { primarySpec, fallbackSpec, run } = input
  try {
    const model = await createModel(primarySpec)
    return {
      result: await run(model, primarySpec),
      spec: primarySpec,
      usedFallback: false,
    }
  } catch (error) {
    if (!fallbackSpec || fallbackSpec === primarySpec || !isRetriableModelError(error))
      throw error
    // Same-provider fallback still useful when the first endpoint/key flakes.
    if (!parseModelSpec(fallbackSpec)) throw error
    console.error(
      `model call on ${primarySpec} failed (${(error as Error).message}); retrying on ${fallbackSpec}`
    )
    const model = await createModel(fallbackSpec)
    return {
      result: await run(model, fallbackSpec),
      spec: fallbackSpec,
      usedFallback: true,
    }
  }
}
