// The evaluator (trusted): its code and the frozen tests come from the running version,
// never from the candidate. Stages: 0 policy, 1 build, 2 checks, 3 candidate stack with the
// sanitized snapshot, 4 real end-to-end (core checks + the owner's acceptance checklist,
// judged by an independent reviewer that sees only the checklist and the candidate).
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { generateText, tool, type ModelMessage } from "ai"
import { z } from "zod"
import type { Objective } from "@/db/schema"
import { getSetting, isSecretSetting, settingKeys } from "@/lib/config"
import { docker, dockerRaw } from "@/lib/docker"
import { env } from "@/lib/env"
import { startGateway, LAB_MODEL, type Gateway } from "@/lib/evolution/gateway"
import {
  labExec,
  loadCommit,
  overlayTrustedTests,
  startLab,
  stopLab,
  LAB_LABEL,
} from "@/lib/evolution/lab"
import {
  beginAttempt,
  finishAttempt,
  LabBudgetError,
  priceFor,
  SEGMENT,
  spendBlock,
} from "@/lib/evolution/meter"
import { addedLines, checkChanges, scanAddedLines } from "@/lib/evolution/policy"
import { changedFiles, extract, git, patch } from "@/lib/evolution/repo"
import { sanitizedSeed } from "@/lib/evolution/snapshot"
import type { AcceptanceResult, Evaluation, StageResult } from "@/lib/evolution/store"
import { findPrice } from "@/lib/providers/pricing"
import { getCustomPrices } from "@/lib/spend"
import { createModel } from "@/lib/providers/registry"

type Log = (line: string) => void
const prefix = () => `pa-${env.INSTALL_ID.slice(0, 8)}`

// Every secret value this installation knows, for the leak checks
export async function installationSecrets() {
  const values = new Set<string>()
  for (const name of ["MASTER_KEY", "BETTER_AUTH_SECRET", "VAPID_PRIVATE_KEY"])
    if (process.env[name]) values.add(process.env[name]!)
  try {
    const password = new URL(env.DATABASE_URL).password
    if (password.length >= 8) values.add(decodeURIComponent(password))
  } catch {}
  for (const key of settingKeys)
    if (isSecretSetting(key)) {
      const value = await getSetting(key).catch(() => undefined)
      if (value) values.add(value)
    }
  return [...values].filter((value) => value.length >= 12)
}

async function timed(
  name: StageResult["name"],
  run: () => Promise<Omit<StageResult, "name" | "durationMs">>
): Promise<StageResult> {
  const start = Date.now()
  try {
    return { name, ...(await run()), durationMs: Date.now() - start }
  } catch (error) {
    if (error instanceof LabBudgetError) throw error
    return {
      name,
      status: "fail",
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      durationMs: Date.now() - start,
    }
  }
}

export async function policyStage(baseCommit: string, commit: string) {
  return timed("policy", async () => {
    const files = await changedFiles(baseCommit, commit)
    const findings = checkChanges(files)
    const secrets = scanAddedLines(
      addedLines(await patch(baseCommit, commit, 0)),
      await installationSecrets()
    )
    const problems = [
      ...findings.map((item) => `${item.path ? `${item.path}：` : ""}${item.detail}`),
      ...secrets.map((item) => `${item.path}:${item.line}：疑似密钥（${item.rule}）`),
    ]
    return {
      status: problems.length ? "fail" : "pass",
      detail: problems.length
        ? problems.slice(0, 30).join("\n")
        : `改了 ${files.length} 个文件，符合第一阶段的范围`,
    }
  })
}

// The trusted Dockerfile, with the application build step cut off from the network
export function labDockerfile(trusted: string) {
  return trusted.replace(/^RUN (?=DATABASE_URL=)/m, "RUN --network=none ")
}

