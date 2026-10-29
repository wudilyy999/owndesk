// Adapted from the pinned MIT upstream provider registry; settings are asynchronous.
import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogle } from "@ai-sdk/google"
import { createGroq } from "@ai-sdk/groq"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createXai } from "@ai-sdk/xai"
import type { LanguageModel } from "ai"
import { createOllama } from "ai-sdk-ollama"

import { getSetting, getSettingSource } from "@/lib/config"
import os from "node:os"
import { env } from "@/lib/env"
import {
  formatModelSpec,
  getProviderMeta,
  parseModelSpec,
  providers,
  type ProviderId,
} from "@/lib/providers/catalog"

export class ModelConfigError extends Error {
  name = "ModelConfigError"
}

export function modelContextWindow(spec: string) {
  const configured = env.PA_CONTEXT_WINDOW_TOKENS
  return parseModelSpec(spec)?.provider === "ollama"
    ? Math.min(configured, os.totalmem() / 1024 ** 3 < 12 ? 16_384 : 32_768)
    : configured
}

export async function getProviderCredentials(id: ProviderId) {
  return {
    apiKey: await getSetting(`provider.${id}.apiKey`),
    baseUrl: await getSetting(`provider.${id}.baseUrl`),
  }
}

// A provider counts as configured once it has what it needs to answer:
// a key for hosted ones, an endpoint for local and custom ones
export async function isProviderConfigured(id: ProviderId) {
  const meta = getProviderMeta(id)
  if (!meta) return false
  const { apiKey, baseUrl } = await getProviderCredentials(id)
  if (meta.requiresKey && !apiKey) return false
  if (meta.requiresBaseUrl && !baseUrl) return false
  // Local servers are enabled only after the owner configures an endpoint
  if (meta.local) {
    const source = await getSettingSource(`provider.${id}.baseUrl`)
    return source === "local" || source === "env"
  }
  return true
}

export async function configuredProviders() {
  const ready = await Promise.all(providers.map((p) => isProviderConfigured(p.id)))
  return providers.filter((_, index) => ready[index])
}

// The model a turn runs on: the agent's own, else the workspace default,
// else the first suggestion of the first configured provider
export async function resolveModelSpec(agentModel?: string | null) {
  if (agentModel) return agentModel
  const fallback = await getSetting("model.default")
  if (fallback) return fallback
  const first = (await configuredProviders()).find((p) => p.suggested.length > 0)
  return first ? formatModelSpec(first.id, first.suggested[0]) : null
}

export async function createModel(
  spec: string,
  credentials?: Awaited<ReturnType<typeof getProviderCredentials>>
): Promise<LanguageModel> {
  const parsed = parseModelSpec(spec)
  if (!parsed) {
    throw new ModelConfigError(
      `"${spec}" is not a supported model provider how to reach. Use provider/model, e.g. openai/gpt-6-luna.`
    )
  }

  const { provider, model, meta } = parsed
  const { apiKey, baseUrl } = credentials ?? (await getProviderCredentials(provider))

  if (meta.requiresKey && !apiKey) {
    throw new ModelConfigError(
      `${meta.name} has no API key. Add ${meta.keyEnv} to .env or paste a key in Settings → Providers.`
    )
  }
  if (meta.requiresBaseUrl && !baseUrl) {
    throw new ModelConfigError(
      `${meta.name} needs an endpoint. Set ${meta.baseUrlEnv} or add one in Settings → Providers.`
    )
  }

  // Only pass an endpoint when it differs from the SDK's own default
  const baseURL = baseUrl && baseUrl !== meta.defaultBaseUrl ? baseUrl : undefined

  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model)
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model)
    case "google":
      return createGoogle({ apiKey, baseURL })(model)
    case "xai":
      return createXai({ apiKey, baseURL })(model)
    case "groq":
      return createGroq({ apiKey, baseURL })(model)
    case "mistral":
      return createMistral({ apiKey, baseURL })(model)
    case "deepseek":
      return createDeepSeek({ apiKey, baseURL })(model)
    case "ollama":
      // Ollama's own API, not its OpenAI-style one: only it takes a context
      // size and keep-alive per request, and images in tool results. The
      // endpoint setting may still carry the OpenAI-style "/v1".
      return createOllama({
        baseURL: (baseUrl || meta.defaultBaseUrl)
          .replace(/\/+$/, "")
          .replace(/\/v1$/, ""),
        apiKey: apiKey || undefined,
      })(model, {
        options: { num_ctx: os.totalmem() / 1024 ** 3 < 12 ? 16_384 : 32_768 },
        keep_alive: "30m",
      })
    case "openrouter":
    case "lmstudio":
    case "custom":
      return createOpenAICompatible({
        name: provider,
        baseURL: baseUrl || meta.defaultBaseUrl,
        apiKey: apiKey || undefined,
        includeUsage: true,
      }).chatModel(model)
  }
}
