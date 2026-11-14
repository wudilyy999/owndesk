// The lab model gateway: an OpenAI-compatible endpoint the candidate stack uses instead of a
// real provider. It runs in the trusted worker, so the real key never enters the lab. Each
// candidate gets a one-time token; every request is metered on the improvement round, is
// refused once the owner's limit for the improvement or the monthly budget is reached, and
// the token dies with the candidate stack.
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Objective } from "@/db/schema"
import {
  beginAttempt,
  finishAttempt,
  priceFor,
  SEGMENT,
  spendBlock,
} from "@/lib/evolution/meter"
import { getProviderMeta, parseModelSpec } from "@/lib/providers/catalog"
import { getProviderCredentials } from "@/lib/providers/registry"

export const LAB_MODEL = "lab"
const COMPATIBLE = new Set(["custom", "openai", "openrouter", "deepseek", "groq", "xai"])
const BODY_LIMIT = 8 * 1024 * 1024
const PER_MINUTE = 120

export type Gateway = {
  url: string
  token: string
  requests: () => number
  refused: () => number
  close: () => Promise<void>
}

export function gatewaySupports(spec: string) {
  const parsed = parseModelSpec(spec)
  return !!parsed && COMPATIBLE.has(parsed.provider)
}

async function upstream(spec: string) {
  const parsed = parseModelSpec(spec)
  if (!parsed || !COMPATIBLE.has(parsed.provider))
    throw new Error(`实验室网关暂不支持 ${spec}（需要 OpenAI 兼容的服务）`)
  const meta = getProviderMeta(parsed.provider)!
  const { apiKey, baseUrl } = await getProviderCredentials(parsed.provider)
  const base = (baseUrl || meta.defaultBaseUrl).replace(/\/+$/, "")
  if (!base) throw new Error(`${meta.name} 没有配置地址`)
  return { url: `${base}/chat/completions`, apiKey, model: parsed.model }
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error("Request too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

type Usage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}
const toUsage = (usage: Usage | undefined) =>
  usage && typeof usage.prompt_tokens === "number"
    ? {
        input: usage.prompt_tokens,
        output: usage.completion_tokens ?? 0,
        cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      }
    : null

export async function startGateway(input: {
  host: string
  objective: () => Promise<Objective>
  taskId: string
  spec: string
  onBlocked?: (reason: string) => Promise<void>
}): Promise<Gateway> {
  const token = randomBytes(24).toString("base64url")
  const target = await upstream(input.spec)
  const price = await priceFor(input.spec)
  let total = 0
  let refused = 0
  let windowStart = Date.now()
  let windowCount = 0
  const json = (
    res: import("node:http").ServerResponse,
    status: number,
    value: unknown
  ) =>
    res
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(value))
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${token}`)
        return json(res, 401, { error: { message: "Invalid lab token" } })
      const path = (req.url ?? "").replace(/\?.*$/, "")
      if (req.method === "GET" && path.endsWith("/models"))
        return json(res, 200, {
          object: "list",
          data: [{ id: LAB_MODEL, object: "model" }],
        })
      if (req.method !== "POST" || !path.endsWith("/chat/completions"))
        return json(res, 404, {
          error: { message: "Only chat completions are available" },
        })
      if (Date.now() - windowStart > 60000) {
        windowStart = Date.now()
        windowCount = 0
      }
      if (++windowCount > PER_MINUTE) {
        refused++
        return json(res, 429, { error: { message: "Lab rate limit" } })
      }
      const blocked = await spendBlock(await input.objective(), input.spec)
      if (blocked) {
        refused++
        await input.onBlocked?.(blocked)
        return json(res, 402, { error: { message: `实验室额度已用完：${blocked}` } })
      }
      let request: Record<string, unknown>
      try {
        request = JSON.parse(await body(req))
      } catch {
        return json(res, 400, { error: { message: "Bad request body" } })
      }
      request.model = target.model
      if (request.stream) request.stream_options = { include_usage: true }
      total++
      const attempt = await beginAttempt(input.taskId, SEGMENT.gateway, input.spec, price)
      let response: Response
      try {
        response = await fetch(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(300000),
        })
      } catch (error) {
        await finishAttempt(attempt, price, null, `Gateway: ${String(error)}`)
        return json(res, 502, { error: { message: "Upstream unreachable" } })
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "")
        // The provider answered with an error: nothing was generated, nothing billed
        await finishAttempt(
          attempt,
          price,
          { input: 0, output: 0 },
          `HTTP ${response.status}`
        )
        res
          .writeHead(response.status, {
            "Content-Type": response.headers.get("content-type") ?? "application/json",
          })
          .end(text)
        return
      }
      res.writeHead(200, {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      })
      let usage: ReturnType<typeof toUsage> = null
      let pending = ""
      const decoder = new TextDecoder()
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk)
          pending += decoder.decode(chunk, { stream: true })
          if (!request.stream) continue
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data:") || line.includes("[DONE]")) continue
            try {
              usage = toUsage(JSON.parse(line.slice(5)).usage) ?? usage
            } catch {}
          }
        }
        if (!request.stream) usage = toUsage(JSON.parse(pending).usage)
        await finishAttempt(
          attempt,
          price,
          usage,
          usage ? undefined : "No usage reported"
        )
      } catch (error) {
        await finishAttempt(attempt, price, usage, `Gateway stream: ${String(error)}`)
      }
      res.end()
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { error: { message: String(error) } })
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, input.host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${input.host.includes(":") ? `[${input.host}]` : input.host}:${port}/v1`,
    token,
    requests: () => total,
    refused: () => refused,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