export async function buildStage(
  trustedCommit: string,
  commit: string,
  tag: string,
  log: Log
) {
  const images = { web: `owndesk-web:${tag}`, worker: `owndesk-worker:${tag}` }
  const result = await timed("build", async () => {
    const context = await mkdtemp(path.join(os.tmpdir(), "owndesk-cand-build-"))
    try {
      await extract(commit, context)
      const dockerfile = (await git(["show", `${trustedCommit}:Dockerfile`])).toString(
        "utf8"
      )
      await writeFile(path.join(context, "Dockerfile"), labDockerfile(dockerfile))
      await writeFile(
        path.join(context, ".dockerignore"),
        await git(["show", `${trustedCommit}:.dockerignore`])
      )
      for (const [target, image] of Object.entries(images))
        await docker(
          [
            "build",
            "--target",
            target,
            "--build-arg",
            `SOURCE_REVISION=${commit}`,
            "--label",
            `${LAB_LABEL}=${env.INSTALL_ID}`,
            "-t",
            image,
            context,
          ],
          { timeoutMs: 45 * 60_000, maxOutputBytes: 16 * 1024 * 1024, onLine: log }
        )
      return { status: "pass" as const, detail: `镜像 ${images.web}、${images.worker}` }
    } finally {
      await rm(context, { recursive: true, force: true })
    }
  })
  return { result, images }
}

const count = (output: string, name: string) =>
  Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(output)?.[1] ?? NaN)

export async function checksStage(
  labImage: string,
  trustedCommit: string,
  commit: string,
  key: string,
  log: Log
) {
  return timed("checks", async () => {
    const lab = await startLab(labImage, `${key}-checks`)
    try {
      await loadCommit(lab, commit)
      await overlayTrustedTests(lab, trustedCommit)
      const failures: string[] = []
      let counts: { passed: number; total: number } | undefined
      for (const [name, command] of [
        ["typecheck", "npm run typecheck"],
        ["lint", "npm run lint"],
        ["format", "npm run format:check"],
        ["unit", "npm test"],
      ] as const) {
        const result = await labExec(
          lab,
          `${command} > /tmp/${name}.log 2>&1; code=$?; tail -c 6000 /tmp/${name}.log; exit $code`,
          { timeoutMs: 30 * 60_000 }
        )
        log(`checks ${name}: exit ${result.code}`)
        if (name === "unit") {
          const all = await labExec(lab, "cat /tmp/unit.log", {
            maxOutputBytes: 16 * 1024 * 1024,
          })
          const total = count(all.output, "tests")
          const passed = count(all.output, "pass")
          if (Number.isFinite(total)) counts = { passed, total }
        }
        if (result.code !== 0)
          failures.push(`${name} 没通过：\n${result.output.slice(-3000)}`)
      }
      return {
        status: failures.length ? ("fail" as const) : ("pass" as const),
        counts,
        detail: failures.length
          ? failures.join("\n\n")
          : `类型检查、lint、格式、单元测试${counts ? ` ${counts.passed}/${counts.total}` : ""}全部通过`,
      }
    } finally {
      await stopLab(lab)
    }
  })
}

export type CandidateStack = {
  network: string
  containers: { postgres: string; web: string; worker: string }
  webUrl: string
  workerUrl: string
  appUrl: string
  login: { email: string; password: string }
  gateway: Gateway
  agentIds: string[]
}

async function containerIp(name: string, network: string) {
  const { stdout } = await docker([
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    name,
  ])
  return stdout.toString().trim()
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await delay(2000)
  }
  throw new Error(`${what}没有在 ${Math.round(timeoutMs / 1000)} 秒内就绪`)
}

// The worker's own container, when it runs inside the compose deployment
async function selfContainer() {
  if (!env.PA_DEPLOY_DIR) return null
  const result = await dockerRaw(["inspect", "--format", "{{.Id}}", os.hostname()], {
    timeoutMs: 30000,
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

export async function startCandidateStack(input: {
  key: string
  images: { web: string; worker: string }
  objective: () => Promise<Objective>
  taskId: string
  spec: string
  onBlocked: (reason: string) => Promise<void>
  log: Log
}): Promise<CandidateStack> {
  const name = (role: string) => `${prefix()}-cand-${input.key}-${role}`.slice(0, 120)
  const network = name("net")
  await removeCandidateStack(input.key)
  await docker([
    "network",
    "create",
    "--internal",
    "--label",
    `${LAB_LABEL}=${env.INSTALL_ID}`,
    network,
  ])
  const self = await selfContainer()
  if (self) await docker(["network", "connect", network, self])
  const gatewayHost = self
    ? await containerIp(self, network)
    : (
        await docker([
          "network",
          "inspect",
          "--format",
          "{{(index .IPAM.Config 0).Gateway}}",
          network,
        ])
      ).stdout
        .toString()
        .trim()
  const gateway = await startGateway({
    host: gatewayHost,
    objective: input.objective,
    taskId: input.taskId,
    spec: input.spec,
    onBlocked: input.onBlocked,
  })
  const password = randomBytes(18).toString("hex")
  const common = [
    "--detach",
    "--network",
    network,
    "--label",
    `${LAB_LABEL}=${env.INSTALL_ID}`,
    "--label",
    `owndesk.lab.stack=${input.key}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "1536m",
    "--cpus",
    "2",
  ]
  const postgresImage = process.env.PA_POSTGRES_IMAGE || "postgres:16.15-alpine"
  await docker([
    "run",
    ...common.filter((item) => item !== "ALL" && item !== "--cap-drop"),
    "--name",
    name("postgres"),
    "--network-alias",
    "postgres",
    "--env",
    "POSTGRES_USER=agent",
    "--env",
    "POSTGRES_DB=personal_agent",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    postgresImage,
  ])
  await waitFor(
    async () =>
      (
        await dockerRaw(
          ["exec", name("postgres"), "pg_isready", "-U", "agent", "-d", "personal_agent"],
          { timeoutMs: 10000 }
        )
      ).exitCode === 0,
    120000,
    "候选数据库"
  )
  const appUrl = "http://web:6797"
  const application = {
    DATABASE_URL: `postgresql://agent:${password}@postgres:5432/personal_agent`,
    APP_URL: appUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    MASTER_KEY: randomBytes(32).toString("hex"),
    INSTALL_ID: randomUUID(),
    WORKER_INTERNAL_URL: "http://worker:6798",
    ARTIFACT_DIR: "/tmp/artifacts",
    CUSTOM_BASE_URL: gateway.url,
    CUSTOM_API_KEY: gateway.token,
    OWNDESK_DEFAULT_MODEL: `custom/${LAB_MODEL}`,
    OWNDESK_CHAT_MODEL: `custom/${LAB_MODEL}`,
  }
  const envArgs = (extra: Record<string, string> = {}) =>
    Object.entries({ ...application, ...extra }).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ])
  const migrate = await dockerRaw(
    [
      "run",
      "--rm",
      "--network",
      network,
      "--label",
      `${LAB_LABEL}=${env.INSTALL_ID}`,
      ...envArgs(),
      input.images.worker,
      "npm",
      "run",
      "db:migrate",
    ],
    { timeoutMs: 600000, maxOutputBytes: 4 * 1024 * 1024 }
  )
  if (migrate.exitCode !== 0)
    throw new Error(
      `候选数据库迁移失败：${(migrate.stderr || migrate.stdout.toString()).slice(-2000)}`
    )
  const price = findPrice(input.spec, { custom: await getCustomPrices() })
  const seed = await sanitizedSeed({
    labPriceSpec: `custom/${LAB_MODEL}`,
    labPrice: price?.kind === "priced" ? price.price : null,
  })
  const seeded = await dockerRaw(
    [
      "exec",
      "-i",
      name("postgres"),
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-U",
      "agent",
      "-d",
      "personal_agent",
    ],
    { input: seed.sql, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 }
  )
  if (seeded.exitCode !== 0)
    throw new Error(`脱敏快照导入失败：${seeded.stderr.slice(-2000)}`)
  input.log("candidate database seeded with the sanitized snapshot")
  await docker([
    "run",
    ...common,
    "--name",
    name("worker"),
    "--network-alias",
    "worker",
    "--tmpfs",
    "/tmp",
    ...envArgs({ WORKER_HOST: "0.0.0.0", WORKER_PORT: "6798" }),
    input.images.worker,
  ])
  await docker([
    "run",
    ...common,
    "--name",
    name("web"),
    "--network-alias",
    "web",
    "--read-only",
    "--tmpfs",
    "/tmp",
    ...envArgs(),
    input.images.web,
  ])
  const webIp = await containerIp(name("web"), network)
  const workerIp = await containerIp(name("worker"), network)
  const webUrl = `http://${webIp}:6797`
  const workerUrl = `http://${workerIp}:6798`
  await waitFor(
    async () => (await fetch(`${workerUrl}/health`)).ok,
    180000,
    "候选 worker"
  )
  await waitFor(async () => (await fetch(`${webUrl}/login`)).ok, 180000, "候选网页")
  return {
    network,
    containers: { postgres: name("postgres"), web: name("web"), worker: name("worker") },
    webUrl,
    workerUrl,
    appUrl,
    login: seed.login,
    gateway,
    agentIds: seed.agentIds,
  }
}

export async function removeCandidateStack(key: string, gateway?: Gateway) {
  await gateway?.close()
  const ids = (
    await dockerRaw(["ps", "-aq", "--filter", `label=owndesk.lab.stack=${key}`], {
      timeoutMs: 30000,
    })
  ).stdout
    .toString()
    .trim()
  if (ids) await dockerRaw(["rm", "-f", "-v", ...ids.split(/\s+/)], { timeoutMs: 120000 })
  const network = `${prefix()}-cand-${key}-net`.slice(0, 120)
  const self = await selfContainer()
  if (self)
    await dockerRaw(["network", "disconnect", "-f", network, self], { timeoutMs: 30000 })
  await dockerRaw(["network", "rm", network], { timeoutMs: 30000 })
}

// An HTTP session against the candidate web, as its (synthetic) owner
export class CandidateSession {
  cookie = ""
  constructor(readonly stack: CandidateStack) {}
  async request(method: string, route: string, body?: unknown) {
    const response = await fetch(new URL(route, this.stack.webUrl), {
      method,
      headers: {
        Origin: this.stack.appUrl,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(240000),
    })
    const cookies = response.headers.getSetCookie()
    if (cookies.length)
      this.cookie = [
        ...new Map(
          [
            ...this.cookie.split("; ").filter(Boolean),
            ...cookies.map((c) => c.split(";")[0]),
          ].map((pair) => [pair.split("=")[0], pair] as const)
        ).values(),
      ].join("; ")
    return response
  }
  async signIn() {
    const response = await this.request(
      "POST",
      "/api/auth/sign-in/email",
      this.stack.login
    )
    if (!response.ok) throw new Error(`候选登录失败：HTTP ${response.status}`)
  }
}

// Readable text of an HTML page (what the reviewer "sees")
export function pageText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(input|textarea|select|button)\b([^>]*)>/gi, (_, tag, attrs) => {
      const label = /(aria-label|placeholder|name|type|value)="([^"]*)"/gi
      const parts = [...String(attrs).matchAll(label)].map((m) => `${m[1]}=${m[2]}`)
      return ` [${tag} ${parts.join(" ")}] `
    })
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, " [link $1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

// Frozen core end-to-end checks, run against every candidate
export async function coreChecks(stack: CandidateStack, log: Log) {
  const results: { name: string; ok: boolean; detail: string }[] = []
  const check = async (name: string, run: () => Promise<string>) => {
    try {
      results.push({ name, ok: true, detail: await run() })
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    log(`e2e ${name}: ${results.at(-1)!.ok ? "pass" : "fail"}`)
  }
  const session = new CandidateSession(stack)
  await check("登录页可以打开", async () => {
    const response = await session.request("GET", "/login")
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return "200"
  })
  await check("用测试账号登录", async () => {
    await session.signIn()
    return "ok"
  })
  for (const page of [
    "/",
    "/companion",
    "/objectives",
    "/settings",
    "/routines",
    "/versions",
  ])
    await check(`页面 ${page} 正常`, async () => {
      const response = await session.request("GET", page)
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
      return String(response.status)
    })
  await check("worker 健康", async () => {
    const response = await fetch(`${stack.workerUrl}/health`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return "ok"
  })
  await check("伴侣能回复（经实验室网关，合成数据）", async () => {
    const response = await session.request("POST", "/api/companion/chat", {
      text: "你好，用一句话介绍一下你自己。",
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (/event: error/.test(text)) throw new Error(text.slice(0, 500))
    const messages = await session.request("GET", "/api/companion/messages")
    const body = await messages.text()
    if (!messages.ok || !/"role":"assistant"/.test(body))
      throw new Error("没有收到她的回复")
    return "收到回复"
  })
  return { results, session }
}

const reviewerTools = {
  open_page: tool({
    description:
      "Open a page of the candidate web app (path like /companion) and read its visible text.",
    inputSchema: z.object({
      path: z
        .string()
        .regex(/^\/[^\s]*$/)
        .max(300),
    }),
  }),
  call_api: tool({
    description:
      "Call a JSON API of the candidate as the signed-in owner (path starts with /api/).",
    inputSchema: z.object({
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
      path: z
        .string()
        .regex(/^\/api\/[^\s]*$/)
        .max(300),
      body: z.unknown().optional(),
    }),
  }),
  verdict: tool({
    description:
      "Record the verdict for one checklist item after checking it on the candidate.",
    inputSchema: z.object({
      item: z.number().int().min(1),
      status: z.enum(["pass", "fail"]),
      note: z.string().max(600),
    }),
  }),
}

type ReviewInput<K extends keyof typeof reviewerTools> =
  (typeof reviewerTools)[K] extends import("ai").Tool<infer I> ? I : never

// The independent reviewer: sees only the checklist, the changed file names and the
// running candidate; never the reformer's conversation or claims.
export async function reviewAcceptance(input: {
  stack: CandidateStack
  session: CandidateSession
  checklist: string[]
  request: string
  changed: string[]
  objective: () => Promise<Objective>
  taskId: string
  spec: string
  log: Log
}): Promise<AcceptanceResult[]> {
  if (!input.checklist.length) return []
  const model = await createModel(input.spec)
  const price = await priceFor(input.spec)
  const verdicts = new Map<number, AcceptanceResult>()
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        "You are an independent acceptance reviewer for a candidate version of the OwnDesk web app. It runs with synthetic test data only. Check every checklist item yourself on the running candidate, using open_page and call_api, then record a verdict per item. Mark pass only when you saw evidence; otherwise fail with what you saw. Data-changing API calls are fine (test data).",
        `The owner's request: ${input.request}`,
        `Checklist:\n${input.checklist.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        `Files the candidate changed (names only): ${input.changed.join(", ") || "(none)"}`,
      ].join("\n\n"),
    },
  ]
  for (let turn = 0; turn < 30 && verdicts.size < input.checklist.length; turn++) {
    const blocked = await spendBlock(await input.objective(), input.spec)
    if (blocked) throw new LabBudgetError(blocked)
    const attempt = await beginAttempt(input.taskId, SEGMENT.reviewer, input.spec, price)
    let result
    try {
      result = await generateText({
        model,
        messages,
        tools: reviewerTools,
        toolChoice: "required",
        maxRetries: 2,
        abortSignal: AbortSignal.timeout(240000),
      })
    } catch (error) {
      await finishAttempt(attempt, price, null, String(error))
      throw error
    }
    await finishAttempt(attempt, price, {
      input: result.totalUsage.inputTokens ?? 0,
      output: result.totalUsage.outputTokens ?? 0,
      cached: result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
    })
    messages.push(...(result.response.messages as ModelMessage[]))
    const reply: ModelMessage = { role: "tool", content: [] }
    for (const call of result.toolCalls) {
      const args = call.input as Record<string, unknown>
      let output = ""
      try {
        if (call.toolName === "verdict") {
          const value = (
            reviewerTools.verdict.inputSchema as unknown as z.ZodType<
              ReviewInput<"verdict">
            >
          ).parse(args)
          if (value.item <= input.checklist.length)
            verdicts.set(value.item, {
              item: input.checklist[value.item - 1],
              status: value.status,
              note: value.note,
            })
          output = "recorded"
        } else if (call.toolName === "open_page") {
          const { path: route } = (
            reviewerTools.open_page.inputSchema as unknown as z.ZodType<
              ReviewInput<"open_page">
            >
          ).parse(args)
          const response = await input.session.request("GET", route)
          output = `HTTP ${response.status}\n${pageText(await response.text()).slice(0, 12000)}`
        } else {
          const value = (
            reviewerTools.call_api.inputSchema as unknown as z.ZodType<
              ReviewInput<"call_api">
            >
          ).parse(args)
          const response = await input.session.request(
            value.method,
            value.path,
            value.body
          )
          output = `HTTP ${response.status}\n${(await response.text()).slice(0, 12000)}`
        }
      } catch (error) {
        output = `ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
      input.log(`reviewer ${call.toolName}`)
      reply.content.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      })
    }
    if ((reply.content as unknown[]).length) messages.push(reply)
  }
  return input.checklist.map(
    (item, index) =>
      verdicts.get(index + 1) ?? { item, status: "fail", note: "检查员没有给出结论" }
  )
}

// Leak check: the candidate's environment, database and files must hold none of this
// installation's secrets.
export async function leakScan(stack: CandidateStack) {
  const secrets = await installationSecrets()
  const hits: string[] = []
  for (const container of [
    stack.containers.web,
    stack.containers.worker,
    stack.containers.postgres,
  ]) {
    const inspected = (
      await docker(["inspect", "--format", "{{json .Config.Env}}", container])
    ).stdout.toString()
    if (secrets.some((value) => inspected.includes(value)))
      hits.push(`${container} 环境变量`)
  }
  const dump = await dockerRaw(
    [
      "exec",
      stack.containers.postgres,
      "pg_dump",
      "-U",
      "agent",
      "-d",
      "personal_agent",
      "--data-only",
    ],
    { timeoutMs: 120000, maxOutputBytes: 256 * 1024 * 1024 }
  )
  const text = dump.stdout.toString("utf8")
  if (secrets.some((value) => text.includes(value))) hits.push("候选数据库")
  for (const container of [stack.containers.web, stack.containers.worker]) {
    for (const value of secrets) {
      const found = await dockerRaw(
        [
          "exec",
          "-i",
          container,
          "sh",
          "-c",
          "grep -rlF -f /dev/stdin /app /tmp 2>/dev/null | head -1",
        ],
        { input: `${value}\n`, timeoutMs: 120000 }
      )
      if (found.stdout.toString().trim()) hits.push(`${container} 文件`)
    }
  }
  return hits
}

export type EvaluateInput = {
  key: string
  baseCommit: string
  trustedCommit: string
  commit: string
  labImage: string
  checklist: string[]
  request: string
  objective: () => Promise<Objective>
  taskId: string
  spec: string
  onBlocked: (reason: string) => Promise<void>
  log: Log
  // Tests may skip the expensive stages they do not exercise
  stopAfter?: StageResult["name"]
}

export async function evaluate(input: EvaluateInput) {
  const evaluation: Evaluation = {
    suiteRevision: input.trustedCommit,
    stages: [],
    acceptance: [],
    passed: false,
    startedAt: new Date().toISOString(),
  }
  const finish = (images?: { web: string; worker: string }) => {
    evaluation.finishedAt = new Date().toISOString()
    evaluation.passed =
      evaluation.stages.every((stage) => stage.status !== "fail") &&
      evaluation.acceptance.every((item) => item.status === "pass") &&
      evaluation.stages.some((stage) => stage.name === "e2e" && stage.status === "pass")
    return { evaluation, images }
  }
  const skipRest = (from: StageResult["name"][]) => {
    for (const name of from)
      evaluation.stages.push({
        name,
        status: "skip",
        durationMs: 0,
        detail: "前面的关没通过",
      })
  }
  const policy = await policyStage(input.baseCommit, input.commit)
  evaluation.stages.push(policy)
  input.log(`stage policy: ${policy.status}`)
  if (policy.status === "fail" || input.stopAfter === "policy") {
    skipRest(["checks", "build", "stack", "e2e"])
    return finish()
  }
  // Tests first: a candidate that fails them is not worth a multi-minute image build
  const checks = await checksStage(
    input.labImage,
    input.trustedCommit,
    input.commit,
    input.key,
    input.log
  )
  evaluation.stages.push(checks)
  input.log(`stage checks: ${checks.status}`)
  if (checks.status === "fail" || input.stopAfter === "checks") {
    skipRest(["build", "stack", "e2e"])
    return finish()
  }
  const built = await buildStage(input.trustedCommit, input.commit, input.key, input.log)
  evaluation.stages.push(built.result)
  input.log(`stage build: ${built.result.status}`)
  if (built.result.status === "fail") {
    skipRest(["stack", "e2e"])
    return finish()
  }
  let stack: CandidateStack | undefined
  try {
    const stackStage = await timed("stack", async () => {
      stack = await startCandidateStack({
        key: input.key,
        images: built.images,
        objective: input.objective,
        taskId: input.taskId,
        spec: input.spec,
        onBlocked: input.onBlocked,
        log: input.log,
      })
      const leaks = await leakScan(stack)
      if (leaks.length) throw new Error(`候选里发现了本机密钥：${leaks.join("、")}`)
      return {
        status: "pass" as const,
        detail: "候选栈已启动（独立数据库 + 脱敏快照），未发现任何本机密钥",
      }
    })
    evaluation.stages.push(stackStage)
    input.log(`stage stack: ${stackStage.status}`)
    if (stackStage.status === "fail" || !stack) {
      skipRest(["e2e"])
      return finish(built.images)
    }
    const running = stack
    let session: CandidateSession | undefined
    const e2e = await timed("e2e", async () => {
      const core = await coreChecks(running, input.log)
      session = core.session
      const passed = core.results.filter((item) => item.ok).length
      return {
        status: passed === core.results.length ? ("pass" as const) : ("fail" as const),
        counts: { passed, total: core.results.length },
        detail: core.results
          .map(
            (item) =>
              `${item.ok ? "✓" : "✗"} ${item.name}${item.ok ? "" : `：${item.detail}`}`
          )
          .join("\n"),
      }
    })
    evaluation.stages.push(e2e)
    input.log(`stage e2e: ${e2e.status}`)
    if (e2e.status === "pass" && session)
      evaluation.acceptance = await reviewAcceptance({
        stack: running,
        session,
        checklist: input.checklist,
        request: input.request,
        changed: (await changedFiles(input.baseCommit, input.commit)).map(
          (file) => file.path
        ),
        objective: input.objective,
        taskId: input.taskId,
        spec: input.spec,
        log: input.log,
      })
    return finish(built.images)
  } finally {
    await removeCandidateStack(input.key, stack?.gateway)
  }
}
