import { ensureRecoveryLab } from "./fixtures/recovery-lab"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises"
import path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { workstationImage } from "./workstation-image"

const focus = process.argv[2] ?? "core"
const paymentRecoveryOnly =
  focus === "paymentsubmit" && process.argv[3] === "lost-receipt"
const paymentEdgesOnly = focus === "paymentsubmit" && process.argv[3] === "edges"
assert(
  process.argv.length <= 4 &&
    (process.argv[3] === undefined || paymentRecoveryOnly || paymentEdgesOnly),
  "Only paymentsubmit accepts a subcase: lost-receipt or edges"
)
assert(
  [
    "core",
    "recovery",
    "cua",
    "memory",
    "memoryrecall",
    "fileinput",
    "connections",
    "automations",
    "demonstrations",
    "crossapps",
    "chat",
    "continuity",
    "ui",
    "usage",
    "routines",
    "reports",
    "vault",
    "vaultfill",
    "identity",
    "payments",
    "paymentdeadline",
    "paymentsubmit",
    "handoff",
    "routinehandoff",
  ].includes(focus),
  `Unknown runtime check: ${focus}`
)
process.loadEnvFile(".env")
// Every runtime case exercises the current controller protocol; the main .env may intentionally pin an older deployment.
process.env.WORKSTATION_IMAGE = workstationImage
const database = `agent_runtime_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
process.env.INSTALL_ID = randomUUID()
process.env.APP_URL = "http://127.0.0.1:17097"
process.env.WORKER_PORT = "17098"
process.env.WORKSTATION_MEMORY_MB = "2048"
process.env.ARTIFACT_DIR = path.join(directory, "artifacts")
process.env.OWNER_EMAIL = "runtime@fixture.test"
process.env.OWNER_PASSWORD = randomUUID()
const testKey = `local-fixture-${randomUUID()}`
const goodCsv = "date,amount\n2026-10-12,100\n2026-10-13,200\n"
const doubledCsv = "date,amount\n2026-10-12,200\n2026-10-13,400\n"
const agents: string[] = [],
  checks: Record<string, unknown>[] = [],
  serverErrors: string[] = []
const vaultPlaintexts: string[] = []
type Scenario = {
  kind: string
  calls: Record<string, any>[]
  pending?: ServerResponse
  release?: () => void
  otherMemoryId?: string
  beforeComplete?: () => Promise<void>
  beforeOpen?: () => Promise<void>
  itemId?: string
  revision?: number
  fillFields?: string[]
  foreignPaymentId?: string
  observed?: any
  targetId?: string
  badTargetId?: string
  handoffRelease?: () => void
  expectedRoster?: string[]
}
const scenarios = new Map<string, Scenario>()
let worker: ChildProcess | undefined,
  round = 0,
  passed = false,
  guestFillTasksEvaluated = 0,
  identityTasksEvaluated = 0,
  paymentTasksEvaluated = 0,
  handoffTasksEvaluated = 0,
  routineHandoffTasksEvaluated = 0
let workerLogSaved = Promise.resolve()
let workerOverrides: Record<string, string> = {}

function answer(
  response: ServerResponse,
  index: number,
  toolName: string,
  input: Record<string, unknown>,
  extra: { name: string; input: Record<string, unknown> }[] = [],
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
) {
  response.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      id: `fixture-${index}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "runtime-fixture",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${index}`,
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(input) },
              },
              ...extra.map((call, i) => ({
                id: `call-${index}-extra-${i}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            ],
          },
        },
      ],
      ...(usage === null ? {} : { usage }),
    })
  )
}
const modelServer = createServer((req, res) => {
  void (async () => {
    assert.equal(req.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      assert(raw.length < 10000000)
    }
    const body = JSON.parse(raw)
    assert.equal(
      req.headers.authorization,
      body.model === "usage-local" ? undefined : `Bearer ${testKey}`
    )
    const awaiting = new Set<string>()
    for (const message of body.messages) {
      if (awaiting.size) {
        assert.equal(
          message.role,
          "tool",
          "All tool results must precede another assistant/user message"
        )
        assert(awaiting.delete(message.tool_call_id), "Unexpected tool result")
      }
      for (const call of message.tool_calls ?? []) awaiting.add(call.id)
    }
    assert.equal(awaiting.size, 0)
    assert(
      !raw.includes(testKey),
      "The key may be an HTTP credential, never a model message"
    )
    for (const value of vaultPlaintexts)
      assert(!raw.includes(value), "Vault value entered model request")
    const latestPrompt = body.messages.findLast(
      (message: any) =>
        message.role === "user" &&
        /CASE=(\w+) RUN=([a-f0-9-]+)/.test(JSON.stringify(message.content))
    )
    const marker = /CASE=(\w+) RUN=([a-f0-9-]+)/.exec(
      JSON.stringify(latestPrompt.content)
    )!
    const scenario = scenarios.get(marker[2])!
    scenario.calls.push(body)
    const index = scenario.calls.length
    if (scenario.kind === "routine_roster") {
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? [])
      const listed = calls.find((call: any) => call.function.name === "list_agents")
      if (!listed) {
        answer(res, index, "list_agents", {})
        return
      }
      const roster = JSON.parse(
        body.messages.find((message: any) => message.tool_call_id === listed.id).content
      )
      assert.deepEqual(
        roster.agents.map((agent: any) => agent.id).sort(),
        [...scenario.expectedRoster!].sort(),
        "Every source/recipient sees only the frozen routine roster"
      )
      const recipient = JSON.stringify(body.messages).includes(
        "Historical handoff from agent "
      )
      if (!recipient && !calls.some((call: any) => call.function.name === "delegate")) {
        answer(res, index, "delegate", {
          agentId: scenario.targetId,
          brief: "Finish this scheduled task using only its frozen delegation roster.",
        })
        return
      }
      if (!recipient) {
        const delegated = calls.find((call: any) => call.function.name === "delegate")
        assert.match(
          body.messages.find((message: any) => message.tool_call_id === delegated.id)
            .content,
          /outside this task's owner-approved delegation roster/
        )
      }
      answer(res, index, "complete_task", {
        summary: recipient ? "Scheduled handoff completed." : "Delegation disabled.",
        files: [],
      })
      return
    }
    if (scenario.kind.startsWith("handoff_")) {
      const calls = body.messages.flatMap((m: any) => m.tool_calls ?? [])
      const latest = calls.at(-1)?.function.name
      const has = (name: string) => calls.some((c: any) => c.function.name === name)
      const note = body.messages
        .filter((m: any) => m.role === "user")
        .map((m: any) =>
          typeof m.content === "string"
            ? m.content
            : m.content.map((p: any) => p.text ?? "").join("\n")
        )
        .find((s: string) => s.startsWith("Historical handoff from agent "))
      if (scenario.kind === "handoff_busy" || scenario.kind === "handoff_followup") {
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
        answer(res, index, "complete_task", {
          summary:
            scenario.kind === "handoff_busy"
              ? "Busy target released."
              : "Earlier delegated report is acknowledged in the original conversation.",
          files: [],
        })
        return
      }
      if (note) {
        const files = JSON.parse(/workstation: (\[[^\n]*\])\n/.exec(note)![1])
        if (!has("fs_read")) {
          answer(res, index, "fs_read", { path: files[0].path })
          return
        }
        if (!has("fs_write")) {
          const readCall = calls.find((c: any) => c.function.name === "fs_read")
          const value = JSON.parse(
            body.messages.find((m: any) => m.tool_call_id === readCall.id).content
          )
          assert.equal(
            value.content,
            goodCsv,
            "Target reads the frozen source bytes, not a changed guest file"
          )
          answer(res, index, "fs_write", { path: "report.csv", content: doubledCsv })
          return
        }
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
        answer(res, index, "complete_task", {
          summary: "Delegated report delivered from the recipient workstation.",
          files: [{ path: "report.csv", mediaType: "text/csv" }],
        })
        return
      }
      if (!calls.length) {
        answer(res, index, "list_agents", {})
        return
      }
      if (scenario.kind === "handoff_normal" && latest === "list_agents") {
        answer(res, index, "ask_user", {
          question: "Which format should the recipient use?",
        })
        return
      }
      if (!has("fs_write")) {
        answer(res, index, "fs_write", { path: "source.csv", content: goodCsv })
        return
      }
      if (scenario.kind === "handoff_invalid") {
        const n = calls.filter((c: any) => c.function.name === "delegate").length
        if (n < 3) {
          answer(res, index, "delegate", {
            agentId:
              n === 0
                ? "missing-agent"
                : n === 1
                  ? scenario.badTargetId
                  : scenario.targetId,
            brief: "Reject invalid target or missing file.",
            files: n === 2 ? [{ path: "missing.csv", mediaType: "text/csv" }] : [],
          })
          return
        }
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
        answer(res, index, "complete_task", {
          summary: "All invalid handoffs were rejected without a new segment.",
          files: [],
        })
        return
      }
      await new Promise<void>((resolve) => {
        scenario.handoffRelease = resolve
      })
      answer(
        res,
        index,
        "delegate",
        {
          agentId: scenario.targetId,
          brief:
            "Read the provided source CSV, double the amounts and deliver report.csv; use the owner's format answer.",
          files: [{ path: "source.csv", mediaType: "text/csv" }],
        },
        [
          {
            name: "fs_write",
            input: { path: "after-delegate.txt", content: "must not run" },
          },
        ]
      )
      return
    }
    if (scenario.kind.startsWith("pay_")) {
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? [])
      const last = (name: string) => {
        const call = calls.findLast((call: any) => call.function.name === name)
        return JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === call.id
          ).content
        )
      }
      const latest = calls.at(-1)?.function.name
      const notes = body.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part: any) => part.text ?? "").join("\n")
        )
      const paymentCalls = calls.filter(
        (call: any) => call.function.name === "request_payment_approval"
      )
      const fillCalls = calls.filter((call: any) => call.function.name === "vault_fill")
      if (index === 1) {
        answer(res, index, "vault_list", {})
        return
      }
      if (latest === "vault_list") {
        await scenario.beforeOpen!()
        answer(res, index, "browser_open", { url: "http://127.0.0.1:8083/?kind=payment" })
        return
      }
      const pageId = last("browser_open").pageId
      if (
        latest === "browser_open" ||
        latest === "request_secret" ||
        (latest === "screen_capture" && !paymentCalls.length && !fillCalls.length)
      ) {
        answer(res, index, "browser_observe", { pageId })
        return
      }
      if (latest === "browser_observe" && !fillCalls.length) {
        const observed = last("browser_observe")
        scenario.observed = observed
        if (
          scenario.kind === "pay_provision" &&
          !notes.some((note: string) => note.includes('"itemId"'))
        ) {
          answer(res, index, "request_secret", {
            kind: "card",
            origin: "http://127.0.0.1:8083",
            reason: "安全提供本次受控测试卡，不在聊天发送卡号。",
          })
          return
        }
        if (scenario.foreignPaymentId) {
          answer(res, index, "vault_fill", {
            itemId: scenario.itemId,
            revision: scenario.revision,
            pageId,
            observationId: observed.observationId,
            paymentRequestId: scenario.foreignPaymentId,
            fields: scenario.fillFields!.map((field) => ({
              field,
              ref: observed.elements.find((element: any) => element.name === field).ref,
            })),
          })
          return
        }
        answer(res, index, "request_payment_approval", {
          merchant: "Fixture Store",
          amount: scenario.kind === "pay_mismatch" ? "USD 11.00" : "USD 12.00",
          purpose: "准备受控网站支付资料；不提交付款。",
          pageId,
          observationId: observed.observationId,
          evidenceRefs: {
            merchant: observed.textRefs.find(
              (element: any) => element.text === "Fixture Store"
            ).ref,
            amount: observed.textRefs.find((element: any) => element.text === "USD 12.00")
              .ref,
          },
        })
        return
      }
      if (
        scenario.kind === "pay_restart" &&
        paymentCalls.length === 1 &&
        notes.some((note: string) => note.includes("Decision: decline."))
      ) {
        answer(res, index, "browser_observe", { pageId })
        return
      }
      const selected = notes.findLast(
        (note: string) => note.includes('"itemId"') && note.includes('"kind"')
      )
      if (selected && !fillCalls.length && paymentCalls.length) {
        const itemId = /"itemId":"([^"]+)"/.exec(selected)![1],
          revision = Number(/"revision":(\d+)/.exec(selected)![1])
        const kind = /"kind":"([^"]+)"/.exec(selected)![1]
        const fields =
          kind === "upi"
            ? ["id"]
            : [
                "number",
                "expiry",
                "expiry_month",
                "expiry_year",
                "expiry_year_short",
                "name",
              ]
        answer(res, index, "vault_fill", {
          itemId,
          revision,
          pageId,
          observationId: scenario.observed.observationId,
          paymentRequestId: last("request_payment_approval").paymentRequestId,
          fields: fields.map((field) => ({
            field,
            ref: scenario.observed.elements.find((element: any) => element.name === field)
              .ref,
          })),
        })
        return
      }
      if (
        latest === "vault_fill" &&
        (scenario.kind === "pay_submit_no_fill" ||
          notes.some((note: string) => note.includes('"stage":"done"')))
      ) {
        answer(res, index, "browser_observe", { pageId })
        return
      }
      if (scenario.kind.startsWith("pay_submit_")) {
        const submits = calls.filter(
          (call: any) => call.function.name === "payment_submit"
        )
        const results = calls.filter(
          (call: any) => call.function.name === "payment_result"
        )
        if (latest === "browser_observe" && !submits.length) {
          const observed = last("browser_observe")
          answer(res, index, "payment_submit", {
            paymentRequestId: last("request_payment_approval").paymentRequestId,
            pageId,
            observationId: observed.observationId,
            ref: observed.elements.find((e: any) => e.name === "Pay USD 12.00").ref,
            evidenceRefs: {
              merchant: observed.textRefs.find((e: any) => e.text === "Fixture Store")
                .ref,
              amount: observed.textRefs.find((e: any) => e.text === "USD 12.00").ref,
            },
          })
          return
        }
        if (
          submits.length &&
          !results.length &&
          notes.some((n: string) => n.includes("Program payment dispatch result:"))
        ) {
          if (latest !== "browser_observe") {
            answer(res, index, "browser_observe", { pageId })
            return
          }
          const observed = last("browser_observe")
          const status = observed.textRefs.find(
            (e: any) => e.text === "Fixture payment recorded"
          )
          const receipt = observed.textRefs.find((e: any) => e.text === "fixture-order-1")
          if (status && receipt) {
            answer(res, index, "payment_result", {
              submissionRequestId: last("payment_submit").submissionRequestId,
              pageId,
              observationId: observed.observationId,
              evidenceRefs: {
                merchant: observed.textRefs.find((e: any) => e.text === "Fixture Store")
                  .ref,
                amount: observed.textRefs.find((e: any) => e.text === "USD 12.00").ref,
                status: status.ref,
                receipt: receipt.ref,
              },
            })
            return
          }
        }
      }
      await new Promise<void>((resolve) => {
        scenario.release = resolve
      })
      answer(res, index, "complete_task", {
        summary: scenario.kind.startsWith("pay_submit_")
          ? "受控付款提交与页面证据已处理；不代表真实扣款或独立核销。"
          : notes.some((note: string) => note.includes("takeoverRequestId"))
            ? "人工接管已交还；手工受控动作与真实付款结果分别核对。"
            : "支付资料准备已明确结束；没有自动提交或声称付款成功。",
        files: [],
      })
      return
    }
    if (scenario.kind.startsWith("fill_")) {
      const identity = scenario.kind.startsWith("fill_identity_")
      const provision =
        scenario.kind === "fill_otp" || scenario.kind === "fill_identity_provision"
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? [])
      const last = (name: string) => {
        const call = calls.findLast((call: any) => call.function.name === name)
        return JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === call.id
          ).content
        )
      }
      const latest = calls.at(-1)?.function.name
      if (index === 1) {
        answer(res, index, "vault_list", {})
        return
      }
      if (latest === "vault_list") {
        await scenario.beforeOpen!()
        answer(res, index, "browser_open", {
          url: `http://127.0.0.1:8083/?kind=${identity ? "identity" : scenario.kind === "fill_otp" ? "code" : "login"}`,
        })
        return
      }
      const pageId = last("browser_open").pageId
      if (
        latest === "browser_open" ||
        latest === "request_secret" ||
        latest === "browser_click" ||
        (provision && latest === "screen_capture")
      ) {
        answer(res, index, "browser_observe", { pageId })
        return
      }
      const notes = body.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part: any) => part.text ?? "").join("\n")
        )
        .join("\n")
      const success = notes.includes('"stage":"done"')
      if (
        latest === "vault_fill" &&
        (success ||
          (scenario.kind === "fill_restart" &&
            calls.filter((call: any) => call.function.name === "vault_fill").length ===
              1))
      ) {
        answer(res, index, "browser_observe", { pageId })
        return
      }
      if (latest === "browser_observe" && !(identity && success)) {
        const observed = last("browser_observe")
        if (!observed.text.includes("Signed in")) {
          if (success) {
            if (calls.some((call: any) => call.function.name === "browser_click")) {
              answer(res, index, "browser_observe", { pageId })
              return
            }
            answer(res, index, "browser_click", {
              pageId,
              observationId: observed.observationId,
              ref: observed.elements.find((element: any) => element.name === "Sign in")
                .ref,
            })
            return
          }
          if (provision && !notes.includes("itemId")) {
            answer(res, index, "request_secret", {
              kind: identity ? "identity" : "code",
              origin: "http://127.0.0.1:8083",
              reason: "提供样本验证码供本次验证。",
            })
            return
          }
          let itemId = scenario.itemId,
            revision = scenario.revision
          if (provision) {
            const note = body.messages.findLast(
              (message: any) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes("itemId")
            )
            const raw =
              typeof note.content === "string"
                ? note.content
                : JSON.stringify(note.content)
            itemId = /"itemId":"([^"]+)"/.exec(raw)![1]
            revision = Number(/"revision":(\d+)/.exec(raw)![1])
          }
          const names =
            scenario.fillFields ??
            (scenario.kind === "fill_otp" ? ["code"] : ["username", "password"])
          answer(res, index, "vault_fill", {
            itemId,
            revision,
            pageId,
            observationId: observed.observationId,
            fields: names.map((field) => ({
              field,
              ref: observed.elements.find(
                (element: any) => element.name?.toLowerCase() === field
              ).ref,
            })),
          })
          return
        }
      }
      await new Promise<void>((resolve) => {
        scenario.release = resolve
      })
      answer(res, index, "complete_task", {
        summary: success
          ? identity
            ? "身份资料已填写；没有提交表单或授权付款。"
            : "受控网站已确认登录；实际填写与程序结果分开核对。"
          : "受控故障已明确处理，没有自动重复填写。",
        files: [],
      })
      return
    }
    if (scenario.kind.startsWith("vault_")) {
      if (index === 1) {
        answer(res, index, "vault_list", {})
        return
      }
      if (index === 2) {
        answer(res, index, "request_secret", {
          kind: scenario.kind === "vault_code" ? "code" : "login",
          origin: "https://vault.fixture.test",
          reason: "安全提供样本凭据，只把条目引用交还任务。",
        })
        return
      }
      await new Promise<void>((resolve) => {
        scenario.release = resolve
      })
      answer(res, index, "complete_task", {
        summary: "凭据引用已收到；没有执行网页填写或付款。",
        files: [],
      })
      return
    }
    if (scenario.kind.startsWith("compare_")) {
      if (scenario.kind === "compare_cancel") {
        scenario.pending = res
        return
      }
      const last = (name: string) => {
        const call = body.messages
          .flatMap((message: any) => message.tool_calls ?? [])
          .findLast((call: any) => call.function.name === name)
        return JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === call.id
          ).content
        )
      }
      if (index === 1) {
        await scenario.beforeOpen!()
        answer(res, index, "browser_open", {
          url: `http://127.0.0.1:8082/?mode=${scenario.kind.slice(8)}`,
        })
        return
      }
      if ([2, 4, 6, 8].includes(index)) {
        answer(res, index, "browser_observe", { pageId: last("browser_open").pageId })
        return
      }
      if ([3, 5, 7, 9].includes(index)) {
        const observed = last("browser_observe"),
          name = ["current-a", "current-b", "baseline-a", "baseline-b"][(index - 3) / 2]
        answer(res, index, "browser_download", {
          pageId: observed.pageId,
          observationId: observed.observationId,
          ref: observed.elements.find((element: any) => element.name === name).ref,
        })
        return
      }
      if (index === 10) {
        const downloadCalls = body.messages
          .flatMap((message: any) => message.tool_calls ?? [])
          .filter((call: any) => call.function.name === "browser_download")
        const paths = downloadCalls.map(
          (call: any) =>
            JSON.parse(
              body.messages.find(
                (message: any) =>
                  message.role === "tool" && message.tool_call_id === call.id
              ).content
            ).path
        )
        answer(res, index, "shell", {
          command: `python3 - <<'PY'\nimport csv\npaths=${JSON.stringify(paths)}\nfor target,inputs in [('report.csv',paths[:2]),('baseline.csv',paths[2:])]:\n with open(target,'w',newline='') as output:\n  writer=csv.writer(output); writer.writerow(['date','site','amount'])\n  for source in inputs:\n   with open(source,newline='') as stream:\n    reader=csv.reader(stream); next(reader); writer.writerows(reader)\nPY`,
        })
        return
      }
      if (index === 11) await scenario.beforeComplete!()
      if (index === 12 && scenario.kind === "compare_missing") {
        assert.match(
          JSON.stringify(body.messages),
          /Deliver the required file: baseline.csv/
        )
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
      }
      answer(res, index, "complete_task", {
        summary:
          scenario.kind === "compare_quiet"
            ? "模型声称发生巨大变化；请以程序比较为准。"
            : "模型声称无变化；请以程序比较为准。",
        files: [
          { path: "report.csv", mediaType: "text/csv" },
          ...(index === 11 && scenario.kind === "compare_missing"
            ? []
            : [{ path: "baseline.csv", mediaType: "text/csv" }]),
        ],
      })
      return
    }
    if (scenario.kind === "routine") {
      answer(res, index, "complete_task", {
        summary: "定时例程受控执行完成。",
        files: [],
      })
      return
    }
    if (scenario.kind.startsWith("usage_")) {
      if (scenario.kind === "usage_hold")
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
      answer(
        res,
        index,
        scenario.kind === "usage_cap" && index === 1 ? "memory_write" : "complete_task",
        scenario.kind === "usage_cap" && index === 1
          ? { note: "Monthly budget fixture rule" }
          : { summary: "Usage fixture completed.", files: [] },
        [],
        scenario.kind === "usage_missing"
          ? null
          : {
              prompt_tokens: scenario.kind === "usage_big" ? 3000000 : 10000,
              completion_tokens: 0,
              total_tokens: scenario.kind === "usage_big" ? 3000000 : 10000,
            }
      )
      return
    }
    if (scenario.kind === "chat_edit") {
      if (index === 1) {
        assert.match(JSON.stringify(body.messages), /已交付通过字段与日期检查的报表/)
        assert.match(
          JSON.stringify(body.messages),
          /workstation path=\/home\/agent\/report.csv/
        )
        assert.equal(
          body.messages.flatMap((message: any) => message.tool_calls ?? []).length,
          0,
          "Previous turn's tool calls and observations must not become live instructions"
        )
        answer(res, index, "fs_read", { path: "report.csv" })
        return
      }
      if (index === 2) {
        assert.match(JSON.stringify(body.messages), /2026-10-13,200/)
        answer(res, index, "fs_write", { path: "report.csv", content: doubledCsv })
        return
      }
      answer(res, index, "complete_task", {
        summary: `已将刚才报表的金额翻倍，原交付文件保持不变。\n\n![private preview](http://127.0.0.1:${port}/must-not-load)\n<script>window.__agentInjected=true</script>`,
        files: [
          { path: "report.csv", name: "report-doubled.csv", mediaType: "text/csv" },
        ],
      })
      return
    }
    if (scenario.kind === "chat_question") {
      if (index === 1) {
        answer(res, index, "ask_user", { question: "追问摘要需要使用哪种语言？" })
        return
      }
      assert.match(JSON.stringify(body.messages), /请用中文摘要 fixture/)
      answer(res, index, "complete_task", {
        summary: "已根据你的中文确认继续整理报表。",
        files: [],
      })
      return
    }
    if (scenario.kind === "chat_after_cancel" || scenario.kind === "chat_short") {
      if (scenario.kind === "chat_after_cancel")
        assert.match(JSON.stringify(body.messages), /earlier task ended cancelled/)
      assert.match(JSON.stringify(body.messages), /请用中文摘要 fixture/)
      answer(res, index, "complete_task", {
        summary: "已读取同一对话的历史上下文。",
        files: [],
      })
      return
    }
    if (scenario.kind === "continuity") {
      if (index === 1) {
        assert.match(raw, /Chinese headings from source chat/)
        await new Promise<void>((resolve) => {
          scenario.release = resolve
        })
        answer(res, index, "fs_write", {
          path: "superseded.txt",
          content: "old decision",
        })
      } else if (index === 2) {
        assert.match(raw, /Use the revised totals/)
        answer(res, index, "load_task_image", { id: scenario.itemId })
      } else if (index === 3) {
        assert.match(raw, /image_url/)
        assert.match(raw, /data:image\/jpeg;base64,/)
        answer(res, index, "fs_write", { path: "report.csv", content: goodCsv })
      } else if (index === 4) {
        answer(res, index, "ask_user", { question: "Confirm the revised total" })
      } else if (index === 5) {
        assert.match(raw, /Use the revised totals/)
        assert.match(raw, /Double the total after restart/)
        assert.match(raw, /owner confirmed total/)
        answer(res, index, "fs_write", { path: "report.csv", content: doubledCsv })
      } else {
        assert.equal(index, 6)
        answer(res, index, "complete_task", {
          summary: "Revised totals delivered",
          files: [{ path: "report.csv", mediaType: "text/csv" }],
        })
      }
      return
    }
    if (scenario.kind === "demonstrations") {
      if (index === 1) answer(res, index, "load_manual", { id: scenario.itemId })
      else if (index === 2) {
        assert.match(raw, /DEMONSTRATED_RESULT/)
        answer(res, index, "fs_write", {
          path: "demonstrated.txt",
          content: "DEMONSTRATED_RESULT",
        })
      } else {
        assert.equal(index, 3)
        answer(res, index, "complete_task", {
          summary: "Applied demonstrated manual",
          files: [{ path: "demonstrated.txt", mediaType: "text/plain" }],
        })
      }
      return
    }
    if (scenario.kind === "automations") {
      assert.match(raw, /trigger value/)
      answer(res, index, "complete_task", {
        summary: "Automation event processed",
        files: [],
      })
      return
    }
    if (scenario.kind === "connections") {
      if (index === 1)
        answer(res, index, "connection_call", {
          connectionId: scenario.itemId,
          tool: "fixture_read",
          args: { query: "runtime" },
        })
      else if (index === 2) {
        assert.match(raw, /Read: runtime/)
        answer(res, index, "connection_call", {
          connectionId: scenario.itemId,
          tool: "fixture_write",
          args: { text: "approved-once" },
        })
      } else if (index === 3) {
        assert.match(
          raw,
          /Written: approved-once/,
          JSON.stringify(
            body.messages
              .filter(
                (message: any) => message.role === "user" || message.role === "tool"
              )
              .map((message: any) => ({
                role: message.role,
                content: JSON.stringify(message.content).slice(0, 1800),
              }))
          )
        )
        answer(res, index, "connection_call", {
          connectionId: scenario.itemId,
          tool: "fixture_write",
          args: { text: "lose-receipt" },
        })
      } else {
        assert.equal(index, 4)
        assert.match(raw, /will not be resent/)
        answer(res, index, "complete_task", {
          summary: "Inspected uncertain service effect; no duplicate send",
          files: [],
        })
      }
      return
    }
    if (scenario.kind === "fileinput") {
      const imported = body.messages.find(
        (message: any) =>
          typeof message.content === "string" &&
          message.content.startsWith("Owner uploaded files copied")
      )?.content
      const files = JSON.parse(/workstation: (\[.*\])\. Read/.exec(imported)![1]) as {
        id: string
        name: string
        path: string
        mediaType: string
      }[]
      const file = (name: string) => files.find((item) => item.name === name)!
      const resultFor = (id: string) =>
        JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === id
          ).content
        )
      if (index === 1)
        answer(res, index, "load_task_image", { id: file("picture.jpg").id })
      else if (index === 2) {
        assert.match(raw, /data:image\/jpeg;base64,/)
        answer(res, index, "shell", {
          timeout: 180,
          command: `set -eu
mkdir -p /home/agent/converted
pdftotext '${file("reference.pdf").path}' /home/agent/converted/reference.txt
libreoffice -env:UserInstallation=file:///tmp/owndesk-file-input --headless --convert-to txt:Text --outdir /home/agent/converted '${file("instructions.docx").path}'
libreoffice -env:UserInstallation=file:///tmp/owndesk-file-input --headless --convert-to csv --outdir /home/agent/converted '${file("totals.xlsx").path}'
python3 - <<'PY'
from pathlib import Path
import csv
assert 'PDF_INPUT_42' in Path('/home/agent/converted/reference.txt').read_text()
assert 'WORD_INPUT_42' in Path('/home/agent/converted/instructions.txt').read_text()
assert list(csv.reader(Path('/home/agent/converted/totals.csv').open()))[0] == ['EXCEL_INPUT','42']
assert list(csv.reader(Path('${file("values.csv").path}').open()))[1] == ['Upload','42']
Path('/home/agent/result.txt').write_text('PDF WORD EXCEL CSV IMAGE: 42')
PY`,
        })
      } else if (index === 3) {
        assert.equal(resultFor("call-2").exitCode, 0)
        answer(res, index, "ask_user", {
          question: "Attach a revised CSV before I finish",
        })
      } else if (index === 4) {
        const message = body.messages.find(
          (message: any) =>
            typeof message.content === "string" &&
            message.content.includes("Attached files on this workstation:")
        )
        const extra = JSON.parse(
          message.content.split("Attached files on this workstation: ")[1]
        )
        answer(res, index, "shell", {
          command: `python3 - <<'PY'
from pathlib import Path
import csv
assert list(csv.reader(Path('${extra[0].path}').open()))[1] == ['Revised','84']
Path('/home/agent/result.txt').write_text('PDF WORD EXCEL CSV IMAGE: 42; revised CSV: 84')
PY`,
        })
      } else {
        assert.equal(index, 5)
        assert.equal(resultFor("call-4").exitCode, 0)
        answer(res, index, "complete_task", {
          summary: "Inputs read and revised total applied",
          files: [{ path: "result.txt", mediaType: "text/plain" }],
        })
      }
      return
    }
    if (scenario.kind === "memoryrecall") {
      const resultFor = (id: string) =>
        JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === id
          ).content
        )
      if (index === 1) {
        assert.match(body.messages[0].content, /Report preferences/)
        assert.doesNotMatch(body.messages[0].content, /Old preference: blue/)
        answer(res, index, "recall_memory", { summaries: true })
      } else if (index === 2) {
        assert.match(JSON.stringify(resultFor("call-1")), /Reports/)
        answer(res, index, "recall_memory", { topic: "Reports", page: 1 })
      } else if (index === 3) {
        assert.equal(resultFor("call-2").pages, 5)
        answer(res, index, "recall_memory", { topic: "Reports", page: 5 })
      } else if (index === 4) {
        assert.match(JSON.stringify(resultFor("call-3")), /Old preference: blue/)
        answer(res, index, "fs_write", { path: "preference.txt", content: "blue" })
      } else if (index === 5) {
        answer(res, index, "ask_user", {
          question: "Ready to apply updated preferences?",
        })
      } else if (index === 6) {
        assert.doesNotMatch(body.messages[0].content, /Recent note 70/)
        assert.match(body.messages[0].content, /Current report preferences/)
        answer(res, index, "recall_memory", { topic: "Reports", page: 1 })
      } else if (index === 7) {
        assert.match(JSON.stringify(resultFor("call-6")), /Current preference: green/)
        answer(res, index, "fs_write", { path: "preference.txt", content: "green" })
      } else {
        assert.equal(index, 8)
        answer(res, index, "complete_task", {
          summary: "Current preferences applied",
          files: [{ path: "preference.txt", mediaType: "text/plain" }],
        })
      }
      return
    }
    if (scenario.kind === "memory") {
      const resultFor = (id: string) =>
        JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === id
          ).content
        )
      if (index === 1) {
        assert.match(JSON.stringify(body.messages), /initial memory fixture/)
        answer(res, index, "memory_write", {
          note: "Remembered then deliberately forgotten fixture",
        })
        return
      }
      if (index === 2) {
        answer(res, index, "memory_forget", { id: scenario.otherMemoryId })
        return
      }
      if (index === 3) {
        assert.match(JSON.stringify(resultFor("call-2")), /belongs to this agent/)
        answer(res, index, "memory_forget", { id: resultFor("call-1").id })
        return
      }
      if (index === 4) {
        assert(resultFor("call-3").forgotten)
        answer(res, index, "memory_write", {
          note: "Future tasks use three Chinese bullet points fixture",
        })
        return
      }
      answer(res, index, "complete_task", {
        summary: "记忆已保存、核对范围并删除过期笔记。",
        files: [],
      })
      return
    }
    if (scenario.kind === "memory_read") {
      assert.match(
        JSON.stringify(body.messages),
        /Future tasks use three Chinese bullet points fixture/
      )
      assert(
        !JSON.stringify(body.messages).includes(
          "Remembered then deliberately forgotten fixture"
        )
      )
      answer(res, index, "complete_task", {
        summary: "已读取上一任务保留的长期偏好。",
        files: [],
      })
      return
    }
    if (scenario.kind === "cancel" || (scenario.kind === "interrupted" && index === 1)) {
      scenario.pending = res
      return
    }
    if (["checkpoint", "cua"].includes(scenario.kind) && index === 1)
      await new Promise<void>((resolve) => {
        scenario.release = resolve
      })
    if (scenario.kind === "cua") {
      const last = (name: string) => {
        const call = body.messages
          .flatMap((message: any) => message.tool_calls ?? [])
          .reverse()
          .find((call: any) => call.function.name === name)
        return JSON.parse(
          body.messages.find(
            (message: any) => message.role === "tool" && message.tool_call_id === call.id
          ).content
        )
      }
      if (index === 1) {
        answer(res, index, "browser_open", { url: "http://127.0.0.1:8081/reports" }, [
          { name: "screen_capture", input: {} },
          { name: "fs_list", input: {} },
        ])
        return
      }
      if (index === 2 || index === 5) {
        if (index === 5) {
          assert.match(JSON.stringify(body.messages), /manual login completed fixture/)
          assert(JSON.stringify(body.messages).includes("image_url"))
        }
        answer(res, index, "browser_observe", { pageId: last("browser_open").pageId })
        return
      }
      if (index === 3) {
        const observed = last("browser_observe")
        answer(res, index, "browser_fill", {
          pageId: observed.pageId,
          observationId: observed.observationId,
          ref: observed.elements.find((element: any) => element.name === "username").ref,
          text: "demo",
        })
        return
      }
      if (index === 4) {
        answer(res, index, "request_takeover", {
          reason: "Please complete fixture login, then hand back control.",
        })
        return
      }
      if (index === 6) {
        const observed = last("browser_observe")
        assert.match(observed.text, /Signed in as demo/)
        answer(res, index, "browser_download", {
          pageId: observed.pageId,
          observationId: observed.observationId,
          ref: observed.elements.find((element: any) => element.name === "Week report")
            .ref,
        })
        return
      }
      if (index === 7) {
        answer(res, index, "fs_read", { path: last("browser_download").path })
        return
      }
      if (index === 8) {
        answer(res, index, "fs_write", {
          path: "report.csv",
          content: last("fs_read").content,
        })
        return
      }
      answer(res, index, "complete_task", {
        summary: "DOM 与人工登录共用浏览器，报表已交付。",
        files: [{ path: "report.csv", mediaType: "text/csv" }],
      })
      return
    }
    if (scenario.kind === "report") {
      if (index === 1) {
        answer(res, index, "fs_write", {
          path: "report.csv",
          content: "wrong,amount\n2026-10-12,100\n",
        })
        return
      }
      if (index === 2) {
        answer(res, index, "complete_task", {
          summary: "Report ready",
          files: [{ path: "report.csv", mediaType: "text/csv" }],
        })
        return
      }
      if (index === 3) {
        assert.match(JSON.stringify(body.messages), /missing required column/)
        answer(res, index, "fs_write", { path: "report.csv", content: goodCsv })
        return
      }
      answer(res, index, "complete_task", {
        summary: "已交付通过字段与日期检查的报表。来源内容仍需业务核实。",
        files: [{ path: "report.csv", mediaType: "text/csv" }],
      })
      return
    }
    if (scenario.kind === "checkpoint" && index === 2)
      assert.match(
        JSON.stringify(body.messages),
        /Control changed|invalidated|Observe again/
      )
    const writeCall = scenario.kind === "checkpoint" ? index <= 2 : index === 2
    answer(
      res,
      index,
      writeCall ? "fs_write" : "complete_task",
      writeCall
        ? { path: "report.csv", content: goodCsv }
        : {
            summary: `Recovered report delivered; ${testKey}`,
            files: [{ path: "report.csv", mediaType: "text/csv" }],
          }
    )
  })().catch((error) => {
    serverErrors.push(error.stack ?? String(error))
    res.writeHead(500).end("fixture failed")
  })
})
modelServer.listen(0, "127.0.0.1")
await once(modelServer, "listening")
const port = (modelServer.address() as { port: number }).port
process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${port}/v1`
process.env.CUSTOM_API_KEY = "env-key-is-overridden"

async function until<T>(
  fn: () => Promise<T | false | undefined>,
  name: string,
  timeout = 75000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (serverErrors.length) throw new Error(serverErrors.join("\n"))
    const result = await fn()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${name}`)
}
async function command(file: string) {
  const child = spawn(process.execPath, ["--import", "tsx", file], { env: process.env })
  let output = ""
  child.stdout!.on("data", (data) => {
    output += data
  })
  child.stderr!.on("data", (data) => {
    output += data
  })
  const [code] = await once(child, "exit")
  await writeFile(path.join(directory, `${path.basename(file)}.log`), output)
  assert.equal(code, 0, output)
}
async function start() {
  let output = ""
  worker = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    env: { ...process.env, ...workerOverrides },
    detached: true,
  })
  worker.stdout!.on("data", (data) => {
    output += data
  })
  worker.stderr!.on("data", (data) => {
    output += data
  })
  const log = path.join(directory, `worker-${++round}.log`)
  workerLogSaved = once(worker, "exit").then(async () => {
    await writeFile(log, output)
  })
  await until(async () => {
    if (worker!.exitCode !== null) throw new Error(output)
    return output.includes("Worker ready")
  }, "worker ready")
}
async function stop(signal: NodeJS.Signals = "SIGKILL") {
  assert(worker?.pid)
  const exited = once(worker, "exit")
  process.kill(-worker.pid, signal)
  await exited
  await workerLogSaved
  worker = undefined
}

try {
  await command("scripts/migrate.ts")
  await command("scripts/owner.ts")
  await ensureRecoveryLab()
  const { db, pool } = await import("@/db")
  const schema = await import("@/db/schema")
  const { setSetting, describeSetting, getSetting, getSettingSource } =
    await import("@/lib/config")
  const { isProviderConfigured } = await import("@/lib/providers/registry")
  const { submitTask, getTask } = await import("@/lib/tasks")
  const { requestCancellation, respondToRequest } = await import("@/lib/task-control")
  const { closeDurableClient } = await import("@/lib/durable")
  const { docker, dockerRaw } = await import("@/lib/docker")
  const { workstationName, viewerName, workstationVolume, displayVolume } =
    await import("@/lib/workstation")
  try {
    await setSetting("provider.custom.apiKey", testKey)
    assert.equal(await getSetting("provider.custom.apiKey"), testKey)
    assert.equal(await getSettingSource("provider.custom.apiKey"), "local")
    assert.equal(
      (await describeSetting("provider.custom.apiKey")).value?.includes(testKey),
      false
    )
    assert.notEqual(
      (await pool.query("SELECT value FROM settings WHERE key='provider.custom.apiKey'"))
        .rows[0].value,
      testKey
    )
    assert.equal(await isProviderConfigured("custom"), true)
    await setSetting(
      "pricing.custom",
      JSON.stringify({ "custom/runtime-fixture": { input: 1, output: 2 } })
    )
    const ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0]
      .user_id as string
    const dockerGatePath = path.join(directory, "docker-gate.json")
    if (paymentEdgesOnly) {
      const native = spawnSync("which", ["docker"], { encoding: "utf8" })
      assert.equal(native.status, 0, native.stderr)
      const bin = path.join(directory, "bin")
      await mkdir(bin)
      await writeFile(dockerGatePath, "null")
      await writeFile(`${dockerGatePath}.ready`, "null")
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      await writeFile(
        path.join(bin, "docker"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/docker-gate.mjs"))} "$@"\n`,
        { mode: 0o700 }
      )
      workerOverrides = {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        PA_TEST_NATIVE_DOCKER: native.stdout.trim(),
        PA_TEST_DOCKER_GATE: dockerGatePath,
      }
    }
    await start()
    async function submit(
      kind: string,
      humanReview = false,
      model = "custom/runtime-fixture",
      prepare?: (scenario: Scenario, agentId: string) => Promise<void>
    ) {
      const run = randomUUID()
      const scenario: Scenario = { kind, calls: [] }
      scenarios.set(run, scenario)
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Runtime fixture",
          role: "Protocol-driven test agent",
          model,
        })
        .returning()
      agents.push(agent.id)
      if (kind === "memory") {
        await db
          .insert(schema.memories)
          .values({ agentId: agent.id, content: "initial memory fixture" })
        const [other] = await db
          .insert(schema.agents)
          .values({ name: "Other memory owner", role: "Isolation fixture" })
          .returning()
        agents.push(other.id)
        const [otherNote] = await db
          .insert(schema.memories)
          .values({ agentId: other.id, content: "Another agent's note" })
          .returning()
        scenario.otherMemoryId = otherNote.id
      }
      if (prepare) await prepare(scenario, agent.id)
      const { taskId } = await submitTask(ownerId, "test", {
        agentId: agent.id,
        ...(kind.startsWith("handoff_")
          ? {
              delegateAgentIds: [
                scenario.targetId!,
                ...(scenario.badTargetId ? [scenario.badTargetId] : []),
              ],
            }
          : {}),
        goal: `CASE=${kind} RUN=${run}; ${kind.startsWith("pay_") ? (kind.startsWith("pay_submit_") ? "Prepare the fixture payment, ask for separate final submission approval, click once and preserve page evidence; never repeat unknown effects or claim independent settlement." : "Prepare only payment details using an approved method; never submit or claim payment succeeded, and do not repeat unknown effects.") : kind.startsWith("fill_") ? "Sign into the controlled site with an approved vault credential; report blocked or unknown effects without repeating them." : "Create and deliver the report."}`,
        clientRequestId: run,
        completionContract: {
          ...(kind === "connections" ||
          kind.startsWith("memory") ||
          ["handoff_busy", "handoff_invalid", "handoff_followup"].includes(kind) ||
          kind.startsWith("usage_") ||
          kind.startsWith("vault_") ||
          kind.startsWith("fill_") ||
          kind.startsWith("pay_")
            ? {}
            : {
                artifact: {
                  path: "report.csv",
                  requiredColumns: ["date", "amount"],
                  minRows: 2,
                  dateColumn: "date",
                  dateFrom: "2026-10-12",
                  dateTo: "2026-10-18",
                },
              }),
          requireHumanReview: humanReview,
        },
        budget: { maxSteps: 20 },
      })
      return { taskId, agentId: agent.id, scenario }
    }
    async function pending(taskId: string, purpose: string) {
      return until(async () => {
        const requests = (await getTask(ownerId, taskId)).requests
        const failure = requests.find(
          (request) =>
            request.status === "pending" && request.payload.purpose === "execution_error"
        )
        if (failure) throw new Error(JSON.stringify(failure.payload))
        return requests.find(
          (request) => request.status === "pending" && request.payload.purpose === purpose
        )
      }, `owner request: ${purpose}`)
    }
    async function completed(taskId: string) {
      return until(async () => {
        const task = await getTask(ownerId, taskId)
        if (
          task.status === "needs_review" &&
          task.requests.some((request) => request.status === "pending")
        )
          throw new Error(JSON.stringify(task.requests))
        return task.status === "completed" ? task : undefined
      }, "task completion")
    }
    if (focus === "routinehandoff") {
      const { eq } = await import("drizzle-orm")
      const { saveRoutine, runRoutineNow, routinePlanSchema, setRoutineEnabled } =
        await import("@/lib/routines")
      await stop("SIGTERM")
      const taskIds: string[] = []
      const probe = await pool.connect()
      try {
        await probe.query("CREATE SCHEMA roster_migration_probe")
        await probe.query("SET search_path=roster_migration_probe")
        await probe.query("CREATE TABLE routines(id text PRIMARY KEY)")
        await probe.query("INSERT INTO routines VALUES('before')")
        await probe.query(await readFile("db/migrations/0014_next_vermin.sql", "utf8"))
        await probe.query("INSERT INTO routines(id) VALUES('after')")
        assert.deepEqual(
          (await probe.query("SELECT delegate_agent_ids FROM routines")).rows,
          [{ delegate_agent_ids: [] }, { delegate_agent_ids: [] }]
        )
        await assert.rejects(
          probe.query("INSERT INTO routines VALUES('null',null)"),
          (error: any) => error.code === "23502"
        )
        await probe.query("RESET search_path")
        await probe.query("DROP SCHEMA roster_migration_probe CASCADE")
      } finally {
        probe.release()
      }
      checks.push({
        check:
          "Unmodified SQL0014 in an isolated schema fills one preexisting row and a new omitted value with []; NOT NULL rejects null. Narrow column migration, not a full upgrade/restore rehearsal.",
      })
      const crew = await db
        .insert(schema.agents)
        .values([
          { name: "例程入口", role: "Scheduled source", model: "custom/runtime-fixture" },
          { name: "报表分析", role: "Frozen recipient", model: "custom/runtime-fixture" },
          { name: "后续接手", role: "Future recipient", model: "custom/runtime-fixture" },
        ])
        .returning()
      agents.push(...crew.map((agent) => agent.id))
      const [source, first, future] = crew
      const marker = randomUUID()
      const initial: Scenario = {
        kind: "routine_roster",
        calls: [],
        targetId: first.id,
        expectedRoster: [first.id],
      }
      scenarios.set(marker, initial)
      const plan = routinePlanSchema.parse({
        name: "例程交接 fixture",
        agentId: source.id,
        prompt: `CASE=routine_roster RUN=${marker} Complete a sequential handoff.`,
        schedule: { kind: "daily", time: "09:00" },
        timeZone: "Asia/Taipei",
        enabled: false,
      })
      assert.deepEqual(plan.delegateAgentIds, [])
      assert.equal(
        routinePlanSchema.safeParse({ ...plan, delegateAgentIds: [""] }).success,
        false
      )
      assert.equal(
        routinePlanSchema.safeParse({
          ...plan,
          delegateAgentIds: Array(33).fill(first.id),
        }).success,
        false
      )
      await assert.rejects(
        saveRoutine({ ...plan, delegateAgentIds: ["missing-agent"] }),
        { status: 400 }
      )
      const fixtureId = (
        await pool.query("SELECT id FROM agents WHERE model='fixture/durable-report'")
      ).rows[0].id
      await assert.rejects(saveRoutine({ ...plan, delegateAgentIds: [fixtureId] }), {
        status: 400,
      })

      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Routine roster Web ready")
        assert.equal((await fetch(`${process.env.APP_URL}/api/routines`)).status, 401)
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          locale: "zh-CN",
          timezoneId: "America/New_York",
        })
        const page = await context.newPage(),
          pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "定时例程", exact: true }).click()
        await page.getByRole("heading", { name: "定时例程", exact: true }).waitFor()
        const roster = page.getByRole("group", {
          name: "本计划允许交接的 Agent（默认关闭）",
          exact: true,
        })
        assert.equal(await roster.locator("input:checked").count(), 0)
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/routines`, {
              headers: { Origin: "https://untrusted.fixture.test" },
              data: { action: "create", input: plan },
            })
          ).status(),
          403
        )
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/routines`, {
              headers: { Origin: process.env.APP_URL! },
              data: {
                action: "create",
                input: { ...plan, delegateAgentIds: ["missing-agent"] },
              },
            })
          ).status(),
          400
        )
        await page.getByLabel("名称", { exact: true }).fill(plan.name)
        await page.getByLabel("执行 Agent", { exact: true }).selectOption(source.id)
        await page.getByLabel("每次要做的工作", { exact: true }).fill(plan.prompt)
        await page.getByLabel("IANA 时区", { exact: true }).fill(plan.timeZone)
        await page.getByLabel("启用计划", { exact: true }).uncheck()
        await roster.getByLabel(first.name, { exact: true }).check()
        await page.getByRole("button", { name: "创建计划", exact: true }).click()
        await page
          .getByRole("button", { name: `编辑 ${plan.name}`, exact: true })
          .waitFor()
        const routine = (
          await db
            .select()
            .from(schema.routines)
            .where(eq(schema.routines.name, plan.name))
        )[0]
        assert.deepEqual(routine.delegateAgentIds, [first.id])
        assert.equal(
          await roster.locator("input:checked").count(),
          0,
          "New draft returns to disabled delegation"
        )
        await page
          .getByRole("button", { name: `立即运行 ${plan.name}`, exact: true })
          .click()
        await page
          .getByText("已受理。工作站忙时等待排队，可在历史中打开任务。", { exact: true })
          .waitFor()
        const accepted = (
          await pool.query(
            "SELECT id,request_key,snapshot FROM routine_runs WHERE routine_id=$1",
            [routine.id]
          )
        ).rows[0]
        assert.deepEqual(accepted.snapshot.input.delegateAgentIds, [first.id])
        await page.getByRole("button", { name: `编辑 ${plan.name}`, exact: true }).click()
        assert.equal(
          await roster.getByLabel(first.name, { exact: true }).isChecked(),
          true
        )
        await roster.getByLabel(first.name, { exact: true }).uncheck()
        await roster.getByLabel(future.name, { exact: true }).check()
        await page.getByRole("button", { name: "保存计划", exact: true }).click()
        await page
          .getByText("计划已保存。已受理的任务继续使用原计划快照。", { exact: true })
          .waitFor()
        let edited = (
          await db
            .select()
            .from(schema.routines)
            .where(eq(schema.routines.id, routine.id))
        )[0]
        assert.equal(edited.planVersion, 2)
        assert.deepEqual(edited.delegateAgentIds, [future.id])
        assert.deepEqual(
          (
            await pool.query("SELECT snapshot FROM routine_runs WHERE id=$1", [
              accepted.id,
            ])
          ).rows[0].snapshot,
          accepted.snapshot
        )
        assert.equal(
          await runRoutineNow(
            ownerId,
            routine.id,
            accepted.request_key.split(":").at(-1),
            1
          ),
          accepted.id
        )
        const toggled = await setRoutineEnabled(routine.id, 2, true)
        assert.deepEqual(toggled.delegateAgentIds, [future.id])
        edited = await setRoutineEnabled(routine.id, 3, false)
        assert.deepEqual(edited.delegateAgentIds, [future.id])
        await start()
        const firstTask = await until(
          async () =>
            (
              await pool.query(
                "SELECT task_id FROM routine_runs WHERE id=$1 AND task_id IS NOT NULL",
                [accepted.id]
              )
            ).rows[0],
          "Original frozen roster task admitted"
        )
        const result = await completed(firstTask.task_id)
        taskIds.push(result.id)
        assert.equal(result.agentId, first.id)
        assert.deepEqual(result.requestPayload.delegateAgentIds, [first.id])
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
              [result.id]
            )
          ).rows[0].n,
          2
        )
        checks.push({
          check:
            "Actual phone form creates an owner-approved roster, manual acceptance freezes it, later edits/toggles and duplicate old-version run leave the accepted payload unchanged; real worker hands off to the original recipient, whose discovery stays on that roster.",
          taskId: result.id,
        })

        const emptyMarker = randomUUID()
        scenarios.set(emptyMarker, {
          kind: "routine_roster",
          calls: [],
          targetId: first.id,
          expectedRoster: [],
        })
        const disabled = await saveRoutine(
          {
            ...plan,
            prompt: `CASE=routine_roster RUN=${emptyMarker} Try an unauthorized handoff.`,
            delegateAgentIds: [],
          },
          routine.id,
          edited.planVersion
        )
        const emptyRun = await runRoutineNow(
          ownerId,
          routine.id,
          emptyMarker,
          disabled.planVersion
        )
        const emptyTask = await until(
          async () =>
            (
              await pool.query(
                "SELECT task_id FROM routine_runs WHERE id=$1 AND task_id IS NOT NULL",
                [emptyRun]
              )
            ).rows[0],
          "Empty roster task admitted"
        )
        const denied = await completed(emptyTask.task_id)
        taskIds.push(denied.id)
        assert.equal(denied.agentId, source.id)
        assert.equal(denied.requestPayload.delegateAgentIds, undefined)
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
              [denied.id]
            )
          ).rows[0].n,
          1
        )
        checks.push({
          check:
            "A new empty-roster run preserves omission, exposes no agents and rejects an actual delegate call; it cannot inherit the preceding run's permission or create a recipient segment.",
          taskId: denied.id,
        })

        const scheduledMarker = randomUUID()
        scenarios.set(scheduledMarker, {
          kind: "routine_roster",
          calls: [],
          targetId: future.id,
          expectedRoster: [future.id],
        })
        const scheduled = await saveRoutine(
          {
            ...plan,
            prompt: `CASE=routine_roster RUN=${scheduledMarker} Scheduled roster handoff.`,
            delegateAgentIds: [future.id],
            enabled: true,
            schedule: { kind: "once", at: "2090-10-24T09:00" },
          },
          routine.id,
          disabled.planVersion
        )
        const local = new Date(Date.now() - 1000).toISOString().slice(0, 16)
        await db
          .update(schema.routines)
          .set({
            timeZone: "UTC",
            schedule: { kind: "once", at: local },
            nextRunAt: new Date(`${local}:00Z`),
          })
          .where(eq(schema.routines.id, scheduled.id))
        const timed = await until(
          async () =>
            (
              await pool.query(
                "SELECT task_id,snapshot FROM routine_runs WHERE routine_id=$1 AND trigger='schedule' AND task_id IS NOT NULL",
                [routine.id]
              )
            ).rows[0],
          "Actual DBOS timer accepts scheduled roster"
        )
        assert.deepEqual(timed.snapshot.input.delegateAgentIds, [future.id])
        const scheduledResult = await completed(timed.task_id)
        taskIds.push(scheduledResult.id)
        assert.equal(scheduledResult.agentId, future.id)
        assert.equal(
          (await pool.query("SELECT enabled FROM routines WHERE id=$1", [routine.id]))
            .rows[0].enabled,
          false
        )
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
              [scheduledResult.id]
            )
          ).rows[0].n,
          2
        )
        await until(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM routine_runs WHERE routine_id=$1 AND status='ok'",
                [routine.id]
              )
            ).rows[0].n === 3,
          "All three real routine outcomes synchronized"
        )
        await page.getByRole("button", { name: "刷新状态", exact: true }).click()
        await page
          .getByRole("region", { name: "运行历史", exact: true })
          .getByText("已完成", { exact: true })
          .first()
          .waitFor()
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.screenshot({
          path: path.join(directory, "routine-roster-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "routine-roster-desktop.png"),
          fullPage: true,
        })
        assert.deepEqual(pageErrors, [])
        routineHandoffTasksEvaluated = taskIds.length
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
          3
        )
        checks.push({
          check:
            "Actual DBOS timed once trigger uses the current roster and hands off to its new recipient; all three real tasks completed, two with new segments and one with denied delegation. Mobile/desktop history, no overflow and no browser errors.",
          taskIds,
          taskCount: taskIds.length,
        })
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "routine-roster-web.log"), webLog)
      }
    }
    if (focus === "handoff") {
      const { eq } = await import("drizzle-orm")
      const { executeDelegate } = await import("@/worker/delegation")
      const { executeAction } = await import("@/worker/actions")
      const { executeMemoryTool } = await import("@/worker/memory")
      const { createTaskRequest } = await import("@/worker/requests")
      const { SegmentSuperseded, workspaceRow } = await import("@/lib/workstation")
      const taskIds: string[] = []
      async function recipient() {
        const [agent] = await db
          .insert(schema.agents)
          .values({
            name: "Recipient",
            role: "Analyze transferred CSV",
            model: "custom/runtime-fixture",
            instructions: "recipient-standing-order-before-freeze",
          })
          .returning()
        agents.push(agent.id)
        await db
          .insert(schema.memories)
          .values({ agentId: agent.id, content: "recipient-memory-before-freeze" })
        return agent.id
      }
      async function begin(kind: string, targetId?: string) {
        const run = await submit(
          `handoff_${kind}`,
          false,
          "custom/runtime-fixture",
          async (scenario, id) => {
            scenario.targetId = kind === "same" ? id : (targetId ?? (await recipient()))
            if (kind === "invalid") {
              const [bad] = await db
                .insert(schema.agents)
                .values({
                  name: "Unconfigured",
                  role: "Reject invalid provider",
                  model: "anthropic/not-configured",
                })
                .returning()
              agents.push(bad.id)
              scenario.badTargetId = bad.id
            }
          }
        )
        taskIds.push(run.taskId)
        if (kind === "normal") {
          const question = await pending(run.taskId, "question")
          await respondToRequest(ownerId, question.id, "approve", 1, {
            answer: "Use CSV",
          })
        }
        await until(
          async () =>
            !!(kind === "invalid" ? run.scenario.release : run.scenario.handoffRelease),
          `source ready: ${kind}`
        )
        const [sourceTask] = await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, run.taskId))
        return { ...run, sourceTask }
      }
      async function busyTarget(agentId: string) {
        const key = randomUUID(),
          scenario: Scenario = { kind: "handoff_busy", calls: [] }
        scenarios.set(key, scenario)
        const result = await submitTask(ownerId, "test", {
          agentId,
          goal: `CASE=handoff_busy RUN=${key}; hold the target workstation`,
          clientRequestId: key,
          completionContract: { requireHumanReview: false },
          budget: { maxSteps: 10 },
        })
        taskIds.push(result.taskId)
        await until(
          async () => !!scenario.release,
          "actual target task holds its model request"
        )
        return { ...result, agentId, scenario }
      }
      async function finishRun(run: Awaited<ReturnType<typeof submit>>) {
        await until(async () => !!run.scenario.release, "recipient result reaches model")
        run.scenario.release!()
        return completed(run.taskId)
      }
      async function stopRun(taskId: string) {
        const rows = (
          await pool.query(
            "SELECT DISTINCT agent_id FROM task_segments WHERE task_id=$1",
            [taskId]
          )
        ).rows
        for (const row of rows)
          for (const name of [viewerName(row.agent_id), workstationName(row.agent_id)]) {
            const state = await dockerRaw(["inspect", name])
            if (
              state.exitCode === 0 &&
              JSON.parse(state.stdout.toString())[0].State.Running
            )
              await docker(["stop", name])
          }
      }
      async function assertFinal(run: Awaited<ReturnType<typeof begin>>) {
        const result = await finishRun(run)
        assert.equal(result.activeSegment, 2)
        assert.equal(result.agentId, run.scenario.targetId)
        assert.equal(result.conversationAgentId, run.agentId)
        assert.equal(result.segments.length, 2)
        const final = (result.result!.files as any[])[0]
        assert.equal(
          await readFile(
            path.join(process.env.ARTIFACT_DIR!, run.taskId, final.id),
            "utf8"
          ),
          doubledCsv
        )
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND type='delegated'",
              [run.taskId]
            )
          ).rows[0].n,
          1
        )
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_actions WHERE task_id=$1 AND input->>'path'='after-delegate.txt'",
              [run.taskId]
            )
          ).rows[0].n,
          0
        )
        return result
      }
      const target = await recipient(),
        busy = await busyTarget(target),
        normal = await begin("normal", target)
      const denied = await executeDelegate(
        normal.sourceTask,
        1,
        902,
        { agentId: normal.agentId, brief: "Outside the task roster", files: [] },
        0
      )
      assert.equal(denied.ok, false)
      assert.match(JSON.stringify(denied.output), /owner-approved delegation roster/)
      const listed = normal.scenario.calls[1].messages.find((m: any) => m.role === "tool")
      assert(
        listed.content.includes(target) && !listed.content.includes(normal.agentId),
        "list_agents is scoped to the owner-approved roster"
      )
      normal.scenario.handoffRelease!()
      await until(
        async () => (await getTask(ownerId, normal.taskId)).activeSegment === 2,
        "handoff transaction commits"
      )
      let detail = await getTask(ownerId, normal.taskId)
      assert.equal(detail.status, "queued")
      assert.equal(detail.result, null)
      assert.equal((await workspaceRow(target)).activeTaskId, busy.taskId)
      assert.equal((await workspaceRow(normal.agentId)).activeTaskId, null)
      const queue = (
        await pool.query(
          "SELECT queue_name,queue_partition_key,application_version FROM dbos.workflow_status WHERE workflow_uuid=$1",
          [`${normal.taskId}:2`]
        )
      ).rows[0]
      assert.equal(queue.queue_partition_key, target)
      assert.equal(queue.application_version, "0.13.0-dev")
      await db
        .update(schema.agents)
        .set({
          name: "Edited after acceptance",
          instructions: "must-not-replace-frozen-order",
          model: "anthropic/not-configured",
        })
        .where(eq(schema.agents.id, target))
      await db
        .update(schema.memories)
        .set({ content: "must-not-replace-frozen-memory" })
        .where(eq(schema.memories.agentId, target))
      await docker([
        "exec",
        workstationName(normal.agentId),
        "sh",
        "-c",
        "printf 'changed after host copy' > /home/agent/source.csv",
      ])
      const prepared = (
        await pool.query(
          "SELECT payload FROM task_events WHERE task_id=$1 AND type='handoff_prepared'",
          [normal.taskId]
        )
      ).rows[0].payload
      const replay = await executeDelegate(
        normal.sourceTask,
        1,
        prepared.handoff.actionNo,
        prepared.handoff.input,
        0
      )
      assert("delegated" in replay && replay.delegated)
      await assert.rejects(
        executeDelegate(
          normal.sourceTask,
          1,
          prepared.handoff.actionNo,
          { ...prepared.handoff.input, brief: "different" },
          0
        ),
        /different parameters/
      )
      await assert.rejects(
        executeAction(
          normal.taskId,
          1,
          900,
          "fs_write",
          { path: "stale.txt", content: "stale" },
          0
        ),
        SegmentSuperseded
      )
      await assert.rejects(
        executeMemoryTool(
          normal.taskId,
          1,
          901,
          "memory_write",
          { note: "stale mutation" },
          0
        ),
        SegmentSuperseded
      )
      await assert.rejects(
        createTaskRequest(normal.taskId, 1, "stale-request", "approval", {
          purpose: "question",
          question: "stale",
        }),
        SegmentSuperseded
      )
      const oldQuestion = detail.requests.find((r) => r.payload.purpose === "question")!
      await assert.rejects(
        respondToRequest(ownerId, oldQuestion.id, "approve", 1, { answer: "Use CSV" }),
        /earlier task segment/
      )
      busy.scenario.release!()
      await completed(busy.taskId)
      await until(
        async () => !!normal.scenario.release,
        "recipient uses frozen config and file"
      )
      const targetCall = normal.scenario.calls.find((c) =>
        JSON.stringify(c.messages).includes("Historical handoff from agent")
      )!
      assert.equal(targetCall.model, "runtime-fixture")
      const messages = JSON.stringify(targetCall.messages)
      assert(
        messages.includes("recipient-standing-order-before-freeze") &&
          messages.includes("recipient-memory-before-freeze") &&
          messages.includes("Use CSV")
      )
      assert(!messages.includes("must-not-replace-frozen"))
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (d) => (webLog += d))
      web.stderr!.on("data", (d) => (webLog += d))
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (e) {
            if ((e as any).cause?.code === "ECONNREFUSED") return false
            throw e
          }
        }, "handoff Web ready")
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          }),
          page = await context.newPage(),
          errors: string[] = []
        page.on("pageerror", (e) => errors.push(e.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).waitFor()
        await page.goto(`${process.env.APP_URL}/?task=${normal.taskId}`)
        await page
          .getByLabel("Agent 交接记录")
          .getByText("交接说明：", { exact: false })
          .waitFor()
        assert.equal(
          await page.getByRole("combobox").first().inputValue(),
          normal.agentId
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page
          .getByLabel("对话记录")
          .getByRole("heading", { name: /CASE=handoff_normal/ })
          .waitFor()
        await page.getByText("本轮允许交接的 Agent（默认关闭）", { exact: true }).click()
        assert.equal(
          await page
            .getByLabel("允许交接给 Edited after acceptance", { exact: true })
            .isChecked(),
          false
        )
        await page
          .getByLabel("允许交接给 Edited after acceptance", { exact: true })
          .check()
        assert.equal(
          await page
            .getByLabel("允许交接给 Edited after acceptance", { exact: true })
            .isChecked(),
          true
        )
        await page.screenshot({
          path: path.join(directory, "handoff-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "handoff-desktop.png"),
          fullPage: true,
        })
        await assertFinal(normal)
        const followKey = randomUUID(),
          scenario: Scenario = { kind: "handoff_followup", calls: [] }
        scenarios.set(followKey, scenario)
        await page.getByRole("button", { name: "发送追问", exact: true }).waitFor()
        const accepted = page.waitForResponse(
          (r) =>
            r.url() === `${process.env.APP_URL}/api/tasks` &&
            r.request().method() === "POST"
        )
        await page
          .getByLabel("继续对话", { exact: true })
          .fill(
            `CASE=handoff_followup RUN=${followKey}; summarize the previous delegated result`
          )
        await page.getByRole("button", { name: "发送追问", exact: true }).click()
        const received = await accepted
        assert.equal(received.status(), 202)
        const submitted = received.request().postDataJSON()
        assert.deepEqual(submitted.delegateAgentIds, [target])
        assert.equal(submitted.threadId, detail.threadId)
        const follow = await received.json()
        await until(
          async () =>
            !(await page
              .getByLabel("允许交接给 Edited after acceptance", { exact: true })
              .isChecked()),
          "roster selection cleared after explicit task submission"
        )
        taskIds.push(follow.taskId)
        await until(
          async () => !!scenario.release,
          "follow-up stays in the original conversation"
        )
        assert(
          JSON.stringify(scenario.calls[0].messages).includes(
            "Delegated report delivered from the recipient workstation."
          )
        )
        scenario.release!()
        await completed(follow.taskId)
        await page.goto(`${process.env.APP_URL}/?task=${normal.taskId}`)
        await page.getByLabel("Agent 交接记录").waitFor()
        assert.equal(
          await page.getByRole("combobox").first().inputValue(),
          normal.agentId
        )
        assert.deepEqual(errors, [])
      } finally {
        await browser?.close()
        if (web.exitCode === null && web.pid) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "web.log"), webLog)
      }
      await stopRun(normal.taskId)
      checks.push({
        check:
          "Busy target uses its real partition; source released, task stays queued, immutable target config/memory and host file survive edits; byte-checked recipient delivery, owner-answer context, stale segment APIs denied, idempotent handoff, no later source batch action; actual phone/desktop UI and original-thread follow-up",
        taskIds: [busy.taskId, normal.taskId, taskIds.at(-1)],
        queue,
      })

      const same = await begin("same")
      same.scenario.handoffRelease!()
      await assertFinal(same)
      await stopRun(same.taskId)
      checks.push({
        check:
          "Same-workstation handoff creates a new queued segment after the old workflow returns; one shared task and file transfer",
        taskId: same.taskId,
      })
      const invalid = await begin("invalid")
      assert.equal((await getTask(ownerId, invalid.taskId)).activeSegment, 1)
      assert.equal((await getTask(ownerId, invalid.taskId)).segments.length, 1)
      assert.match(
        JSON.stringify(invalid.scenario.calls.at(-1)!.messages),
        /File not found/
      )
      await finishRun(invalid)
      await stopRun(invalid.taskId)
      checks.push({
        check:
          "Missing agent, unconfigured target model and missing source file all reject before a next segment is created",
        taskId: invalid.taskId,
      })

      for (const window of ["before_commit", "after_commit"]) {
        const run = await begin(window),
          lock = await pool.connect()
        const sourceCalls = run.scenario.calls.length
        try {
          await lock.query("SELECT pg_advisory_lock(20261025,1313)")
          await pool.query(
            `CREATE FUNCTION fixture_handoff_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${run.taskId}' AND NEW.segment_no=2 THEN PERFORM pg_advisory_xact_lock(20261025,1313); END IF; RETURN NEW; END $$`
          )
          await pool.query(
            "CREATE TRIGGER fixture_handoff_hold BEFORE INSERT ON task_segments FOR EACH ROW EXECUTE FUNCTION fixture_handoff_hold()"
          )
          run.scenario.handoffRelease!()
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
                )
              ).rowCount! > 0,
            "source released before next-segment transaction commits"
          )
          assert.equal((await workspaceRow(run.agentId)).activeTaskId, null)
          assert.equal((await getTask(ownerId, run.taskId)).activeSegment, 1)
          if (window === "after_commit") {
            await lock.query("BEGIN")
            await lock.query("LOCK TABLE dbos.operation_outputs IN SHARE MODE")
            await lock.query("SELECT pg_advisory_unlock(20261025,1313)")
            await until(
              async () => (await getTask(ownerId, run.taskId)).activeSegment === 2,
              "handoff business transaction commits before framework checkpoint"
            )
            assert.equal(run.scenario.calls.length, sourceCalls)
          }
          await stop()
        } finally {
          if (window === "after_commit") await lock.query("ROLLBACK")
          await lock.query("SELECT pg_advisory_unlock(20261025,1313)")
          lock.release()
          await pool.query(
            "DROP TRIGGER IF EXISTS fixture_handoff_hold ON task_segments; DROP FUNCTION IF EXISTS fixture_handoff_hold()"
          )
        }
        await start()
        await assertFinal(run)
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM task_model_decisions WHERE task_id=$1 AND segment_no=1",
              [run.taskId]
            )
          ).rows[0].n,
          3
        )
        await stopRun(run.taskId)
        checks.push({
          check: `Actual SIGKILL at ${window}: prepared handoff resumes without source model regeneration, duplicate segment/enqueue or premature task completion`,
          taskId: run.taskId,
        })
      }
      const budget = await begin("budget")
      await pool.query(
        "UPDATE tasks SET budget=jsonb_set(budget,'{maxSteps}','3'::jsonb) WHERE id=$1",
        [budget.taskId]
      )
      budget.scenario.handoffRelease!()
      const limit = await pending(budget.taskId, "limits")
      assert.equal(
        budget.scenario.calls.length,
        3,
        "new segment does not reset the three-decision task allowance"
      )
      assert.equal((await getTask(ownerId, budget.taskId)).activeSegment, 2)
      await respondToRequest(ownerId, limit.id, "continue", 1, {
        budget: { maxSteps: 20 },
      })
      await assertFinal(budget)
      await stopRun(budget.taskId)
      checks.push({
        check:
          "Total model-step budget remains consumed across delegation; next agent waits before any model request, explicit owner increase resumes it",
        taskId: budget.taskId,
      })

      const cancelTarget = await recipient(),
        busy2 = await busyTarget(cancelTarget),
        queued = await begin("queued_cancel", cancelTarget)
      queued.scenario.handoffRelease!()
      await until(
        async () => (await getTask(ownerId, queued.taskId)).activeSegment === 2,
        "recipient queued behind a different real task"
      )
      await requestCancellation(ownerId, queued.taskId)
      await until(
        async () => (await getTask(ownerId, queued.taskId)).status === "cancelled",
        "queued handoff actually cancels"
      )
      assert.equal((await workspaceRow(cancelTarget)).activeTaskId, busy2.taskId)
      busy2.scenario.release!()
      await completed(busy2.taskId)
      assert.equal(queued.scenario.calls.length, 3)
      await stopRun(queued.taskId)
      checks.push({
        check:
          "Cancelling a queued recipient segment leaves the target's different active task intact and never calls the recipient model",
        taskIds: [queued.taskId, busy2.taskId],
      })

      const cancelled = await begin("cancel_before_commit"),
        lock = await pool.connect()
      try {
        await lock.query("SELECT pg_advisory_lock(20261025,1313)")
        await pool.query(
          `CREATE FUNCTION fixture_handoff_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${cancelled.taskId}' AND NEW.segment_no=2 THEN PERFORM pg_advisory_xact_lock(20261025,1313); END IF; RETURN NEW; END $$`
        )
        await pool.query(
          "CREATE TRIGGER fixture_handoff_cancel BEFORE INSERT ON task_segments FOR EACH ROW EXECUTE FUNCTION fixture_handoff_cancel()"
        )
        cancelled.scenario.handoffRelease!()
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
              )
            ).rowCount! > 0,
          "cancel window after source release"
        )
        await stop()
      } finally {
        await lock.query("SELECT pg_advisory_unlock(20261025,1313)")
        lock.release()
        await pool.query(
          "DROP TRIGGER IF EXISTS fixture_handoff_cancel ON task_segments; DROP FUNCTION IF EXISTS fixture_handoff_cancel()"
        )
      }
      await requestCancellation(ownerId, cancelled.taskId)
      await start()
      await until(
        async () => (await getTask(ownerId, cancelled.taskId)).status === "cancelled",
        "cancellation during source-release recovery prevents target enqueue"
      )
      assert.equal((await getTask(ownerId, cancelled.taskId)).segments.length, 1)
      assert.equal(cancelled.scenario.calls.length, 3)
      await stopRun(cancelled.taskId)
      checks.push({
        check:
          "Cancel after source release but before committed handoff survives SIGKILL and prevents next segment/model/queue effects",
        taskId: cancelled.taskId,
      })
      assert.equal(taskIds.length, 11)
      assert.deepEqual(
        (
          await pool.query(
            "SELECT status,count(*)::int AS n FROM tasks GROUP BY status ORDER BY status"
          )
        ).rows,
        [
          { status: "cancelled", n: 2 },
          { status: "completed", n: 9 },
        ]
      )
      handoffTasksEvaluated = taskIds.length
      checks.push({
        check:
          "Eleven actual tasks including two real target blockers and original-thread follow-up; nine completed, two actually cancelled",
        taskIds,
        taskCount: handoffTasksEvaluated,
      })
    }
    if (
      focus === "vaultfill" ||
      focus === "identity" ||
      focus === "payments" ||
      focus === "paymentdeadline" ||
      focus === "paymentsubmit"
    ) {
      const { saveVaultItem, deleteVaultItem, sweepVault } = await import("@/lib/vault")
      const { executeVaultFill } = await import("@/worker/vault")
      const { vaultFillInputSchema } = await import("@/lib/vault-schema")
      const { controller, workstationHealth } = await import("@/lib/workstation")
      const { eq } = await import("drizzle-orm")
      type FillRun = Awaited<ReturnType<typeof submit>>
      const origin = "http://127.0.0.1:8083"
      async function site(run: FillRun, route = "/state", body?: unknown) {
        return JSON.parse(
          (
            await docker(
              [
                "exec",
                ...(body === undefined ? [] : ["-i"]),
                workstationName(run.agentId),
                "curl",
                "-fsS",
                ...(body === undefined ? [] : ["-X", "POST", "--data-binary", "@-"]),
                `${origin}${route}`,
              ],
              body === undefined ? {} : { input: JSON.stringify(body) }
            )
          ).stdout.toString()
        )
      }
      async function fillRun(
        kind: string,
        mode = "normal",
        itemOrigin = origin,
        foreignPaymentId?: string
      ) {
        const username = `user-${randomUUID()}`,
          password = `password-${randomUUID()}`,
          code = String(Math.floor(10000000 + Math.random() * 90000000))
        const payment = kind.startsWith("pay_")
        const holder = `holder-${randomUUID()}`,
          upi = `upi-${randomUUID()}@bank`
        const cardFields = { number: "4242424242424242", expiry: "08/29", name: holder }
        const paymentExpected = {
          ...cardFields,
          expiry_month: "08",
          expiry_year: "2029",
          expiry_year_short: "29",
          id: upi,
        }
        const identity = kind.startsWith("fill_identity_")
        const basic = {
          name: `name-${randomUUID()}`,
          email: `email-${randomUUID()}@fixture.test`,
          phone: `phone-${randomUUID()}`,
        }
        const address = Object.fromEntries(
          ["address_line1", "address_line2", "city", "state", "postcode", "country"].map(
            (field) => [field, `${field}-${randomUUID()}-`.padEnd(200, "x")]
          )
        )
        const expected = payment
          ? paymentExpected
          : identity
            ? kind === "fill_identity_normal"
              ? { ...basic, address: Object.values(address).join(", "), ...address }
              : kind === "fill_identity_select"
                ? { country: address.country }
                : kind === "fill_identity_kind"
                  ? { password }
                  : basic
            : kind === "fill_otp"
              ? { code }
              : { username, password }
        const identityFields =
          kind === "fill_identity_normal"
            ? { ...basic, ...address }
            : kind === "fill_identity_missing"
              ? { name: basic.name }
              : kind === "fill_identity_select"
                ? { country: address.country }
                : basic
        vaultPlaintexts.push(
          username,
          password,
          code,
          ...(payment ? [cardFields.number, holder, upi] : Object.values(expected))
        )
        const run = await submit(
          kind,
          false,
          "custom/runtime-fixture",
          async (scenario, agentId) => {
            scenario.foreignPaymentId = foreignPaymentId
            scenario.fillFields = payment
              ? kind === "pay_upi" || kind === "pay_submit_upi"
                ? ["id"]
                : [
                    "number",
                    "expiry",
                    "expiry_month",
                    "expiry_year",
                    "expiry_year_short",
                    "name",
                  ]
              : Object.keys(expected)
            if (payment) {
              const upiItem = await saveVaultItem({
                id: randomUUID(),
                kind: "upi",
                origin: itemOrigin,
                label: "Controlled UPI",
                fields: { id: upi },
              })
              if (kind !== "pay_provision") {
                const cardItem = await saveVaultItem({
                  id: randomUUID(),
                  kind: "card",
                  origin: itemOrigin,
                  label: "Controlled card",
                  fields: cardFields,
                })
                scenario.itemId =
                  kind === "pay_upi" || kind === "pay_submit_upi"
                    ? upiItem.id
                    : cardItem.id
                scenario.revision = 1
              }
              await saveVaultItem({
                id: randomUUID(),
                kind: "card",
                origin: "https://other.fixture.test",
                label: "Wrong-site card",
                fields: cardFields,
              })
            } else if (kind !== "fill_otp" && kind !== "fill_identity_provision") {
              const item = await saveVaultItem({
                id: randomUUID(),
                kind:
                  kind === "fill_identity_card"
                    ? "card"
                    : kind === "fill_identity_upi"
                      ? "upi"
                      : identity
                        ? "identity"
                        : "login",
                origin: itemOrigin,
                label: identity ? "Controlled identity" : "Controlled login",
                fields:
                  kind === "fill_identity_card"
                    ? { number: "4242424242424242", expiry: "08/29" }
                    : kind === "fill_identity_upi"
                      ? { id: "fixture@bank" }
                      : identity
                        ? identityFields
                        : { username, password },
              })
              scenario.itemId = item.id
              scenario.revision = item.revision
            }
            scenario.beforeOpen = async () => {
              const name = workstationName(agentId)
              await docker([
                "cp",
                "tests/fixtures/vault-site.mjs",
                `${name}:/tmp/vault-site.mjs`,
              ])
              await docker(["exec", "--detach", name, "node", "/tmp/vault-site.mjs"])
              await until(
                async () =>
                  (await dockerRaw(["exec", name, "curl", "-fsS", `${origin}/health`]))
                    .exitCode === 0,
                "vault site ready"
              )
              await docker(
                [
                  "exec",
                  "-i",
                  name,
                  "curl",
                  "-fsS",
                  "-X",
                  "POST",
                  "--data-binary",
                  "@-",
                  `${origin}/settings`,
                ],
                {
                  input: JSON.stringify({
                    mode,
                    expected,
                    paymentMethod: kind === "pay_submit_upi" ? "upi" : "card",
                  }),
                }
              )
            }
          }
        )
        console.log(`vaultfill case started: ${kind} (${run.taskId})`)
        return { ...run, code, expected, cardFields, upi }
      }
      async function finish(run: FillRun) {
        await until(
          async () => !!run.scenario.release,
          "controlled outcome reaches model"
        )
        run.scenario.release!()
        await completed(run.taskId)
        const records = await docker([
          "exec",
          workstationName(run.agentId),
          "tar",
          "-cf",
          "-",
          "/home/agent/.local/state/personal-agent/actions",
          "/tmp/owndesk/browser.log",
        ])
        for (const value of vaultPlaintexts)
          assert(
            !records.stdout.includes(Buffer.from(value)),
            "Plaintext in guest journal/controller log"
          )
        await writeFile(
          path.join(directory, `${run.agentId}-guest-records.tar`),
          records.stdout
        )
        await docker(["stop", viewerName(run.agentId), workstationName(run.agentId)])
      }
      async function review(run: FillRun) {
        return until(
          async () =>
            (await getTask(ownerId, run.taskId)).requests.find(
              (request) =>
                request.status === "pending" &&
                request.kind === "review" &&
                request.payload.tool === "vault_fill"
            ),
          "unknown sensitive fill review"
        )
      }
      async function approval(run: FillRun) {
        const request = await pending(run.taskId, "vault_fill")
        assert.equal(request.payload.origin, origin)
        assert.equal(((await workstationHealth(run.agentId)) as any).protocolVersion, 6)
        return request
      }
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Vault fill Web ready")
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          }),
          page = await context.newPage(),
          pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).waitFor()
        const headers = { Origin: process.env.APP_URL! }
        const { env } = await import("@/lib/env")
        const { ensureWorkstation } = await import("@/lib/workstation")
        const [legacy] = await db
          .insert(schema.agents)
          .values({
            name: "Protocol migration fixture",
            role: "Actual image-health boundary",
          })
          .returning()
        agents.push(legacy.id)
        const image = env.WORKSTATION_IMAGE
        try {
          env.WORKSTATION_IMAGE = "owndesk-workstation:0.4.0"
          await assert.rejects(ensureWorkstation(legacy.id), /image protocol differs/)
          assert.equal((await workstationHealth(legacy.id)).protocolVersion, 4)
        } finally {
          env.WORKSTATION_IMAGE = image
        }
        await docker(["stop", workstationName(legacy.id)])
        checks.push({
          check:
            "Actual old guest4 image with a new container label is rejected by its real health; no task/model call or secret release",
          agentId: legacy.id,
        })
        if (
          focus === "payments" ||
          focus === "paymentdeadline" ||
          focus === "paymentsubmit"
        ) {
          const { choosePayment } = await import("@/lib/payments")
          const { assertVaultGrant } = await import("@/lib/vault")
          const { createPaymentRequest } = await import("@/worker/payments")
          async function paymentApproval(run: FillRun) {
            const request = await pending(run.taskId, "payment")
            assert.equal(request.payload.origin, origin)
            assert.equal(request.payload.merchant, "Fixture Store")
            assert.equal(request.payload.amount, "USD 12.00")
            assert.deepEqual(
              (request.payload.evidence as any).merchant.text,
              "Fixture Store"
            )
            assert.deepEqual((request.payload.evidence as any).amount.text, "USD 12.00")
            assert(
              !(request.payload.methods as any[]).some(
                (item) => item.label === "Wrong-site card"
              )
            )
            return request
          }
          async function choose(
            run: FillRun,
            request: Awaited<ReturnType<typeof paymentApproval>>,
            action: "select" | "takeover" = "select"
          ) {
            const response = await context.request.post(
              `${process.env.APP_URL}/api/task-requests/${request.id}/payment`,
              {
                headers,
                data: {
                  action,
                  payloadVersion: request.payloadVersion,
                  ...(action === "select"
                    ? { itemId: run.scenario.itemId, revision: run.scenario.revision }
                    : {}),
                },
              }
            )
            assert.equal(response.status(), 202, await response.text())
            return response.json()
          }
          async function fillAudit(run: FillRun) {
            return (
              await pool.query(
                `SELECT
              (SELECT count(*)::int FROM task_events WHERE task_id=$1 AND type='vault_released') AS releases,
              (SELECT count(*)::int FROM task_action_attempts WHERE task_id=$1 AND secret_released_at IS NOT NULL) AS dispatches`,
                [run.taskId]
              )
            ).rows[0]
          }
          async function outcome(run: FillRun) {
            await until(
              async () => !!run.scenario.release,
              "payment outcome reaches model"
            )
          }
          if (focus === "paymentdeadline") {
            const run = await fillRun("pay_deadline"),
              request = await paymentApproval(run)
            await choose(run, request)
            const fill = await approval(run)
            await site(run, "/mode", { mode: "slow_payment" })
            await until(
              async () => (await site(run)).slowReady,
              "slow DOM getter installed after approval snapshot"
            )
            const expires = (
              await pool.query<{ expires: Date }>(
                "SELECT clock_timestamp()+interval '1 second' AS expires"
              )
            ).rows[0].expires
            await pool.query(
              "UPDATE task_requests SET payload=jsonb_set(payload,'{expiresAt}',$2::jsonb) WHERE id=$1",
              [fill.id, JSON.stringify(expires.toISOString())]
            )
            await respondToRequest(ownerId, fill.id, "approve", 1, {})
            await outcome(run)
            const state = await site(run)
            const audit = await fillAudit(run)
            await writeFile(
              path.join(directory, "deadline-observation.json"),
              JSON.stringify(
                { expiresAt: expires.toISOString(), state, audit },
                null,
                2
              ) + "\n"
            )
            assert(
              state.inspectionStartedAt < expires.getTime(),
              "approval was current when the slow DOM read began"
            )
            assert(
              state.inspectionFinishedAt > expires.getTime(),
              "the actual DOM read crosses the release deadline"
            )
            assert.deepEqual(
              audit,
              { releases: 0, dispatches: 0 },
              "Expired during actual DOM inspection: no secret release after the deadline"
            )
            assert.deepEqual(state.events, [])
            assert.equal(state.submissions, 0)
            await finish(run)
            paymentTasksEvaluated = 1
            checks.push({
              check:
                "A real 1.5-second DOM read begins before and ends after a short owner-grant deadline; no release, fill or submit after expiry",
              taskId: run.taskId,
              expiresAt: expires.toISOString(),
              inspectionStartedAt: state.inspectionStartedAt,
              inspectionFinishedAt: state.inspectionFinishedAt,
            })
          } else if (focus === "paymentsubmit") {
            const { executePaymentSubmit, executePaymentResult } =
              await import("@/worker/payment-submission")
            const { paymentSubmitInputSchema } = await import("@/lib/payment-schema")
            async function submitReady(kind: string) {
              const run = await fillRun(`pay_submit_${kind}`, "submit")
              const payment = await paymentApproval(run)
              await choose(run, payment)
              const fill = await approval(run)
              await respondToRequest(ownerId, fill.id, "approve", 1, {})
              const request = await pending(run.taskId, "payment_submit")
              assert.equal(
                (await site(run)).submissions,
                0,
                "Fill approval never clicks payment"
              )
              assert.equal((request.payload.target as any).label, "Pay USD 12.00")
              return { run, payment, request }
            }
            function postSubmit(
              id: string,
              data: unknown = { payloadVersion: 1 },
              origin = headers
            ) {
              return context.request.post(
                `${process.env.APP_URL}/api/task-requests/${id}/payment-submit`,
                { headers: origin, data }
              )
            }
            async function submitAudit(run: FillRun) {
              return (
                await pool.query(
                  "SELECT count(*)::int AS dispatches FROM task_action_attempts a JOIN task_actions t USING(task_id,segment_no,action_no) WHERE a.task_id=$1 AND t.kind='payment_submit' AND a.dispatch_started_at IS NOT NULL",
                  [run.taskId]
                )
              ).rows[0].dispatches
            }
            function submitInput(request: Awaited<ReturnType<typeof pending>>) {
              const g = request.payload as any
              return paymentSubmitInputSchema.parse({
                paymentRequestId: g.paymentRequestId,
                pageId: g.pageId,
                observationId: g.observationId,
                ref: g.ref,
                evidenceRefs: {
                  merchant: g.evidence.merchant.ref,
                  amount: g.evidence.amount.ref,
                },
              })
            }
            if (paymentEdgesOnly) {
              async function gate(
                run: FillRun,
                kind: "payment_submit" | "payment_result"
              ) {
                const token = randomUUID()
                await writeFile(
                  `${dockerGatePath}.tmp`,
                  JSON.stringify({ taskId: run.taskId, kind, token })
                )
                await rename(`${dockerGatePath}.tmp`, dockerGatePath)
                return () =>
                  until(async () => {
                    const ready = JSON.parse(
                      await readFile(`${dockerGatePath}.ready`, "utf8")
                    )
                    return ready?.token === token ? ready : undefined
                  }, `host transport paused before ${kind} forwarding`)
              }
              async function releaseGate() {
                await writeFile(`${dockerGatePath}.tmp`, "null")
                await rename(`${dockerGatePath}.tmp`, dockerGatePath)
              }
              async function mutate(run: FillRun, mode: string) {
                if (mode === "result_amount")
                  await site(run, "/checkout", { amount: "USD 13.00" })
                if (mode === "result_merchant")
                  await site(run, "/checkout", { merchant: "Changed Store" })
                await site(run, "/mode", { mode })
                await until(
                  async () => (await site(run)).mutationApplied === mode,
                  `actual DOM mutation acknowledged: ${mode}`
                )
              }
              const upi = await submitReady("upi")
              assert.equal((upi.request.payload.method as any).kind, "upi")
              assert.equal((await postSubmit(upi.request.id)).status(), 202)
              await outcome(upi.run)
              const upiState = await site(upi.run)
              assert.equal(upiState.paymentMethod, "upi")
              assert.deepEqual(
                upiState.events.map((event: any) => event.field),
                ["id"]
              )
              assert.equal(upiState.submissions, 1)
              assert.equal(upiState.paymentMatches, true)
              assert.equal(await submitAudit(upi.run), 1)
              assert.equal(
                (await getTask(ownerId, upi.run.taskId)).paymentResults.length,
                1
              )
              await finish(upi.run)
              checks.push({
                check:
                  "UPI-only fill, distinct final approval, one independently matched submission and page result",
                taskId: upi.run.taskId,
              })

              const noFill = await fillRun("pay_submit_no_fill", "submit")
              await choose(noFill, await paymentApproval(noFill))
              await respondToRequest(
                ownerId,
                (await approval(noFill)).id,
                "decline",
                1,
                {}
              )
              await outcome(noFill)
              const noFillMessages = JSON.stringify(
                noFill.scenario.calls.at(-1)!.messages
              )
              assert.match(noFillMessages, /payment_submit/)
              assert.match(noFillMessages, /填写尚无已知完整回执/)
              assert.equal(
                (await getTask(ownerId, noFill.taskId)).requests.filter(
                  (r) => r.payload.purpose === "payment_submit"
                ).length,
                0
              )
              assert.deepEqual((await site(noFill)).events, [])
              assert.equal((await site(noFill)).submissions, 0)
              assert.equal(await submitAudit(noFill), 0)
              await finish(noFill)
              checks.push({
                check:
                  "Real submit tool after declined fill is rejected for missing complete preparation receipt; no final approval, marker, inputs or click",
                taskId: noFill.taskId,
              })

              for (const mode of ["cross_site", "special_control", "iframe"]) {
                const run = await submitReady(mode)
                await mutate(run.run, mode)
                assert.equal((await postSubmit(run.request.id)).status(), 202)
                await outcome(run.run)
                assert.equal(await submitAudit(run.run), 0)
                assert.equal((await site(run.run)).submissions, 0)
                assert.equal(
                  (await getTask(ownerId, run.run.taskId)).paymentResults.length,
                  0
                )
                await finish(run.run)
                checks.push({
                  check: `Actual ${mode} DOM change after snapshot rejected before dispatch; zero marker/click`,
                  taskId: run.run.taskId,
                })
              }

              const beforeSend = await submitReady("before_send")
              const paused = await gate(beforeSend.run, "payment_submit")
              assert.equal((await postSubmit(beforeSend.request.id)).status(), 202)
              const breakpoint = await paused()
              assert.equal(breakpoint.forwarded, false)
              assert.equal(await submitAudit(beforeSend.run), 1)
              assert.equal(
                (
                  await controller(beforeSend.run.agentId, "/action-status", {
                    id: breakpoint.id,
                  })
                ).found,
                false
              )
              assert.equal((await site(beforeSend.run)).submissions, 0)
              const callsBefore = beforeSend.run.scenario.calls.length
              await writeFile(
                path.join(directory, "marker-before-send.json"),
                JSON.stringify(
                  {
                    breakpoint,
                    markerCount: 1,
                    guestReceiptFound: false,
                    submissions: 0,
                  },
                  null,
                  2
                ) + "\n"
              )
              await stop()
              await until(
                async () =>
                  spawnSync("ps", ["-p", String(breakpoint.pid), "-o", "pid="]).status !==
                  0,
                "host proxy actually terminated"
              )
              // Remove the breakpoint before recovery: an erroneous resend must reach the guest.
              await releaseGate()
              await start()
              const unknown = await until(
                async () =>
                  (await getTask(ownerId, beforeSend.run.taskId)).requests.find(
                    (r) => r.status === "pending" && r.payload.tool === "payment_submit"
                  ),
                "marked but never sent submission requires review"
              )
              assert.equal(beforeSend.run.scenario.calls.length, callsBefore)
              await assert.rejects(
                respondToRequest(ownerId, unknown.id, "complete", 1, {}),
                /Unsupported/
              )
              await respondToRequest(ownerId, unknown.id, "continue", 1, {})
              await outcome(beforeSend.run)
              assert.equal((await site(beforeSend.run)).submissions, 0)
              assert.equal(await submitAudit(beforeSend.run), 1)
              assert.equal(
                (await getTask(ownerId, beforeSend.run.taskId)).paymentResults.length,
                0
              )
              assert.equal(
                (
                  await pool.query(
                    "SELECT count(*)::int AS n FROM task_action_attempts a JOIN task_actions t USING(task_id,segment_no,action_no) WHERE a.task_id=$1 AND t.kind='payment_submit'",
                    [beforeSend.run.taskId]
                  )
                ).rows[0].n,
                1
              )
              await finish(beforeSend.run)
              checks.push({
                check:
                  "Marker committed before native Docker send; process-group SIGKILL, proxy death and breakpoint removal before restart; continue/cancel review with no click or fabricated result and one attempt",
                taskId: beforeSend.run.taskId,
              })

              const guestChange = await submitReady("guest_change")
              const guestPaused = await gate(guestChange.run, "payment_submit")
              assert.equal((await postSubmit(guestChange.request.id)).status(), 202)
              await guestPaused()
              assert.equal(await submitAudit(guestChange.run), 1)
              await mutate(guestChange.run, "guest_change")
              await releaseGate()
              await outcome(guestChange.run)
              const rejected = (
                await pool.query(
                  "SELECT status,receipt FROM task_actions WHERE task_id=$1 AND kind='payment_submit'",
                  [guestChange.run.taskId]
                )
              ).rows[0]
              assert.equal(rejected.status, "failed")
              assert.equal(rejected.receipt.output.rejectedBeforeEffect, true)
              assert.equal((await site(guestChange.run)).submissions, 0)
              await finish(guestChange.run)
              checks.push({
                check:
                  "Button changes after host final inspection/marker and before guest execution; guest rejects before effect with one marker and zero clicks",
                taskId: guestChange.run.taskId,
              })

              for (const mode of ["result_missing", "result_amount", "result_merchant"]) {
                const run = await submitReady(mode)
                const resultPaused = await gate(run.run, "payment_result")
                assert.equal((await postSubmit(run.request.id)).status(), 202)
                await resultPaused()
                assert.equal((await site(run.run)).submissions, 1)
                await mutate(run.run, mode)
                await releaseGate()
                await outcome(run.run)
                assert.equal(
                  (await getTask(ownerId, run.run.taskId)).paymentResults.length,
                  0
                )
                const failed = (
                  await pool.query(
                    "SELECT status,receipt FROM task_actions WHERE task_id=$1 AND kind='payment_result'",
                    [run.run.taskId]
                  )
                ).rows[0]
                assert.equal(failed.status, "failed")
                assert.equal(failed.receipt.output.rejectedBeforeEffect, true)
                assert.equal((await site(run.run)).submissions, 1)
                assert.equal(await submitAudit(run.run), 1)
                await finish(run.run)
                checks.push({
                  check: `${mode}: observed result references changed before actual read; invalid evidence not persisted, payment remains one submission/marker`,
                  taskId: run.run.taskId,
                })
              }

              const hostReceipt = await submitReady("host_receipt")
              const hostPaused = await gate(hostReceipt.run, "payment_submit")
              assert.equal((await postSubmit(hostReceipt.request.id)).status(), 202)
              await hostPaused()
              const hostCalls = hostReceipt.run.scenario.calls.length
              const checkpoint = await pool.connect()
              try {
                await checkpoint.query("BEGIN")
                await checkpoint.query("LOCK TABLE dbos.operation_outputs IN SHARE MODE")
                await releaseGate()
                await until(
                  async () =>
                    (
                      await pool.query(
                        "SELECT status FROM task_actions WHERE task_id=$1 AND kind='payment_submit'",
                        [hostReceipt.run.taskId]
                      )
                    ).rows[0]?.status === "succeeded",
                  "business submission receipt committed before DBOS checkpoint"
                )
                assert.equal((await site(hostReceipt.run)).submissions, 1)
                assert.equal(hostReceipt.run.scenario.calls.length, hostCalls)
                await stop()
              } finally {
                await checkpoint.query("ROLLBACK")
                checkpoint.release()
              }
              await start()
              await outcome(hostReceipt.run)
              assert.equal((await site(hostReceipt.run)).submissions, 1)
              assert.equal(await submitAudit(hostReceipt.run), 1)
              assert.equal(
                (await getTask(ownerId, hostReceipt.run.taskId)).paymentResults.length,
                1
              )
              await finish(hostReceipt.run)
              checks.push({
                check:
                  "Host receipt committed before blocked framework checkpoint; SIGKILL/restart adopts durable result with one click/marker and fresh page evidence",
                taskId: hostReceipt.run.taskId,
              })
            }
            if (!paymentRecoveryOnly && !paymentEdgesOnly) {
              const normal = await submitReady("normal")
              const endpoint = `${process.env.APP_URL}/api/task-requests/${normal.request.id}/payment-submit`
              const anonymous = await browser.newContext()
              assert.equal(
                (
                  await anonymous.request.post(endpoint, {
                    headers,
                    data: { payloadVersion: 1 },
                  })
                ).status(),
                401
              )
              await anonymous.close()
              assert.equal(
                (
                  await postSubmit(normal.request.id, undefined, {
                    Origin: "https://foreign.fixture.test",
                  })
                ).status(),
                403
              )
              assert.equal(
                (await postSubmit(normal.request.id, { payloadVersion: 2 })).status(),
                409
              )
              assert.equal(
                (
                  await postSubmit(normal.request.id, {
                    payloadVersion: 1,
                    approved: true,
                  })
                ).status(),
                400
              )
              await assert.rejects(
                respondToRequest(ownerId, normal.request.id, "approve", 1, {}),
                /认证网页/
              )
              const [normalTask] = await db
                .select()
                .from(schema.tasks)
                .where(eq(schema.tasks.id, normal.run.taskId))
              const missingResult = await executePaymentResult(
                normalTask,
                1,
                900,
                {
                  submissionRequestId: normal.request.id,
                  pageId: String(normal.request.payload.pageId),
                  observationId: String(normal.request.payload.observationId),
                  evidenceRefs: {
                    merchant: "t1",
                    amount: "t2",
                    status: "t3",
                    receipt: "t4",
                  },
                },
                Number(normal.request.payload.epoch)
              )
              assert.equal(
                missingResult.ok,
                false,
                "No result claim before final approval/dispatch"
              )
              await deleteVaultItem(normal.run.scenario.itemId!, 1)
              await page.goto(`${process.env.APP_URL}/?task=${normal.run.taskId}`)
              await page
                .getByRole("heading", { name: "确认一次付款提交", exact: true })
                .waitFor()
              assert.equal(await page.getByLabel("请求答复").count(), 0)
              assert.equal(
                await page.evaluate(
                  () => document.documentElement.scrollWidth > innerWidth
                ),
                false
              )
              await page.screenshot({
                path: path.join(directory, "payment-submit-mobile.png"),
                fullPage: true,
              })
              await page.setViewportSize({ width: 1440, height: 1100 })
              await page.screenshot({
                path: path.join(directory, "payment-submit-desktop.png"),
                fullPage: true,
              })
              const accepted = page.waitForResponse(
                (r) => r.url() === endpoint && r.request().method() === "POST"
              )
              await page
                .getByRole("button", { name: "确认，点击一次付款按钮", exact: true })
                .click()
              assert.equal((await accepted).status(), 202)
              await outcome(normal.run)
              const normalState = await site(normal.run)
              assert.equal(normalState.submissions, 1)
              assert.equal(normalState.paymentMatches, true)
              assert.equal(await submitAudit(normal.run), 1)
              const evidence = (await getTask(ownerId, normal.run.taskId)).paymentResults
              assert.equal(evidence.length, 1)
              assert.equal(evidence[0].verification, "page_text_only")
              assert.equal(evidence[0].evidence.receipt.text, "fixture-order-1")
              assert.equal(
                (await postSubmit(normal.request.id)).status(),
                202,
                "Same final approval is idempotent"
              )
              const replay = await executePaymentSubmit(
                normalTask,
                1,
                Number(normal.request.payload.actionNo),
                submitInput(normal.request),
                Number(normal.request.payload.epoch)
              )
              assert.equal(replay.ok, true)
              assert.equal((await site(normal.run)).submissions, 1)
              const client = await pool.connect()
              try {
                const { assertPaymentSubmission } =
                  await import("@/lib/payment-submission")
                await client.query("BEGIN")
                await client.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
                  normal.run.taskId,
                ])
                await assert.rejects(
                  assertPaymentSubmission(client, normal.run.taskId, {
                    ...(normal.request.payload as any),
                    actionNo: 901,
                  }),
                  /已经提交|未知/
                )
                await client.query("ROLLBACK")
              } finally {
                client.release()
              }
              await page
                .getByLabel("付款页面证据")
                .getByText("网页回执/订单号：fixture-order-1", { exact: true })
                .waitFor()
              await page.screenshot({
                path: path.join(directory, "payment-result-desktop.png"),
                fullPage: true,
              })
              await page.setViewportSize({ width: 390, height: 844 })
              await page.screenshot({
                path: path.join(directory, "payment-result-mobile.png"),
                fullPage: true,
              })
              await finish(normal.run)
              checks.push({
                check:
                  "Card preparation, fresh observation, separate authenticated final UI approval, exactly one matched fixture submission and separately preserved page evidence; deleted item does not require another decrypt; API gates/idempotence/known host receipt and cross-action reuse rejection",
                taskId: normal.run.taskId,
              })

              const declined = await submitReady("decline")
              const [otherTask] = await db
                .select()
                .from(schema.tasks)
                .where(eq(schema.tasks.id, declined.run.taskId))
              assert.equal(
                (
                  await executePaymentResult(
                    otherTask,
                    1,
                    902,
                    {
                      submissionRequestId: normal.request.id,
                      pageId: String(declined.request.payload.pageId),
                      observationId: String(declined.request.payload.observationId),
                      evidenceRefs: {
                        merchant: "t1",
                        amount: "t2",
                        status: "t3",
                        receipt: "t4",
                      },
                    },
                    Number(declined.request.payload.epoch)
                  )
                ).ok,
                false
              )
              const scopeClient = await pool.connect()
              try {
                const { paymentPreparation } = await import("@/lib/payment-submission")
                await scopeClient.query("BEGIN")
                await scopeClient.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
                  otherTask.id,
                ])
                await assert.rejects(
                  paymentPreparation(scopeClient, otherTask.id, 1, normal.payment.id),
                  /本任务/
                )
                await scopeClient.query("ROLLBACK")
              } finally {
                scopeClient.release()
              }
              await respondToRequest(ownerId, declined.request.id, "decline", 1, {})
              await outcome(declined.run)
              assert.equal((await site(declined.run)).submissions, 0)
              assert.equal(await submitAudit(declined.run), 0)
              await finish(declined.run)
              checks.push({
                check:
                  "Final decline after preparation never submits; foreign-task preparation/result references rejected",
                taskId: declined.run.taskId,
              })

              const cancelled = await submitReady("cancel")
              await respondToRequest(ownerId, cancelled.request.id, "cancel", 1, {})
              await until(
                async () =>
                  (await getTask(ownerId, cancelled.run.taskId)).status === "cancelled",
                "actual final-approval cancellation"
              )
              const container = await dockerRaw([
                "inspect",
                workstationName(cancelled.run.agentId),
              ])
              assert(
                container.exitCode !== 0 ||
                  JSON.parse(container.stdout.toString())[0].State.Running === false
              )
              assert.equal(await submitAudit(cancelled.run), 0)
              checks.push({
                check:
                  "Cancel at final approval actually stops/removes guest; no payment dispatch",
                taskId: cancelled.run.taskId,
              })

              for (const changed of ["amount", "button"]) {
                const run = await submitReady(changed)
                await site(
                  run.run,
                  "/checkout",
                  changed === "amount"
                    ? { amount: "USD 13.00" }
                    : { buttonLabel: "Pay USD 13.00" }
                )
                await delay(300)
                assert.equal((await postSubmit(run.request.id)).status(), 202)
                await outcome(run.run)
                assert.equal((await site(run.run)).submissions, 0)
                assert.equal(await submitAudit(run.run), 0)
                await finish(run.run)
                checks.push({
                  check: `Changed ${changed} after final snapshot is rejected by independent pre-dispatch read; zero dispatch/click`,
                  taskId: run.run.taskId,
                })
              }

              const expired = await submitReady("expired")
              await pool.query(
                "UPDATE task_requests SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2026-01-01T00:00:00.000Z'::text)) WHERE id=$1",
                [expired.request.id]
              )
              assert.equal((await postSubmit(expired.request.id)).status(), 409)
              await site(expired.run, "/mode", { mode: "slow_payment" })
              await until(
                async () => (await site(expired.run)).slowReady,
                "slow final read installed"
              )
              const deadline = (
                await pool.query<{ expires: Date }>(
                  "SELECT clock_timestamp()+interval '1 second' AS expires"
                )
              ).rows[0].expires
              await pool.query(
                "UPDATE task_requests SET payload=jsonb_set(payload,'{expiresAt}',$2::jsonb) WHERE id=$1",
                [expired.request.id, JSON.stringify(deadline.toISOString())]
              )
              assert.equal((await postSubmit(expired.request.id)).status(), 202)
              await outcome(expired.run)
              const timed = await site(expired.run)
              await writeFile(
                path.join(directory, "submission-deadline.json"),
                JSON.stringify(
                  {
                    expiresAt: deadline.toISOString(),
                    state: timed,
                    dispatches: await submitAudit(expired.run),
                  },
                  null,
                  2
                ) + "\n"
              )
              assert(
                timed.inspectionStartedAt < deadline.getTime() &&
                  timed.inspectionFinishedAt > deadline.getTime()
              )
              assert.equal(await submitAudit(expired.run), 0)
              assert.equal(timed.submissions, 0)
              await finish(expired.run)
              checks.push({
                check:
                  "Expired approval rejects; a real slow DOM read then crosses a current grant deadline and the final current-clock check refuses dispatch",
                taskId: expired.run.taskId,
              })

              const restarted = await submitReady("restart")
              const beforeRestart = restarted.run.scenario.calls.length
              await stop()
              await start()
              assert.equal(restarted.run.scenario.calls.length, beforeRestart)
              assert.equal((await postSubmit(restarted.request.id)).status(), 409)
              await respondToRequest(ownerId, restarted.request.id, "decline", 1, {})
              await outcome(restarted.run)
              assert.equal(await submitAudit(restarted.run), 0)
              assert.equal((await site(restarted.run)).submissions, 0)
              await finish(restarted.run)
              checks.push({
                check:
                  "Final approval wait survives SIGKILL without new model request; old epoch approval rejected and explicit decline never clicks",
                taskId: restarted.run.taskId,
              })
            }
            for (const lost of paymentEdgesOnly
              ? []
              : paymentRecoveryOnly
                ? [true]
                : [false, true]) {
              const run = await submitReady(lost ? "lost_receipt" : "guest_receipt")
              const lock = await pool.connect()
              try {
                await lock.query("SELECT pg_advisory_lock(20261025,912)")
                await pool.query(
                  `CREATE FUNCTION fixture_submit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${run.run.taskId}' AND NEW.kind='payment_submit' AND NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(20261025,912); END IF; RETURN NEW; END $$`
                )
                await pool.query(
                  "CREATE TRIGGER fixture_submit_receipt BEFORE UPDATE ON task_actions FOR EACH ROW EXECUTE FUNCTION fixture_submit_receipt()"
                )
                assert.equal((await postSubmit(run.request.id)).status(), 202)
                await until(
                  async () =>
                    (
                      await pool.query(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
                      )
                    ).rowCount! > 0,
                  "payment click saved in guest before host receipt"
                )
                assert.equal((await site(run.run)).submissions, 1)
                assert.equal(await submitAudit(run.run), 1)
                await stop()
                if (lost) {
                  const dispatch = (
                    await pool.query(
                      "SELECT a.dispatch_id FROM task_action_attempts a JOIN task_actions t USING(task_id,segment_no,action_no) WHERE a.task_id=$1 AND t.kind='payment_submit'",
                      [run.run.taskId]
                    )
                  ).rows[0].dispatch_id
                  await docker([
                    "exec",
                    workstationName(run.run.agentId),
                    "rm",
                    `/home/agent/.local/state/personal-agent/actions/${dispatch}.json`,
                  ])
                }
              } finally {
                await lock.query("SELECT pg_advisory_unlock(20261025,912)")
                lock.release()
                await pool.query(
                  "DROP TRIGGER IF EXISTS fixture_submit_receipt ON task_actions"
                )
                await pool.query("DROP FUNCTION IF EXISTS fixture_submit_receipt()")
              }
              await start()
              if (lost) {
                const request = await until(
                  async () =>
                    (await getTask(ownerId, run.run.taskId)).requests.find(
                      (r) => r.status === "pending" && r.payload.tool === "payment_submit"
                    ),
                  "unknown payment submission review"
                )
                await assert.rejects(
                  respondToRequest(ownerId, request.id, "complete", 1, {}),
                  /Unsupported/
                )
                await respondToRequest(ownerId, request.id, "continue", 1, {})
              }
              await outcome(run.run)
              assert.equal((await site(run.run)).submissions, 1)
              assert.equal(await submitAudit(run.run), 1)
              assert.equal(
                (await getTask(ownerId, run.run.taskId)).paymentResults.length,
                1
              )
              await finish(run.run)
              checks.push({
                check: lost
                  ? "Actual effect plus lost guest receipt and SIGKILL becomes unknown; continue/cancel only, no second dispatch/click, fresh result evidence remains readable"
                  : "Actual effect and known guest receipt survive SIGKILL before host commit; cached receipt adopted without another approval/dispatch/click",
                taskId: run.run.taskId,
              })
            }
            for (const table of (
              await pool.query<{ schemaname: string; tablename: string }>(
                "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','dbos')"
              )
            ).rows) {
              const data = JSON.stringify(
                (
                  await pool.query(
                    `SELECT to_jsonb(t) FROM "${table.schemaname}"."${table.tablename}" t`
                  )
                ).rows
              )
              for (const value of vaultPlaintexts)
                assert(
                  !data.includes(value),
                  `Plaintext in ${table.schemaname}.${table.tablename}`
                )
            }
            assert.deepEqual(pageErrors, [])
            assert.deepEqual(
              (
                await pool.query(
                  "SELECT status,count(*)::int AS n FROM tasks GROUP BY status ORDER BY status"
                )
              ).rows,
              paymentEdgesOnly
                ? [{ status: "completed", n: 11 }]
                : paymentRecoveryOnly
                  ? [{ status: "completed", n: 1 }]
                  : [
                      { status: "cancelled", n: 1 },
                      { status: "completed", n: 8 },
                    ]
            )
            paymentTasksEvaluated = paymentEdgesOnly ? 11 : paymentRecoveryOnly ? 1 : 9
            checks.push({
              check: paymentEdgesOnly
                ? "Eleven actual edge tasks, all completed: UPI, missing fill, three unsupported targets, before-send interruption, guest-side recheck, three invalid results and host-checkpoint recovery"
                : paymentRecoveryOnly
                  ? "One actual lost-receipt submission task; final approval, exactly one external effect, durable marker, SIGKILL/receipt deletion, continue-only review and fresh page evidence"
                  : "Nine actual submission tasks (8 completed,1 cancelled), controlled fixture payments only; page evidence distinct from settlement, no plaintext sample in durable records",
              taskCount: paymentTasksEvaluated,
            })
          } else {
            const card = await fillRun("pay_card"),
              cardPayment = await paymentApproval(card)
            const endpoint = `${process.env.APP_URL}/api/task-requests/${cardPayment.id}/payment`
            const anonymous = await browser.newContext()
            assert.equal(
              (
                await anonymous.request.post(endpoint, {
                  headers,
                  data: { action: "takeover", payloadVersion: 1 },
                })
              ).status(),
              401
            )
            await anonymous.close()
            assert.equal(
              (
                await context.request.post(endpoint, {
                  headers: { Origin: "https://untrusted.fixture.test" },
                  data: { action: "takeover", payloadVersion: 1 },
                })
              ).status(),
              403
            )
            assert.equal(
              (
                await context.request.post(endpoint, {
                  headers,
                  data: {
                    action: "select",
                    payloadVersion: 1,
                    itemId: card.scenario.itemId,
                    revision: 1,
                    number: "not-accepted",
                  },
                })
              ).status(),
              400
            )
            assert.equal(
              (
                await context.request.post(endpoint, {
                  headers,
                  data: {
                    action: "select",
                    payloadVersion: 2,
                    itemId: card.scenario.itemId,
                    revision: 1,
                  },
                })
              ).status(),
              409
            )
            assert.equal(
              (
                await context.request.post(endpoint, {
                  headers,
                  data: {
                    action: "select",
                    payloadVersion: 1,
                    itemId: "not-offered",
                    revision: 1,
                  },
                })
              ).status(),
              409
            )
            assert.equal(
              (
                await context.request.post(
                  `${process.env.APP_URL}/api/task-requests/${cardPayment.id}/respond`,
                  {
                    headers,
                    data: { decision: "approve", payloadVersion: 1, response: {} },
                  }
                )
              ).status(),
              400
            )
            await assert.rejects(
              choosePayment(randomUUID(), cardPayment.id, {
                action: "takeover",
                payloadVersion: 1,
              }),
              /不存在/
            )
            const { paymentInputSchema } = await import("@/lib/payment-schema")
            const [paymentTask] = await db
              .select()
              .from(schema.tasks)
              .where(eq(schema.tasks.id, card.taskId))
            const savedInput = paymentInputSchema.parse({
              merchant: cardPayment.payload.merchant,
              amount: cardPayment.payload.amount,
              purpose: cardPayment.payload.reason,
              pageId: cardPayment.payload.pageId,
              observationId: cardPayment.payload.observationId,
              evidenceRefs: {
                merchant: (cardPayment.payload.evidence as any).merchant.ref,
                amount: (cardPayment.payload.evidence as any).amount.ref,
              },
            })
            assert.equal(
              (
                await createPaymentRequest(
                  paymentTask,
                  1,
                  Number(cardPayment.payload.actionNo),
                  savedInput,
                  Number(cardPayment.payload.epoch)
                )
              ).requestId,
              cardPayment.id
            )
            await assert.rejects(
              createPaymentRequest(
                paymentTask,
                1,
                Number(cardPayment.payload.actionNo),
                { ...savedInput, amount: "USD 11.00" },
                Number(cardPayment.payload.epoch)
              ),
              /different parameters/
            )
            await page.goto(`${process.env.APP_URL}/?task=${card.taskId}`)
            await page
              .getByRole("heading", { name: "选择支付资料或人工处理", exact: true })
              .waitFor()
            assert.equal(
              await page
                .getByRole("button", { name: "同意使用所选资料", exact: true })
                .isDisabled(),
              true
            )
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth
              ),
              false
            )
            await page.screenshot({
              path: path.join(directory, "payment-choice-mobile.png"),
              fullPage: true,
            })
            await page.setViewportSize({ width: 1440, height: 1050 })
            await page.screenshot({
              path: path.join(directory, "payment-choice-desktop.png"),
              fullPage: true,
            })
            await page.getByRole("radio", { name: /Controlled card/ }).check()
            const choiceResponse = page.waitForResponse(
              (response) =>
                response.url().endsWith(`/task-requests/${cardPayment.id}/payment`) &&
                response.request().method() === "POST"
            )
            await page
              .getByRole("button", { name: "同意使用所选资料", exact: true })
              .click()
            assert.equal((await choiceResponse).status(), 202)
            const sameChoice = await choose(card, cardPayment)
            assert.equal(sameChoice.itemId, card.scenario.itemId)
            assert.equal(sameChoice.kind, "card")
            const cardFill = await approval(card)
            await page
              .getByRole("heading", { name: "授权一次凭据填写", exact: true })
              .waitFor()
            assert.equal(await page.getByLabel("本次填写字段").locator("li").count(), 6)
            await page
              .getByLabel("本次填写字段")
              .getByText("持卡人", { exact: true })
              .waitFor()
            await page.getByRole("button", { name: "同意本次填写", exact: true }).click()
            await outcome(card)
            const cardState = await site(card)
            assert.deepEqual(
              cardState.events,
              card.scenario.fillFields!.map((field) => ({
                field,
                matched: true,
                masked: true,
              }))
            )
            assert.equal(cardState.submissions, 0)
            assert.deepEqual(await fillAudit(card), { releases: 1, dispatches: 1 })
            const lock = await pool.connect()
            try {
              await lock.query("BEGIN")
              await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
                card.taskId,
              ])
              await assert.rejects(
                assertVaultGrant(lock, card.taskId, {
                  ...(cardFill.payload as any),
                  actionNo: Number(cardFill.payload.actionNo) + 10,
                }),
                /已经释放过资料/
              )
            } finally {
              await lock.query("ROLLBACK")
              lock.release()
            }
            const cardGrant = cardFill.payload as any
            const [cardTask] = await db
              .select()
              .from(schema.tasks)
              .where(eq(schema.tasks.id, card.taskId))
            const receipt = (
              await pool.query(
                "SELECT receipt FROM task_actions WHERE task_id=$1 AND kind='vault_fill'",
                [card.taskId]
              )
            ).rows[0].receipt
            await deleteVaultItem(cardGrant.itemId, cardGrant.revision)
            assert.deepEqual(
              await executeVaultFill(
                cardTask,
                cardGrant.segmentNo,
                cardGrant.actionNo,
                vaultFillInputSchema.parse({
                  itemId: cardGrant.itemId,
                  revision: cardGrant.revision,
                  pageId: cardGrant.pageId,
                  observationId: cardGrant.observationId,
                  fields: cardGrant.fields.map(({ field, ref }: any) => ({ field, ref })),
                  paymentRequestId: cardPayment.id,
                }),
                cardGrant.epoch
              ),
              receipt
            )
            assert.deepEqual(await site(card), cardState)
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND key=$2",
                  [card.taskId, `decision:${cardPayment.id}`]
                )
              ).rows[0].n,
              1
            )
            await finish(card)
            checks.push({
              check:
                "Card: actual mobile/desktop owner choice plus separate six-field approval; authenticated/Origin/version/offered-reference gates; generic/forged approval rejected; one release, no submit; new-action reuse rejected while known receipt survives item deletion",
              taskId: card.taskId,
              state: cardState,
            })

            for (const kind of ["pay_upi", "pay_provision"]) {
              const run = await fillRun(kind)
              if (kind === "pay_provision") {
                const request = await pending(run.taskId, "vault_secret")
                await page.setViewportSize({ width: 390, height: 844 })
                await page.goto(`${process.env.APP_URL}/?task=${run.taskId}`)
                await page
                  .getByRole("heading", { name: "安全提供银行卡", exact: true })
                  .waitFor()
                for (const [field, label] of [
                  ["number", "卡号"],
                  ["expiry", "有效期"],
                  ["name", "持卡人"],
                ])
                  await page
                    .getByLabel(label, { exact: true })
                    .fill((run.cardFields as Record<string, string>)[field])
                await page
                  .getByRole("checkbox", {
                    name: "保存到保险箱供以后使用；取消勾选则仅本任务有效",
                  })
                  .uncheck()
                const provided = page.waitForResponse(
                  (response) =>
                    response.url().endsWith(`/task-requests/${request.id}/secret`) &&
                    response.request().method() === "POST"
                )
                await page
                  .getByRole("button", { name: "安全提供并继续", exact: true })
                  .click()
                const response = await provided
                assert.equal(response.status(), 202)
                const reference = await response.json()
                run.scenario.itemId = reference.itemId
                run.scenario.revision = reference.revision
              }
              const request = await paymentApproval(run)
              await choose(run, request)
              const fill = await approval(run)
              await respondToRequest(ownerId, fill.id, "approve", 1, {})
              await outcome(run)
              assert.deepEqual(
                (await site(run)).events,
                run.scenario.fillFields!.map((field) => ({
                  field,
                  matched: true,
                  masked: true,
                }))
              )
              assert.equal((await site(run)).submissions, 0)
              assert.deepEqual(await fillAudit(run), { releases: 1, dispatches: 1 })
              if (kind === "pay_provision") {
                await sweepVault()
                assert.equal(
                  (
                    await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [
                      run.scenario.itemId,
                    ])
                  ).rowCount,
                  0
                )
              }
              await finish(run)
              checks.push({
                check: `${kind}: selected exact-origin method actually filled once; temporary card uses secure form, reference-only wakeup and ciphertext cleanup; no automatic submit`,
                taskId: run.taskId,
              })
            }
            const declined = await fillRun("pay_decline"),
              declineRequest = await paymentApproval(declined)
            await respondToRequest(ownerId, declineRequest.id, "decline", 1, {})
            await outcome(declined)
            assert.deepEqual((await site(declined)).events, [])
            assert.deepEqual(await fillAudit(declined), { releases: 0, dispatches: 0 })
            await finish(declined)
            checks.push({
              check:
                "Decline: immutable explicit decision; no secret release, fill or submit",
              taskId: declined.taskId,
            })
            const cancelled = await fillRun("pay_cancel"),
              cancelRequest = await paymentApproval(cancelled)
            await respondToRequest(ownerId, cancelRequest.id, "cancel", 1, {})
            await until(
              async () =>
                (await getTask(ownerId, cancelled.taskId)).status === "cancelled",
              "payment wait actually cancelled"
            )
            const stopped = await dockerRaw([
              "inspect",
              "--type",
              "container",
              "--format",
              "{{.State.Running}}",
              workstationName(cancelled.agentId),
            ])
            if (stopped.exitCode === 0)
              assert.equal(stopped.stdout.toString().trim(), "false")
            else assert.match(stopped.stderr, /no such (container|object)/i)
            assert.deepEqual(await fillAudit(cancelled), { releases: 0, dispatches: 0 })
            checks.push({
              check:
                "Cancel while choosing payment method: actual workstation stopped/removed before terminal task; no sensitive dispatch",
              taskId: cancelled.taskId,
            })

            for (const kind of [
              "mismatch",
              "amount_changed",
              "release_changed",
              "revision",
              "expired",
              "cross_task",
            ]) {
              const run = await fillRun(
                `pay_${kind}`,
                "normal",
                origin,
                kind === "cross_task" ? cardPayment.id : undefined
              )
              if (!["mismatch", "cross_task"].includes(kind)) {
                const request = await paymentApproval(run)
                if (kind === "revision") {
                  await pool.query(
                    "UPDATE vault_items SET revision=revision+1 WHERE id=$1",
                    [run.scenario.itemId]
                  )
                  await assert.rejects(
                    choosePayment(ownerId, request.id, {
                      action: "select",
                      payloadVersion: 1,
                      itemId: run.scenario.itemId!,
                      revision: 1,
                    }),
                    /变化|过期/
                  )
                  await respondToRequest(ownerId, request.id, "decline", 1, {})
                } else if (kind === "expired") {
                  await pool.query(
                    "UPDATE task_requests SET payload=jsonb_set(payload,'{expiresAt}',$2::jsonb) WHERE id=$1",
                    [
                      request.id,
                      JSON.stringify(new Date(Date.now() - 1000).toISOString()),
                    ]
                  )
                  await assert.rejects(
                    choosePayment(ownerId, request.id, {
                      action: "select",
                      payloadVersion: 1,
                      itemId: run.scenario.itemId!,
                      revision: 1,
                    }),
                    /过期/
                  )
                  await respondToRequest(ownerId, request.id, "decline", 1, {})
                } else {
                  if (kind === "amount_changed") {
                    await site(run, "/checkout", { amount: "USD 13.00" })
                    await until(async () => {
                      const result = await controller(run.agentId, "/payment-inspect", {
                        pageId: request.payload.pageId,
                        observationId: request.payload.observationId,
                        epoch: request.payload.epoch,
                        evidenceRefs: {
                          merchant: (request.payload.evidence as any).merchant.ref,
                          amount: (request.payload.evidence as any).amount.ref,
                        },
                      })
                      return (result.evidence as any).amount.text === "USD 13.00"
                    }, "visible total changed before payment method selection")
                  }
                  await choose(run, request)
                  if (kind === "release_changed") {
                    const fill = await approval(run)
                    await site(run, "/checkout", { amount: "USD 13.00" })
                    await until(async () => {
                      const result = await controller(run.agentId, "/payment-inspect", {
                        pageId: request.payload.pageId,
                        observationId: request.payload.observationId,
                        epoch: request.payload.epoch,
                        evidenceRefs: {
                          merchant: (request.payload.evidence as any).merchant.ref,
                          amount: (request.payload.evidence as any).amount.ref,
                        },
                      })
                      return (result.evidence as any).amount.text === "USD 13.00"
                    }, "visible total changed during exact-field wait")
                    await respondToRequest(ownerId, fill.id, "approve", 1, {})
                  }
                }
              }
              await outcome(run)
              assert.deepEqual((await site(run)).events, [])
              assert.equal((await site(run)).submissions, 0)
              assert.deepEqual(await fillAudit(run), { releases: 0, dispatches: 0 })
              if (["mismatch", "cross_task"].includes(kind))
                assert.equal((await getTask(ownerId, run.taskId)).requests.length, 0)
              if (kind === "cross_task")
                assert.match(
                  JSON.stringify(run.scenario.calls.at(-1)!.messages),
                  /does not belong to this task/
                )
              if (kind === "mismatch")
                assert.match(
                  JSON.stringify(run.scenario.calls.at(-1)!.messages),
                  /do not match the selected visible page text/
                )
              await finish(run)
              checks.push({
                check: `${kind}: independent source/context/version/expiry rejection; no release, input, submit or automatic regeneration`,
                taskId: run.taskId,
              })
            }
            const partial = await fillRun("pay_mid_change", "payment_change"),
              partialRequest = await paymentApproval(partial)
            await choose(partial, partialRequest)
            const partialFill = await approval(partial)
            await respondToRequest(ownerId, partialFill.id, "approve", 1, {})
            const partialReview = await review(partial)
            assert.deepEqual((partialReview.payload.details as any).filled, ["number"])
            await respondToRequest(ownerId, partialReview.id, "continue", 1, {})
            await outcome(partial)
            assert.deepEqual((await site(partial)).events, [
              { field: "number", matched: true, masked: true },
            ])
            assert.equal((await site(partial)).submissions, 0)
            await finish(partial)
            checks.push({
              check:
                "Amount changes synchronously after first PAN input: guest rechecks approved text before each later field; partial review stops remaining fields and never submits/retypes",
              taskId: partial.taskId,
            })

            const manual = await fillRun("pay_takeover", "manual"),
              manualRequest = await paymentApproval(manual)
            await pool.query(
              `CREATE FUNCTION fixture_payment_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${manualRequest.id}' AND NEW.decision='approve' THEN RAISE EXCEPTION 'fixture payment transaction rollback'; END IF; RETURN NEW; END $$`
            )
            await pool.query(
              "CREATE TRIGGER fixture_payment_rollback BEFORE UPDATE ON task_requests FOR EACH ROW EXECUTE FUNCTION fixture_payment_rollback()"
            )
            try {
              const failed = await context.request.post(
                `${process.env.APP_URL}/api/task-requests/${manualRequest.id}/payment`,
                { headers, data: { action: "takeover", payloadVersion: 1 } }
              )
              assert.equal(failed.status(), 500)
              assert.equal(
                (
                  await pool.query(
                    "SELECT 1 FROM task_requests WHERE task_id=$1 AND kind='takeover'",
                    [manual.taskId]
                  )
                ).rowCount,
                0
              )
              const state = (
                await pool.query(
                  "SELECT desired_mode,request_id FROM workstation_control WHERE agent_id=$1",
                  [manual.agentId]
                )
              ).rows[0]
              assert.deepEqual(state, { desired_mode: null, request_id: null })
              assert.equal(
                (
                  await pool.query("SELECT decision FROM task_requests WHERE id=$1", [
                    manualRequest.id,
                  ])
                ).rows[0].decision,
                null
              )
            } finally {
              await pool.query(
                "DROP TRIGGER fixture_payment_rollback ON task_requests; DROP FUNCTION fixture_payment_rollback()"
              )
            }
            await page.goto(`${process.env.APP_URL}/?task=${manual.taskId}`)
            await page
              .getByRole("heading", { name: "选择支付资料或人工处理", exact: true })
              .waitFor()
            const takeResponse = page.waitForResponse(
              (response) =>
                response.url().endsWith(`/task-requests/${manualRequest.id}/payment`) &&
                response.request().method() === "POST"
            )
            await page
              .getByRole("button", { name: "我来处理，接管桌面", exact: true })
              .click()
            const accepted = await takeResponse
            assert.equal(accepted.status(), 202)
            const taken = await accepted.json()
            assert.equal(
              (await choose(manual, manualRequest, "takeover")).takeoverRequestId,
              taken.takeoverRequestId
            )
            const handoff = await until(async () => {
              const task = await getTask(ownerId, manual.taskId)
              return task.control?.mode === "human"
                ? task.requests.find(
                    (request) =>
                      request.id === taken.takeoverRequestId &&
                      request.status === "pending"
                  )
                : undefined
            }, "payment takeover actually human-ready")
            const before = manual.scenario.calls.length
            await stop()
            await start()
            assert.equal(manual.scenario.calls.length, before)
            await docker([
              "exec",
              workstationName(manual.agentId),
              "xdotool",
              "key",
              "Return",
            ])
            await until(
              async () => (await site(manual)).manualActions === 1,
              "real human-mode keyboard triggers controlled manual action"
            )
            await respondToRequest(
              ownerId,
              handoff.id,
              "handback",
              handoff.payloadVersion,
              {
                note: "manual payment simulated; this is not a real payment or issuer receipt",
              }
            )
            await outcome(manual)
            assert.equal((await site(manual)).submissions, 1)
            assert.deepEqual(await fillAudit(manual), { releases: 0, dispatches: 0 })
            await finish(manual)
            checks.push({
              check:
                "Takeover choice, real control request and DBOS wakeup roll back together on injected failure; retry creates one handoff; worker SIGKILL preserves human wait; actual desktop keyboard performs a labelled manual simulation then handback, no vault release",
              taskId: manual.taskId,
              manualSimulatedSubmissions: 1,
            })

            const restarted = await fillRun("pay_restart"),
              staleRequest = await paymentApproval(restarted)
            const callsBefore = restarted.scenario.calls.length
            await stop()
            await start()
            assert.equal(restarted.scenario.calls.length, callsBefore)
            await assert.rejects(
              choosePayment(ownerId, staleRequest.id, {
                action: "select",
                payloadVersion: 1,
                itemId: restarted.scenario.itemId!,
                revision: 1,
              }),
              /变化|过期/
            )
            await respondToRequest(ownerId, staleRequest.id, "decline", 1, {})
            const freshRequest = await until(
              async () =>
                (await getTask(ownerId, restarted.taskId)).requests.find(
                  (request) =>
                    request.status === "pending" &&
                    request.payload.purpose === "payment" &&
                    request.id !== staleRequest.id
                ),
              "fresh payment after restart fencing"
            )
            await choose(restarted, freshRequest)
            const restartedFill = await approval(restarted)
            await respondToRequest(ownerId, restartedFill.id, "approve", 1, {})
            await outcome(restarted)
            assert.deepEqual(
              (await site(restarted)).events,
              restarted.scenario.fillFields!.map((field) => ({
                field,
                matched: true,
                masked: true,
              }))
            )
            assert.equal((await site(restarted)).submissions, 0)
            await finish(restarted)
            checks.push({
              check:
                "Payment-choice wait survives worker SIGKILL without a new model bill; old epoch approval rejected, explicit decline/new observation/new request permits one fill",
              taskId: restarted.taskId,
            })

            const lost = await fillRun("pay_lost_receipt"),
              lostRequest = await paymentApproval(lost)
            await choose(lost, lostRequest)
            const lostFill = await approval(lost),
              receiptLock = await pool.connect()
            try {
              await receiptLock.query("SELECT pg_advisory_lock(20261025,815)")
              await pool.query(
                `CREATE FUNCTION fixture_hold_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${lost.taskId}' AND NEW.kind='vault_fill' AND NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(20261025,815); END IF; RETURN NEW; END $$`
              )
              await pool.query(
                "CREATE TRIGGER fixture_hold_payment_receipt BEFORE UPDATE ON task_actions FOR EACH ROW EXECUTE FUNCTION fixture_hold_payment_receipt()"
              )
              await respondToRequest(ownerId, lostFill.id, "approve", 1, {})
              await until(
                async () =>
                  (
                    await pool.query(
                      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
                    )
                  ).rowCount! > 0,
                "payment fill before host receipt commit"
              )
              assert.equal(
                (
                  await controller(lost.agentId, "/action-status", {
                    id: `${lost.taskId}-s1-a${lostFill.payload.actionNo}`,
                  })
                ).status,
                "succeeded"
              )
              await stop()
              await docker([
                "exec",
                workstationName(lost.agentId),
                "rm",
                `/home/agent/.local/state/personal-agent/actions/${lost.taskId}-s1-a${lostFill.payload.actionNo}.json`,
              ])
            } finally {
              await receiptLock.query("SELECT pg_advisory_unlock(20261025,815)")
              await pool.query(
                "DROP TRIGGER fixture_hold_payment_receipt ON task_actions; DROP FUNCTION fixture_hold_payment_receipt()"
              )
              receiptLock.release()
            }
            await start()
            const unknown = await review(lost)
            await assert.rejects(
              respondToRequest(ownerId, unknown.id, "complete", 1, {}),
              /Unsupported/
            )
            await respondToRequest(ownerId, unknown.id, "continue", 1, {})
            await outcome(lost)
            assert.deepEqual(
              (await site(lost)).events,
              lost.scenario.fillFields!.map((field) => ({
                field,
                matched: true,
                masked: true,
              }))
            )
            assert.equal((await site(lost)).submissions, 0)
            assert.deepEqual(await fillAudit(lost), { releases: 1, dispatches: 1 })
            await finish(lost)
            checks.push({
              check:
                "Sensitive payment fill effect plus lost receipt/worker SIGKILL remains unknown, with one release/consumption; continue does not decrypt/fill/submit again",
              taskId: lost.taskId,
            })
            for (const table of (
              await pool.query<{ schemaname: string; tablename: string }>(
                "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','dbos')"
              )
            ).rows) {
              const data = JSON.stringify(
                (
                  await pool.query(
                    `SELECT to_jsonb(t) FROM "${table.schemaname}"."${table.tablename}" t`
                  )
                ).rows
              )
              for (const value of vaultPlaintexts)
                assert(
                  !data.includes(value),
                  `Plaintext in ${table.schemaname}.${table.tablename}`
                )
            }
            assert.deepEqual(pageErrors, [])
            assert.deepEqual(
              (
                await pool.query(
                  "SELECT status,count(*)::int AS n FROM tasks GROUP BY status ORDER BY status"
                )
              ).rows,
              [
                { status: "cancelled", n: 1 },
                { status: "completed", n: 14 },
              ]
            )
            await context.request.post(`${process.env.APP_URL}/api/auth/sign-out`, {
              headers,
              data: {},
            })
            assert.equal(
              (
                await context.request.post(endpoint, {
                  headers,
                  data: { action: "takeover", payloadVersion: 1 },
                })
              ).status(),
              401
            )
            paymentTasksEvaluated = 15
            checks.push({
              check:
                "Fifteen actual payment-preparation tasks (14 complete,1 actual cancel); full PAN/holder/UPI samples absent from public/DBOS/model/guest/worker/Web records; expiry remains intentionally disclosed metadata; no actual payments or automatic payment submissions evaluated",
              taskCount: paymentTasksEvaluated,
            })
          }
        } else if (focus === "identity") {
          async function audit(run: FillRun) {
            return (
              await pool.query(
                `SELECT
              (SELECT count(*)::int FROM task_events WHERE task_id=$1 AND type='vault_released') AS releases,
              (SELECT count(*)::int FROM task_action_attempts WHERE task_id=$1 AND secret_released_at IS NOT NULL) AS dispatches,
              (SELECT count(*)::int FROM task_requests WHERE task_id=$1 AND payload->>'purpose'='vault_fill') AS approvals`,
                [run.taskId]
              )
            ).rows[0]
          }
          const normal = await fillRun("fill_identity_normal"),
            normalRequest = await approval(normal)
          assert.equal((normal.expected as Record<string, string>).address.length, 1210)
          const endpoint = `${process.env.APP_URL}/api/task-requests/${normalRequest.id}/respond`
          await page.goto(`${process.env.APP_URL}/?task=${normal.taskId}`)
          await page
            .getByRole("heading", { name: "授权一次凭据填写", exact: true })
            .waitFor()
          assert.equal(await page.getByLabel("本次填写字段").locator("li").count(), 10)
          for (const label of ["姓名", "邮箱", "电话", "完整地址", "国家/地区"])
            await page
              .getByLabel("本次填写字段")
              .getByText(label, { exact: true })
              .waitFor()
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false
          )
          await page.screenshot({
            path: path.join(directory, "identity-fill-mobile.png"),
            fullPage: true,
          })
          await page.setViewportSize({ width: 1440, height: 1100 })
          await page.screenshot({
            path: path.join(directory, "identity-fill-desktop.png"),
            fullPage: true,
          })
          assert.equal(
            (
              await context.request.post(endpoint, {
                headers,
                data: {
                  decision: "approve",
                  payloadVersion: 1,
                  response: { name: "injected" },
                },
              })
            ).status(),
            400
          )
          await page.getByRole("button", { name: "同意本次填写", exact: true }).click()
          await until(async () => !!normal.scenario.release, "ten identity fields filled")
          const normalState = await site(normal)
          assert.deepEqual(
            normalState.events,
            Object.keys(normal.expected).map((field) => ({
              field,
              matched: true,
              masked: true,
            }))
          )
          assert.equal(normalState.submissions, 0)
          assert.deepEqual(await audit(normal), {
            releases: 1,
            dispatches: 1,
            approvals: 1,
          })
          const [task] = await db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, normal.taskId))
          const grant = normalRequest.payload as any
          const input = vaultFillInputSchema.parse({
            itemId: grant.itemId,
            revision: grant.revision,
            pageId: grant.pageId,
            observationId: grant.observationId,
            fields: grant.fields.map(({ field, ref }: any) => ({ field, ref })),
          })
          const saved = (
            await pool.query(
              "SELECT receipt FROM task_actions WHERE task_id=$1 AND kind='vault_fill'",
              [normal.taskId]
            )
          ).rows[0].receipt
          await deleteVaultItem(grant.itemId, grant.revision)
          assert.deepEqual(
            await executeVaultFill(
              task,
              grant.segmentNo,
              grant.actionNo,
              input,
              grant.epoch
            ),
            saved
          )
          assert.deepEqual(await site(normal), normalState)
          const subsequent = (
            await pool.query(
              "SELECT kind FROM task_actions WHERE task_id=$1 AND action_no>$2 ORDER BY action_no",
              [normal.taskId, grant.actionNo]
            )
          ).rows
          assert.equal(subsequent[0].kind, "browser_observe")
          assert(
            !subsequent.some((row) =>
              ["screen_capture", "browser_screenshot", "browser_click"].includes(row.kind)
            )
          )
          await finish(normal)
          checks.push({
            check:
              "Ten identity fields including 1210-character derived textarea address match and are masked; actual mobile/desktop approval; one release, zero submit; deleted-item replay returns known receipt without decrypt/retype; fresh DOM, no automatic screenshot",
            taskId: normal.taskId,
            state: normalState,
          })

          const provisioned = await fillRun("fill_identity_provision"),
            provision = await pending(provisioned.taskId, "vault_secret")
          await page.setViewportSize({ width: 390, height: 844 })
          await page.goto(`${process.env.APP_URL}/?task=${provisioned.taskId}`)
          await page
            .getByRole("heading", { name: "安全提供身份资料", exact: true })
            .waitFor()
          for (const [field, label] of [
            ["name", "姓名"],
            ["email", "Email"],
            ["phone", "Phone"],
          ])
            await page
              .getByLabel(label, { exact: true })
              .fill((provisioned.expected as Record<string, string>)[field])
          await page
            .getByRole("checkbox", {
              name: "保存到保险箱供以后使用；取消勾选则仅本任务有效",
            })
            .uncheck()
          const response = page.waitForResponse(
            (r) =>
              r.url().endsWith(`/task-requests/${provision.id}/secret`) &&
              r.request().method() === "POST"
          )
          await page.getByRole("button", { name: "安全提供并继续", exact: true }).click()
          const providedResponse = await response
          assert.equal(providedResponse.status(), 202)
          assert.equal(providedResponse.request().postDataJSON().save, false)
          const reference = await providedResponse.json()
          const providedGrant = await approval(provisioned)
          assert.equal(providedGrant.payload.itemId, reference.itemId)
          await respondToRequest(ownerId, providedGrant.id, "approve", 1, {})
          await until(
            async () => !!provisioned.scenario.release,
            "temporary identity fills"
          )
          assert.deepEqual(
            (await site(provisioned)).events,
            Object.keys(provisioned.expected).map((field) => ({
              field,
              matched: true,
              masked: true,
            }))
          )
          await sweepVault()
          assert.equal(
            (
              await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [
                reference.itemId,
              ])
            ).rowCount,
            0
          )
          assert.deepEqual(await audit(provisioned), {
            releases: 1,
            dispatches: 1,
            approvals: 1,
          })
          await finish(provisioned)
          checks.push({
            check:
              "Authenticated mobile secure form provisions task-scoped identity by reference; separate approval types all three fields once; consumed ciphertext cleaned while audit remains",
            taskId: provisioned.taskId,
          })

          for (const kind of ["missing", "decline", "kind", "card", "upi", "select"]) {
            const run = await fillRun(
              `fill_identity_${kind}`,
              kind === "select" ? "select" : "normal"
            )
            if (["missing", "decline"].includes(kind)) {
              const request = await approval(run)
              await respondToRequest(
                ownerId,
                request.id,
                kind === "decline" ? "decline" : "approve",
                1,
                {}
              )
            }
            await until(
              async () => !!run.scenario.release,
              `identity ${kind} returns safe outcome`
            )
            assert.deepEqual((await site(run)).events, [])
            assert.equal((await site(run)).submissions, 0)
            assert.deepEqual(await audit(run), {
              releases: 0,
              dispatches: 0,
              approvals: ["missing", "decline"].includes(kind) ? 1 : 0,
            })
            const messages = JSON.stringify(run.scenario.calls.at(-1)!.messages)
            assert.match(
              messages,
              kind === "missing"
                ? /条目没有保存指定字段/
                : kind === "decline"
                  ? /Decision: decline\./
                  : kind === "kind"
                    ? /does not contain/
                    : kind === "select"
                      ? /target fields changed/
                      : /Payment approval required/
            )
            assert(
              !(await getTask(ownerId, run.taskId)).requests.some(
                (request) => request.payload.purpose === "execution_error"
              )
            )
            await finish(run)
            checks.push({
              check: `Identity ${kind}: safe explicit rejection, no release/input/submit, no execution-error wait or automatic retry; payment kinds remain unavailable`,
              taskId: run.taskId,
            })
          }
          const partial = await fillRun("fill_identity_partial", "partial"),
            partialGrant = await approval(partial)
          await respondToRequest(ownerId, partialGrant.id, "approve", 1, {})
          const partialReview = await review(partial)
          assert.deepEqual((partialReview.payload.details as any).filled, ["name"])
          await respondToRequest(ownerId, partialReview.id, "continue", 1, {})
          await until(
            async () => !!partial.scenario.release,
            "identity partial explained"
          )
          assert.deepEqual((await site(partial)).events, [
            { field: "name", matched: true, masked: true },
          ])
          assert.equal((await site(partial)).submissions, 0)
          await finish(partial)
          checks.push({
            check:
              "First identity input navigates; remaining fields stop; actual review/continue never refills or submits",
            taskId: partial.taskId,
          })

          const lost = await fillRun("fill_identity_lost_receipt"),
            lostGrant = await approval(lost)
          const lock = await pool.connect()
          try {
            await lock.query("SELECT pg_advisory_lock(20261025,814)")
            await pool.query(
              `CREATE FUNCTION fixture_hold_identity_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${lost.taskId}' AND NEW.kind='vault_fill' AND NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(20261025,814); END IF; RETURN NEW; END $$`
            )
            await pool.query(
              "CREATE TRIGGER fixture_hold_identity_receipt BEFORE UPDATE ON task_actions FOR EACH ROW EXECUTE FUNCTION fixture_hold_identity_receipt()"
            )
            await respondToRequest(ownerId, lostGrant.id, "approve", 1, {})
            await until(
              async () =>
                (
                  await pool.query(
                    "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
                  )
                ).rowCount! > 0,
              "identity effect before host receipt"
            )
            const receipt = await controller(lost.agentId, "/action-status", {
              id: `${lost.taskId}-s1-a${lostGrant.payload.actionNo}`,
            })
            assert.equal(receipt.status, "succeeded")
            await stop()
            await docker([
              "exec",
              workstationName(lost.agentId),
              "rm",
              `/home/agent/.local/state/personal-agent/actions/${lost.taskId}-s1-a${lostGrant.payload.actionNo}.json`,
            ])
          } finally {
            await lock.query("SELECT pg_advisory_unlock(20261025,814)")
            await pool.query(
              "DROP TRIGGER fixture_hold_identity_receipt ON task_actions; DROP FUNCTION fixture_hold_identity_receipt()"
            )
            lock.release()
          }
          await start()
          const unknown = await review(lost)
          await assert.rejects(
            respondToRequest(ownerId, unknown.id, "complete", 1, {}),
            /Unsupported/
          )
          await respondToRequest(ownerId, unknown.id, "continue", 1, {})
          await until(async () => !!lost.scenario.release, "identity unknown reconciled")
          assert.deepEqual(
            (await site(lost)).events,
            Object.keys(lost.expected).map((field) => ({
              field,
              matched: true,
              masked: true,
            }))
          )
          assert.equal((await site(lost)).submissions, 0)
          assert.deepEqual(await audit(lost), {
            releases: 1,
            dispatches: 1,
            approvals: 1,
          })
          await finish(lost)
          checks.push({
            check:
              "Identity effect plus deterministic worker SIGKILL/receipt removal remains unknown; review permits continue/cancel only, no second release/input/submission",
            taskId: lost.taskId,
          })

          for (const table of (
            await pool.query<{ schemaname: string; tablename: string }>(
              "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','dbos')"
            )
          ).rows) {
            const data = JSON.stringify(
              (
                await pool.query(
                  `SELECT to_jsonb(t) FROM "${table.schemaname}"."${table.tablename}" t`
                )
              ).rows
            )
            for (const value of vaultPlaintexts)
              assert(
                !data.includes(value),
                `Plaintext in ${table.schemaname}.${table.tablename}`
              )
          }
          assert.deepEqual(pageErrors, [])
          const counts = (
            await pool.query(
              "SELECT status,count(*)::int AS n FROM tasks GROUP BY status ORDER BY status"
            )
          ).rows
          assert.deepEqual(counts, [{ status: "completed", n: 10 }])
          await context.request.post(`${process.env.APP_URL}/api/auth/sign-out`, {
            headers,
            data: {},
          })
          assert.equal(
            (
              await context.request.post(endpoint, {
                headers,
                data: { decision: "approve", payloadVersion: 1, response: {} },
              })
            ).status(),
            401
          )
          identityTasksEvaluated = 10
          checks.push({
            check:
              "Ten actual identity-slice tasks completed; all public/DBOS tables and controlled model requests contain no sample identity values; post-logout approval rejected; card/UPI/payment and real models remain unevaluated",
            taskCount: identityTasksEvaluated,
          })
        } else {
          const normal = await fillRun("fill_normal"),
            normalRequest = await approval(normal)
          const endpoint = `${process.env.APP_URL}/api/task-requests/${normalRequest.id}/respond`
          assert.equal(
            (
              await context.request.post(endpoint, {
                headers,
                data: {
                  decision: "approve",
                  payloadVersion: 1,
                  response: { password: "not-accepted" },
                },
              })
            ).status(),
            400
          )
          assert.equal(
            (
              await context.request.post(endpoint, {
                headers: { Origin: "https://untrusted.fixture.test" },
                data: { decision: "approve", payloadVersion: 1, response: {} },
              })
            ).status(),
            403
          )
          await page.goto(`${process.env.APP_URL}/?task=${normal.taskId}`)
          await page
            .getByRole("heading", { name: "授权一次凭据填写", exact: true })
            .waitFor()
          await page.getByText(origin, { exact: true }).waitFor()
          assert.equal(await page.getByLabel("本次填写字段").locator("li").count(), 2)
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false
          )
          await page.screenshot({
            path: path.join(directory, "vault-fill-mobile.png"),
            fullPage: true,
          })
          await page.setViewportSize({ width: 1440, height: 1000 })
          await page.screenshot({
            path: path.join(directory, "vault-fill-desktop.png"),
            fullPage: true,
          })
          await page.getByRole("button", { name: "同意本次填写", exact: true }).click()
          await until(
            async () => !!normal.scenario.release,
            "normal login reaches completion"
          )
          const signedIn = await site(normal)
          assert.equal(signedIn.signedIn, true)
          assert.equal(signedIn.submissions, 1)
          assert.deepEqual(signedIn.events, [
            { field: "username", matched: true, masked: true },
            { field: "password", matched: true, masked: true },
          ])
          const [task] = await db
            .select()
            .from(schema.tasks)
            .where(eq(schema.tasks.id, normal.taskId))
          const grant = normalRequest.payload as any
          const input = vaultFillInputSchema.parse({
            itemId: grant.itemId,
            revision: grant.revision,
            pageId: grant.pageId,
            observationId: grant.observationId,
            fields: grant.fields.map(({ field, ref }: any) => ({ field, ref })),
          })
          const savedFill = (
            await pool.query(
              "SELECT receipt FROM task_actions WHERE task_id=$1 AND kind='vault_fill'",
              [normal.taskId]
            )
          ).rows[0].receipt
          await deleteVaultItem(grant.itemId, grant.revision)
          assert.deepEqual(
            await executeVaultFill(
              task,
              grant.segmentNo,
              grant.actionNo,
              input,
              grant.epoch
            ),
            savedFill
          )
          assert.deepEqual(
            await site(normal),
            signedIn,
            "Saved receipt does not decrypt or type after item deletion"
          )
          const subsequent = (
            await pool.query(
              "SELECT kind FROM task_actions WHERE task_id=$1 AND action_no>$2 ORDER BY action_no",
              [normal.taskId, grant.actionNo]
            )
          ).rows
          assert.equal(subsequent[0].kind, "browser_observe")
          assert(
            !subsequent.some((row) =>
              ["screen_capture", "browser_screenshot"].includes(row.kind)
            ),
            "No automatic screenshot after sensitive fill"
          )
          await finish(normal)
          checks.push({
            check:
              "Real owner approval UI binds exact origin/version/two targets; matched and masked login fills once, independently signs in once; deleted-item replay uses host receipt without decrypt/retype; fresh DOM replaces automatic screenshots; auth/Origin/secret-in-approval rejected",
            taskId: normal.taskId,
          })

          const otp = await fillRun("fill_otp"),
            provision = await pending(otp.taskId, "vault_secret")
          await page.setViewportSize({ width: 390, height: 844 })
          await page.goto(`${process.env.APP_URL}/?task=${otp.taskId}`)
          await page
            .getByRole("heading", { name: "安全提供验证码", exact: true })
            .waitFor()
          await page.getByLabel("验证码", { exact: true }).fill(otp.code)
          const provided = page.waitForResponse(
            (response) =>
              response.url().endsWith(`/task-requests/${provision.id}/secret`) &&
              response.request().method() === "POST"
          )
          await page.getByRole("button", { name: "安全提供并继续", exact: true }).click()
          const providedResponse = await provided
          assert.equal(providedResponse.status(), 202)
          const providedItem = await providedResponse.json()
          assert(providedItem.itemId)
          const otpGrant = await approval(otp)
          await page
            .getByRole("heading", { name: "授权一次凭据填写", exact: true })
            .waitFor()
          await page.getByRole("button", { name: "同意本次填写", exact: true }).click()
          await until(async () => !!otp.scenario.release, "OTP login confirmed")
          const otpState = await site(otp)
          assert.deepEqual(otpState.events, [
            { field: "code", matched: true, masked: true },
          ])
          assert.equal(otpState.signedIn, true)
          assert.equal(otpState.submissions, 1)
          await sweepVault()
          assert.equal(
            (
              await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [
                otpGrant.payload.itemId,
              ])
            ).rowCount,
            0
          )
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND type='vault_released'",
                [otp.taskId]
              )
            ).rows[0].n,
            1
          )
          await finish(otp)
          checks.push({
            check:
              "Actual secure OTP form feeds only an item reference; one approved code input and sign-in; consumed task-scoped code removed while release audit remains",
            taskId: otp.taskId,
          })

          const changed = await fillRun("fill_changed"),
            changedRequest = await approval(changed)
          await site(changed, "/mode", { mode: "changed" })
          await until(
            async () => (await site(changed)).changed,
            "target descriptor changed without changing ref"
          )
          await respondToRequest(ownerId, changedRequest.id, "approve", 1, {})
          await until(async () => !!changed.scenario.release, "changed target rejected")
          assert.deepEqual((await site(changed)).events, [])
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM task_actions WHERE task_id=$1 AND kind='vault_fill'",
                [changed.taskId]
              )
            ).rows[0].status,
            "failed"
          )
          await finish(changed)
          for (const invalid of ["expired", "revision"]) {
            const run = await fillRun(`fill_${invalid}`),
              request = await approval(run)
            if (invalid === "expired")
              await pool.query(
                "UPDATE task_requests SET payload=jsonb_set(payload,'{expiresAt}',$2::jsonb) WHERE id=$1",
                [request.id, JSON.stringify(new Date(Date.now() - 1000).toISOString())]
              )
            else
              await pool.query("UPDATE vault_items SET revision=revision+1 WHERE id=$1", [
                run.scenario.itemId,
              ])
            await assert.rejects(
              respondToRequest(ownerId, request.id, "approve", 1, {}),
              /变化|过期/
            )
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM task_action_attempts WHERE task_id=$1 AND secret_released_at IS NOT NULL",
                  [run.taskId]
                )
              ).rowCount,
              0
            )
            assert.deepEqual((await site(run)).events, [])
            await respondToRequest(ownerId, request.id, "decline", 1, {})
            await finish(run)
          }
          const wrong = await fillRun(
            "fill_wrong_origin",
            "normal",
            "https://other.fixture.test"
          )
          await until(
            async () => !!wrong.scenario.release,
            "wrong-origin request blocked"
          )
          assert.equal((await getTask(ownerId, wrong.taskId)).requests.length, 0)
          assert.deepEqual((await site(wrong)).events, [])
          await finish(wrong)
          checks.push({
            check:
              "Changed descriptor is rejected before typing; expired/revision-changed grants cannot approve or release values; wrong exact origin never obtains a grant; all have zero inputs",
            taskIds: [changed.taskId, wrong.taskId],
          })

          const restarted = await fillRun("fill_restart"),
            old = await approval(restarted),
            callsBefore = restarted.scenario.calls.length
          await stop()
          await start()
          assert.equal(
            restarted.scenario.calls.length,
            callsBefore,
            "Waiting restart reuses model decisions"
          )
          await assert.rejects(
            respondToRequest(ownerId, old.id, "approve", 1, {}),
            /现场已变化/
          )
          await respondToRequest(ownerId, old.id, "decline", 1, {})
          const fresh = await approval(restarted)
          assert.notEqual(fresh.id, old.id)
          assert.notEqual(fresh.payload.epoch, old.payload.epoch)
          await respondToRequest(ownerId, fresh.id, "approve", 1, {})
          await until(
            async () => !!restarted.scenario.release,
            "fresh grant after restart signs in"
          )
          assert.equal((await site(restarted)).events.length, 2)
          assert.equal((await site(restarted)).signedIn, true)
          await finish(restarted)
          checks.push({
            check:
              "SIGKILL during approval wait preserves decision but fences old grant; owner declines it, fresh observation/epoch obtains a distinct approval and fills once",
            taskId: restarted.taskId,
          })

          for (const window of ["guest_receipt", "host_receipt", "lost_receipt"]) {
            const run = await fillRun(
                `fill_${window}`,
                window === "host_receipt" ? "hold" : "normal"
              ),
              request = await approval(run)
            const lock = await pool.connect()
            try {
              if (window !== "host_receipt") {
                await lock.query("SELECT pg_advisory_lock(20261025,813)")
                await pool.query(
                  `CREATE FUNCTION fixture_hold_fill_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${run.taskId}' AND NEW.kind='vault_fill' AND NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(20261025,813); END IF; RETURN NEW; END $$`
                )
                await pool.query(
                  "CREATE TRIGGER fixture_hold_fill_receipt BEFORE UPDATE ON task_actions FOR EACH ROW EXECUTE FUNCTION fixture_hold_fill_receipt()"
                )
              }
              await respondToRequest(ownerId, request.id, "approve", 1, {})
              if (window === "host_receipt") {
                await until(
                  async () => (await site(run)).events.length === 1,
                  "first input before controlled fill pause"
                )
                await lock.query("BEGIN")
                await lock.query("LOCK TABLE dbos.operation_outputs IN SHARE MODE")
                await site(run, "/mode", { mode: "normal" })
                await until(
                  async () =>
                    (
                      await pool.query(
                        "SELECT status FROM task_actions WHERE task_id=$1 AND kind='vault_fill'",
                        [run.taskId]
                      )
                    ).rows[0]?.status === "succeeded",
                  "host receipt committed before framework checkpoint"
                )
              } else {
                await until(
                  async () =>
                    (
                      await pool.query(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'"
                      )
                    ).rowCount! > 0,
                  "host receipt deterministically blocked after guest effect"
                )
                const receipt = await controller(run.agentId, "/action-status", {
                  id: `${run.taskId}-s1-a${request.payload.actionNo}`,
                })
                assert.equal(receipt.status, "succeeded")
              }
              await stop()
              if (window === "lost_receipt") {
                await docker([
                  "exec",
                  workstationName(run.agentId),
                  "rm",
                  `/home/agent/.local/state/personal-agent/actions/${run.taskId}-s1-a${request.payload.actionNo}.json`,
                ])
              }
            } finally {
              if (window === "host_receipt") await lock.query("ROLLBACK")
              else {
                await lock.query("SELECT pg_advisory_unlock(20261025,813)")
                await pool.query(
                  "DROP TRIGGER fixture_hold_fill_receipt ON task_actions; DROP FUNCTION fixture_hold_fill_receipt()"
                )
              }
              lock.release()
            }
            if (window !== "lost_receipt") await deleteVaultItem(run.scenario.itemId!, 1)
            await start()
            if (window === "lost_receipt") {
              const unknown = await review(run)
              await assert.rejects(
                respondToRequest(ownerId, unknown.id, "complete", 1, {}),
                /Unsupported/
              )
              assert.equal((await site(run)).submissions, 0)
              await respondToRequest(ownerId, unknown.id, "continue", 1, {})
            }
            await until(
              async () => !!run.scenario.release,
              "recovered fill reaches controlled outcome"
            )
            const state = await site(run)
            assert.deepEqual(state.events, [
              { field: "username", matched: true, masked: true },
              { field: "password", matched: true, masked: true },
            ])
            assert.equal(state.submissions, window === "lost_receipt" ? 0 : 1)
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND type='vault_released'",
                  [run.taskId]
                )
              ).rows[0].n,
              1
            )
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM task_action_attempts WHERE task_id=$1 AND secret_released_at IS NOT NULL",
                  [run.taskId]
                )
              ).rows[0].n,
              1
            )
            await finish(run)
            checks.push({
              check: `${window}: deterministic receipt/checkpoint interruption; restart never releases or types twice; known receipts survive deleted items; lost receipt requires explicit continue/cancel, not completion`,
              taskId: run.taskId,
            })
          }
          for (const mode of ["partial", "timeout"]) {
            const run = await fillRun(`fill_${mode}`, mode),
              request = await approval(run)
            await respondToRequest(ownerId, request.id, "approve", 1, {})
            const unknown = await review(run)
            assert.deepEqual((unknown.payload.details as any).filled, ["username"])
            assert((unknown.payload.details as any).attempted.includes("username"))
            await assert.rejects(
              respondToRequest(ownerId, unknown.id, "complete", 1, {}),
              /Unsupported/
            )
            await respondToRequest(ownerId, unknown.id, "continue", 1, {})
            await until(
              async () => !!run.scenario.release,
              "partial outcome explained without refill"
            )
            assert.deepEqual((await site(run)).events, [
              { field: "username", matched: true, masked: true },
            ])
            assert.equal((await site(run)).submissions, 0)
            await finish(run)
            checks.push({
              check: `${mode}: only known first field entered; safe attempted/filled details reach review, raw fill arguments absent; continue does not resubmit or refill`,
              taskId: run.taskId,
            })
          }
          const cancelled = await fillRun("fill_cancel", "hold"),
            cancelGrant = await approval(cancelled)
          await respondToRequest(ownerId, cancelGrant.id, "approve", 1, {})
          await until(
            async () => (await site(cancelled)).events.length === 1,
            "cancel while password fill is blocked"
          )
          await requestCancellation(ownerId, cancelled.taskId)
          await until(
            async () => (await getTask(ownerId, cancelled.taskId)).status === "cancelled",
            "actual fill cancellation"
          )
          const boundary = await dockerRaw([
            "inspect",
            "--type",
            "container",
            "--format",
            "{{.State.Running}}",
            workstationName(cancelled.agentId),
          ])
          if (boundary.exitCode === 0)
            assert.equal(boundary.stdout.toString().trim(), "false")
          else assert.match(boundary.stderr, /no such (container|object)/i)
          const cancelledJournal = await docker([
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "tar",
            "--mount",
            `type=volume,source=${workstationVolume(cancelled.agentId)},target=/audit,readonly`,
            process.env.WORKSTATION_IMAGE!,
            "-cf",
            "-",
            "-C",
            "/audit",
            ".local/state/personal-agent/actions",
          ])
          for (const value of vaultPlaintexts)
            assert(
              !cancelledJournal.stdout.includes(Buffer.from(value)),
              "Plaintext in cancelled guest journal"
            )
          await writeFile(
            path.join(directory, `${cancelled.agentId}-cancelled-journal.tar`),
            cancelledJournal.stdout
          )
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM task_actions WHERE task_id=$1 AND kind='browser_click'",
                [cancelled.taskId]
              )
            ).rowCount,
            0
          )
          checks.push({
            check:
              "Cancellation during blocked second field ends actual guest processes; task becomes cancelled with no later form submission",
            taskId: cancelled.taskId,
          })
          const tables = await pool.query<{ schemaname: string; tablename: string }>(
            "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','dbos')"
          )
          for (const table of tables.rows) {
            const data = JSON.stringify(
              (
                await pool.query(
                  `SELECT to_jsonb(t) FROM "${table.schemaname}"."${table.tablename}" t`
                )
              ).rows
            )
            for (const value of vaultPlaintexts)
              assert(
                !data.includes(value),
                `Plaintext in ${table.schemaname}.${table.tablename}`
              )
          }
          assert.deepEqual(pageErrors, [])
          await context.request.post(`${process.env.APP_URL}/api/auth/sign-out`, {
            headers,
            data: {},
          })
          assert.equal(
            (
              await context.request.post(endpoint, {
                headers,
                data: { decision: "approve", payloadVersion: 1, response: {} },
              })
            ).status(),
            401
          )
          checks.push({
            check:
              "Sample username/password/code values absent from all public/DBOS tables and model requests; post-logout approval rejected; controlled target site legitimately sees input values, guest-code secrecy not claimed",
          })
          const statuses = (
            await pool.query(
              "SELECT status,count(*)::int AS n FROM tasks GROUP BY status ORDER BY status"
            )
          ).rows
          assert.deepEqual(statuses, [
            { status: "cancelled", n: 1 },
            { status: "completed", n: 12 },
          ])
          guestFillTasksEvaluated = 13
          checks.push({
            check:
              "Actual thirteen-task coverage gate: twelve completed explicit outcomes, one real cancellation; an entry point or generic suite alone cannot pass the fill acceptance",
            taskCount: guestFillTasksEvaluated,
          })
        }
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "vaultfill-web.log"), webLog)
      }
    }
    if (focus === "vault") {
      const { decryptSecret } = await import("@/lib/secrets")
      const { vaultContext, sweepVault } = await import("@/lib/vault")
      const password = `vault-password-${randomUUID()}`,
        replacement = `vault-replacement-${randomUUID()}`,
        code = "" + Math.floor(10000000 + Math.random() * 90000000)
      vaultPlaintexts.push(password, replacement, code)
      const username = "fixture.owner@example.test",
        origin = "https://vault.fixture.test"
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Vault Web ready")
        assert.equal((await fetch(`${process.env.APP_URL}/api/vault`)).status, 401)
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          }),
          page = await context.newPage(),
          pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).waitFor()
        await page.goto(`${process.env.APP_URL}/settings`)
        const panel = page.getByRole("region", { name: "凭据保险箱", exact: true })
        await panel.getByRole("button", { name: "添加网站账号", exact: true }).click()
        await panel.getByLabel("凭据目标站点", { exact: true }).fill(origin)
        await panel.getByLabel("用户名或邮箱", { exact: true }).fill(username)
        await panel.getByLabel("密码", { exact: true }).fill(password)
        await panel.getByLabel("凭据名称", { exact: true }).fill("Vault UI fixture")
        assert(
          !JSON.stringify(
            await page.evaluate(() => ({ ...sessionStorage, ...localStorage }))
          ).includes(password)
        )
        await panel.getByRole("button", { name: "加密保存", exact: true }).click()
        await panel.getByText("Vault UI fixture", { exact: true }).waitFor()
        const api = `${process.env.APP_URL}/api/vault`,
          headers = { Origin: process.env.APP_URL! }
        const saved = (await (await context.request.get(api)).json()).find(
          (item: any) => item.label === "Vault UI fixture"
        )
        assert.equal(saved.origin, origin)
        assert.equal(saved.revision, 1)
        assert(!("secret" in saved))
        assert(!("fields" in saved))
        const first = {
          id: saved.id,
          kind: "login",
          origin,
          label: saved.label,
          fields: { username, password },
        }
        assert.equal(
          (await context.request.post(api, { headers, data: first })).status(),
          201
        )
        assert.equal(
          (
            await context.request.post(api, {
              headers,
              data: { ...first, fields: { username, password: replacement } },
            })
          ).status(),
          409
        )
        const encrypted = (
          await pool.query("SELECT secret FROM vault_items WHERE id=$1", [saved.id])
        ).rows[0].secret
        assert.match(encrypted, /^v2:/)
        assert.equal(
          JSON.parse(decryptSecret(encrypted, vaultContext(saved.id, "login"))).password,
          password
        )
        assert(!(await page.content()).includes(password))
        await panel
          .getByRole("button", { name: "替换Vault UI fixture", exact: true })
          .click()
        assert.equal(await panel.getByLabel("密码", { exact: true }).inputValue(), "")
        await panel.getByLabel("用户名或邮箱", { exact: true }).fill(username)
        await panel.getByLabel("密码", { exact: true }).fill(replacement)
        await panel.getByRole("button", { name: "加密保存", exact: true }).click()
        await until(
          async () =>
            (await pool.query("SELECT revision FROM vault_items WHERE id=$1", [saved.id]))
              .rows[0].revision === 2,
          "Vault replacement increments version"
        )
        assert.equal(
          (
            await context.request.patch(api, { headers, data: { ...first, revision: 1 } })
          ).status(),
          409
        )
        assert.equal(
          (
            await context.request.patch(api, {
              headers: { Origin: "https://untrusted.fixture.test" },
              data: { ...first, revision: 2 },
            })
          ).status(),
          403
        )
        assert.equal(
          (
            await context.request.post(api, {
              headers,
              data: { ...first, id: randomUUID(), origin: "http://public.fixture.test" },
            })
          ).status(),
          400
        )
        assert.equal(
          (
            await context.request.post(api, {
              headers,
              data: {
                id: randomUUID(),
                kind: "code",
                origin,
                label: "OTP",
                fields: { code },
              },
            })
          ).status(),
          400
        )
        const cardId = randomUUID()
        assert.equal(
          (
            await context.request.post(api, {
              headers,
              data: {
                id: cardId,
                kind: "card",
                origin,
                label: "Sample card",
                fields: { number: "4242424242424242", expiry: "08/29", cvv: "123" },
              },
            })
          ).status(),
          400
        )
        for (const item of [
          {
            id: cardId,
            kind: "card",
            label: "Sample card",
            fields: { number: "4242424242424242", expiry: "08/29" },
          },
          {
            id: randomUUID(),
            kind: "upi",
            label: "Sample UPI",
            fields: { id: "fixture@bank" },
          },
          {
            id: randomUUID(),
            kind: "identity",
            label: "Sample identity",
            fields: { name: "Sample person", city: "Sample city" },
          },
        ])
          assert.equal(
            (
              await context.request.post(api, { headers, data: { ...item, origin } })
            ).status(),
            201
          )
        assert.equal(
          (
            await context.request.delete(api, {
              headers,
              data: { id: saved.id, revision: 1 },
            })
          ).status(),
          409
        )
        await page.reload()
        await panel.getByText("Sample card", { exact: true }).waitFor()
        await panel
          .getByRole("button", { name: "删除凭据：Sample card", exact: true })
          .click()
        await panel.getByRole("button", { name: "确认删除", exact: true }).click()
        await panel
          .getByText("Sample card", { exact: true })
          .waitFor({ state: "detached" })
        assert.equal(
          (await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [cardId])).rowCount,
          0
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.screenshot({
          path: path.join(directory, "vault-settings-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "vault-settings-desktop.png"),
          fullPage: true,
        })
        checks.push({
          check:
            "Actual owner settings UI creates, masks, replaces and deletes credentials; retained card/UPI/identity schemas store encrypted values; duplicate request ids, version conflicts, public HTTP, CVV and cross-Origin mutations rejected; form values not persisted in browser storage",
          itemId: saved.id,
        })

        const selectedTask = await submit("vault_select")
        const selectedRequest = await pending(selectedTask.taskId, "vault_secret")
        const requestApi = `${process.env.APP_URL}/api/task-requests/${selectedRequest.id}`
        assert.equal(
          (
            await context.request.post(`${requestApi}/respond`, {
              headers,
              data: {
                decision: "approve",
                payloadVersion: 1,
                response: { password: replacement },
              },
            })
          ).status(),
          400
        )
        assert.equal(
          (
            await context.request.post(`${requestApi}/secret`, {
              headers: { Origin: "https://untrusted.fixture.test" },
              data: {},
            })
          ).status(),
          403
        )
        const { ensureTelegramConnection } = await import("@/lib/telegram/state")
        const { collectTelegramNotifications } =
          await import("@/lib/telegram/notifications")
        const connection = await ensureTelegramConnection(ownerId)
        await pool.query(
          "UPDATE telegram_connection SET user_id='5550001',chat_id='5550001',paired_at=now()-interval '1 minute' WHERE id=1"
        )
        await collectTelegramNotifications(connection.generation)
        const notice = (
          await pool.query("SELECT payload FROM telegram_outbox WHERE key=$1", [
            `request:${selectedRequest.id}:1`,
          ])
        ).rows[0].payload
        assert.match(notice.text, /不要在 Telegram 回复密码或验证码/)
        assert(!JSON.stringify(notice.reply_markup).includes(":approve"))
        await stop()
        await start()
        assert.equal(
          selectedTask.scenario.calls.length,
          2,
          "Waiting restart must not regenerate the model request"
        )
        await page.goto(`${process.env.APP_URL}/?task=${selectedTask.taskId}`)
        await page
          .getByRole("heading", { name: "安全提供网站账号", exact: true })
          .waitFor()
        await page.getByLabel("选择已有凭据", { exact: true }).selectOption(saved.id)
        await page
          .getByRole("button", { name: "使用这个条目的引用", exact: true })
          .click()
        await until(
          async () => !!selectedTask.scenario.release,
          "Saved-reference decision reaches model"
        )
        const selectedRow = (
          await pool.query("SELECT response,status FROM task_requests WHERE id=$1", [
            selectedRequest.id,
          ])
        ).rows[0]
        assert.deepEqual(selectedRow.response, { itemId: saved.id, revision: 2 })
        assert.equal(selectedRow.status, "resolved")
        selectedTask.scenario.release!()
        await completed(selectedTask.taskId)
        checks.push({
          check:
            "Real model protocol requests secure credentials; generic approval cannot inject secrets, Telegram offers only web provisioning/reject/cancel; worker SIGKILL during wait preserves request and reuses model decision; owner selects a versioned exact-origin item and only its reference reaches DBOS/model",
          taskId: selectedTask.taskId,
        })

        const codeTask = await submit("vault_code"),
          codeRequest = await pending(codeTask.taskId, "vault_secret")
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`${process.env.APP_URL}/?task=${codeTask.taskId}`)
        await page.getByRole("heading", { name: "安全提供验证码", exact: true }).waitFor()
        await page.getByLabel("验证码", { exact: true }).fill(code)
        await pool.query(
          `CREATE FUNCTION fixture_reject_provision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${codeRequest.id}' AND NEW.status='decided' THEN RAISE EXCEPTION 'controlled provisioning transaction failure'; END IF; RETURN NEW; END $$`
        )
        await pool.query(
          "CREATE TRIGGER fixture_reject_provision BEFORE UPDATE ON task_requests FOR EACH ROW EXECUTE FUNCTION fixture_reject_provision()"
        )
        const captured = page.waitForRequest(
          (request) =>
            request.url().endsWith(`/task-requests/${codeRequest.id}/secret`) &&
            request.method() === "POST"
        )
        await page.getByRole("button", { name: "安全提供并继续", exact: true }).click()
        const posted = (await captured).postDataJSON()
        await page.getByRole("alert").filter({ hasText: "Request failed" }).waitFor()
        assert.equal(
          (await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [posted.item.id]))
            .rowCount,
          0
        )
        assert.equal(
          (
            await pool.query("SELECT status FROM task_requests WHERE id=$1", [
              codeRequest.id,
            ])
          ).rows[0].status,
          "pending"
        )
        assert.equal(codeTask.scenario.calls.length, 2)
        await pool.query(
          "DROP TRIGGER fixture_reject_provision ON task_requests; DROP FUNCTION fixture_reject_provision()"
        )
        const secretApi = `${process.env.APP_URL}/api/task-requests/${codeRequest.id}/secret`
        assert.equal(
          (
            await context.request.post(secretApi, {
              headers,
              data: { ...posted, payloadVersion: 2 },
            })
          ).status(),
          409
        )
        assert.equal(
          (
            await context.request.post(secretApi, {
              headers,
              data: {
                ...posted,
                item: { ...posted.item, origin: "https://different.fixture.test" },
              },
            })
          ).status(),
          409
        )
        await page.getByRole("button", { name: "安全提供并继续", exact: true }).click()
        await until(
          async () => !!codeTask.scenario.release,
          "OTP reference reaches model"
        )
        const temporary = (
          await pool.query("SELECT * FROM vault_items WHERE id=$1", [posted.item.id])
        ).rows[0]
        assert.equal(temporary.ephemeral, true)
        assert.equal(temporary.scope_task_id, codeTask.taskId)
        assert.equal(
          temporary.expires_at.getTime() - temporary.created_at.getTime(),
          600000
        )
        assert.equal(
          (await context.request.post(secretApi, { headers, data: posted })).status(),
          202
        )
        assert.equal(
          (
            await context.request.post(secretApi, {
              headers,
              data: {
                ...posted,
                item: { ...posted.item, fields: { code: "different-code" } },
              },
            })
          ).status(),
          409
        )
        assert.equal(codeTask.scenario.calls.length, 3)
        await pool.query(
          "UPDATE vault_items SET expires_at=now()-interval '1 second' WHERE id=$1",
          [posted.item.id]
        )
        await sweepVault()
        assert.equal(
          (await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [posted.item.id]))
            .rowCount,
          0
        )
        assert.equal(
          (
            await pool.query("SELECT response FROM task_requests WHERE id=$1", [
              codeRequest.id,
            ])
          ).rows[0].response.itemId,
          posted.item.id
        )
        assert.equal(
          (await context.request.post(secretApi, { headers, data: posted })).status(),
          409
        )
        await page.screenshot({
          path: path.join(directory, "vault-request-mobile.png"),
          fullPage: true,
        })
        codeTask.scenario.release!()
        await completed(codeTask.taskId)
        assert.equal((await context.request.get(api)).status(), 200)
        assert(
          !(await (await context.request.get(api)).text()).includes(posted.item.id),
          "Temporary codes excluded from general list"
        )
        checks.push({
          check:
            "Actual secure OTP form: forced failure after encrypted insert/DBOS send rolls all changes back and leaves the original request waiting; same form retries once, old versions/wrong origin/conflicting values fail; code is task-scoped, expires in ten minutes and is removed on expiry while its nonsecret audit remains; replay cannot resurrect a deleted code or create another model request",
          taskId: codeTask.taskId,
        })
        const cancelled = await submit("vault_cancel"),
          cancelRequest = await pending(cancelled.taskId, "vault_secret")
        await requestCancellation(ownerId, cancelled.taskId)
        await until(
          async () => (await getTask(ownerId, cancelled.taskId)).status === "cancelled",
          "Vault cancellation"
        )
        const cancelledId = randomUUID()
        assert.equal(
          (
            await context.request.post(
              `${process.env.APP_URL}/api/task-requests/${cancelRequest.id}/secret`,
              {
                headers,
                data: {
                  action: "provide",
                  payloadVersion: 1,
                  save: true,
                  item: {
                    id: cancelledId,
                    kind: "login",
                    origin,
                    label: "Cancelled",
                    fields: { username, password },
                  },
                },
              }
            )
          ).status(),
          409
        )
        assert.equal(
          (await pool.query("SELECT 1 FROM vault_items WHERE id=$1", [cancelledId]))
            .rowCount,
          0
        )
        const tables = await pool.query<{ schemaname: string; tablename: string }>(
          "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','dbos')"
        )
        for (const table of tables.rows) {
          const data = JSON.stringify(
            (
              await pool.query(
                `SELECT to_jsonb(t) FROM "${table.schemaname}"."${table.tablename}" t`
              )
            ).rows
          )
          for (const value of vaultPlaintexts)
            assert(
              !data.includes(value),
              `Plaintext in ${table.schemaname}.${table.tablename}`
            )
        }
        assert.deepEqual(pageErrors, [])
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/auth/sign-out`, {
              headers,
              data: {},
            })
          ).status(),
          200
        )
        assert.equal((await context.request.get(api)).status(), 401)
        assert.equal(
          (await context.request.post(secretApi, { headers, data: posted })).status(),
          401
        )
        checks.push({
          check:
            "Cancelled requests cannot create credentials; post-logout vault/request access rejected; all public and DBOS tables inspected for sample plaintext values, which are absent (ciphertexts and masked metadata only)",
        })
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "vault-web.log"), webLog)
      }
    }
    if (focus === "reports") {
      const { saveRoutine, routinePlanSchema, routineOverview } =
        await import("@/lib/routines")
      const { ensureTelegramConnection } = await import("@/lib/telegram/state")
      const { collectTelegramNotifications, deliverTelegramOutbox } =
        await import("@/lib/telegram/notifications")
      const { eq } = await import("drizzle-orm")
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "周期报表 fixture",
          role: "Protocol-controlled weekly report downloads",
          model: "custom/runtime-fixture",
        })
        .returning()
      agents.push(agent.id)
      const name = workstationName(agent.id)
      const connection = await ensureTelegramConnection(ownerId)
      // Fixture identity only: pairing protocol is covered separately in test:telegram.
      await pool.query(
        "UPDATE telegram_connection SET user_id='5550001',chat_id='5550001',paired_at=now()-interval '1 second' WHERE id=1"
      )
      const baseContract = schema.completionContractSchema.parse({
        artifact: {
          path: "report.csv",
          requiredColumns: ["date", "site", "amount"],
          minRows: 2,
          dateColumn: "date",
        },
        comparison: {
          baseline: {
            path: "baseline.csv",
            requiredColumns: ["date", "site", "amount"],
            minRows: 2,
            dateColumn: "date",
          },
          valueColumn: "amount",
          kind: "percent",
          threshold: "10",
          direction: "increase",
          notify: "on_change",
        },
      })
      const results: { kind: string; taskId: string; scenario: Scenario }[] = []
      const downloadCounts: Record<string, number> = {}
      for (const kind of ["change", "quiet", "missing", "zero"]) {
        const marker = randomUUID(),
          scenario: Scenario = { kind: `compare_${kind}`, calls: [] }
        scenarios.set(marker, scenario)
        // Install fixture infrastructure after the real runtime has claimed/fenced the guest.
        scenario.beforeOpen = async () => {
          await docker([
            "cp",
            "tests/fixtures/periodic-site.mjs",
            `${name}:/tmp/periodic-site.mjs`,
          ])
          await docker(["exec", "--detach", name, "node", "/tmp/periodic-site.mjs"])
          await until(async () => {
            const probe = await dockerRaw([
              "exec",
              name,
              "curl",
              "-fsS",
              "http://127.0.0.1:8082/health",
            ])
            return probe.exitCode === 0
          }, "periodic site ready")
        }
        scenario.beforeComplete = async () => {
          Object.assign(
            downloadCounts,
            JSON.parse(
              (
                await docker([
                  "exec",
                  name,
                  "curl",
                  "-fsS",
                  "http://127.0.0.1:8082/state",
                ])
              ).stdout.toString()
            )
          )
        }
        const plan = routinePlanSchema.parse({
          name: `周期比较 ${kind}`,
          agentId: agent.id,
          prompt: `CASE=compare_${kind} RUN=${marker} Download four report parts, merge each period and deliver both CSV files.`,
          schedule: { kind: "once", at: "2090-10-19T09:00" },
          timeZone: "Asia/Taipei",
          dateRange: "previous_week",
          completionContract: { ...baseContract, requireHumanReview: kind === "zero" },
          enabled: false,
          budget: { maxSteps: 30 },
        })
        const routine = await saveRoutine(plan)
        await db
          .update(schema.routines)
          .set({
            enabled: true,
            schedule: { kind: "once", at: "2026-10-19T09:00" },
            nextRunAt: new Date("2026-10-19T01:00:00Z"),
          })
          .where(eq(schema.routines.id, routine.id))
        const linked = await until(
          async () =>
            (
              await pool.query(
                "SELECT task_id FROM routine_runs WHERE routine_id=$1 AND task_id IS NOT NULL",
                [routine.id]
              )
            ).rows[0],
          "actual periodic schedule accepts frozen report task"
        )
        const frozen = (
          await pool.query("SELECT completion_contract FROM tasks WHERE id=$1", [
            linked.task_id,
          ])
        ).rows[0].completion_contract
        assert.equal(frozen.artifact.dateFrom, "2026-10-12")
        assert.equal(frozen.artifact.dateTo, "2026-10-18")
        assert.equal(frozen.comparison.baseline.dateFrom, "2026-10-05")
        assert.equal(frozen.comparison.baseline.dateTo, "2026-10-11")
        if (kind === "missing") {
          await until(
            async () => !!scenario.release,
            "missing baseline rejected by real completion gate"
          )
          assert.notEqual((await getTask(ownerId, linked.task_id)).status, "completed")
          await collectTelegramNotifications(connection.generation)
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM telegram_outbox WHERE key LIKE $1",
                [`task:${linked.task_id}:%`]
              )
            ).rows[0].n,
            0
          )
          scenario.release!()
        }
        if (kind === "zero") {
          const request = await pending(linked.task_id, "completion")
          assert.equal((request.payload.comparison as any).currentTotal, "330")
          assert.equal((request.payload.comparison as any).needsAttention, true)
          await collectTelegramNotifications(connection.generation)
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM telegram_outbox WHERE key=$1",
                [`request:${request.id}:${request.payloadVersion}`]
              )
            ).rows[0].n,
            1
          )
          await docker([
            "exec",
            name,
            "bash",
            "-c",
            "printf 'date,site,amount\\n2026-10-12,X,999999\\n' > /home/agent/report.csv; printf 'date,site,amount\\n2026-10-05,X,999999\\n' > /home/agent/baseline.csv",
          ])
          await stop()
          await start()
          await respondToRequest(
            ownerId,
            request.id,
            "complete",
            request.payloadVersion,
            {}
          )
        }
        const task = await completed(linked.task_id)
        const comparison = task.result!.comparison as any
        assert.equal(comparison.currentTotal, kind === "quiet" ? "300" : "330")
        assert.equal(comparison.baselineTotal, kind === "zero" ? "0" : "300")
        assert.equal(comparison.notification.send, kind !== "quiet")
        assert.equal(comparison.needsAttention, kind === "zero")
        assert.equal(task.artifacts.length, 2)
        assert.equal(scenario.calls.length, kind === "missing" ? 12 : 11)
        results.push({ kind, taskId: task.id, scenario })
      }
      const downloads = downloadCounts
      assert.equal(Object.keys(downloads).length, 16)
      assert(
        Object.values(downloads).every((count) => count === 1),
        "Recovering a human wait must not download source reports again"
      )
      checks.push({
        check:
          "Four actual DBOS-triggered weekly runs use frozen current/baseline weeks, shared-browser DOM downloads (16 files), guest CSV merge and host-only exact sum; changed/equal/zero-baseline decisions ignore contradictory model summaries; missing baseline cannot complete; human confirmation survives worker SIGKILL without model/download repetition",
        taskIds: results.map((result) => result.taskId),
      })
      const quiet = results.find((result) => result.kind === "quiet")!
      const cancelMarker = randomUUID(),
        cancelScenario: Scenario = { kind: "compare_cancel", calls: [] }
      scenarios.set(cancelMarker, cancelScenario)
      const cancellation = await submitTask(ownerId, "test", {
        agentId: agent.id,
        clientRequestId: cancelMarker,
        goal: `CASE=compare_cancel RUN=${cancelMarker} Cancelled comparison fixture.`,
        completionContract: baseContract,
        budget: { maxSteps: 20 },
      })
      await until(
        async () => !!cancelScenario.pending,
        "comparison model request in flight"
      )
      await requestCancellation(ownerId, cancellation.taskId)
      await until(async () => {
        const task = await getTask(ownerId, cancellation.taskId)
        return task.status === "cancelled" && !task.cancelWorkflowPending
      }, "comparison cancellation confirmed")
      const beforeRestart = structuredClone((await getTask(ownerId, quiet.taskId)).result)
      await stop()
      await start()
      assert.deepEqual((await getTask(ownerId, quiet.taskId)).result, beforeRestart)
      const views = await routineOverview(ownerId)
      assert(
        views.runs.find((run) => run.task_id === quiet.taskId)!.comparison!.notification
          .send === false
      )
      await collectTelegramNotifications(connection.generation)
      await collectTelegramNotifications(connection.generation)
      const notices = (
        await pool.query(
          "SELECT key,payload FROM telegram_outbox WHERE key LIKE 'task:%'"
        )
      ).rows
      assert.equal(notices.length, 4)
      assert(!notices.some((notice) => notice.key.includes(quiet.taskId)))
      assert(
        notices
          .filter((notice) => notice.key.endsWith(":completed"))
          .every((notice) => notice.payload.text.includes("程序核对 amount 合计"))
      )
      assert(
        notices.some((notice) => notice.key === `task:${cancellation.taskId}:cancelled`)
      )
      checks.push({
        check:
          "Persisted comparison and notification decision survive worker restart; repeated Telegram collection emits three completed notices, a real cancellation notice and no unchanged notice, with program totals preceding unverified model text; a human review request still notifies",
      })

      const sent: string[] = []
      const bot = createServer(async (req, res) => {
        let raw = ""
        for await (const chunk of req) raw += chunk
        const input = JSON.parse(raw)
        sent.push(input.text)
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length, chat: { id: 5550001 } },
          })
        )
      })
      bot.listen(0, "127.0.0.1")
      await once(bot, "listening")
      await setSetting(
        "telegram.apiUrl",
        `http://127.0.0.1:${(bot.address() as { port: number }).port}`
      )
      try {
        const signal = new AbortController().signal
        while (
          await deliverTelegramOutbox(
            "controlled-report-token",
            connection.generation,
            signal
          )
        ) {
          /* drain persisted fixture notices */
        }
        assert.equal(sent.filter((text) => text.startsWith("任务完成")).length, 3)
        assert.equal(sent.filter((text) => text.startsWith("任务已取消")).length, 1)
        assert.equal(sent.filter((text) => text.startsWith("需要你处理")).length, 1)
      } finally {
        bot.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          bot.close((error) => (error ? reject(error) : resolve()))
        )
      }
      checks.push({
        check:
          "The existing outbox sends the three accepted task notifications to an actual controlled HTTP Bot API; suppressed completion creates no send attempt. Pairing and real Telegram connectivity are separate checks.",
      })
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Report Web ready")
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          }),
          page = await context.newPage(),
          errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "定时例程", exact: true }).waitFor()
        await page.goto(`${process.env.APP_URL}/?task=${quiet.taskId}`)
        const card = page.getByRole("region", { name: "程序比较结果", exact: true })
        await card
          .getByText("通知决策：保持安静；本次成果和核对记录已保存。", { exact: true })
          .waitFor()
        await page
          .getByRole("article", { name: "交付结果", exact: true })
          .getByText("模型声称发生巨大变化；请以程序比较为准。", { exact: true })
          .waitFor()
        const baseline = (await getTask(ownerId, quiet.taskId)).result!.comparison as any
        const downloaded = await context.request.get(
          `${process.env.APP_URL}/api/artifacts/${baseline.baselineArtifactId}`
        )
        assert.equal(downloaded.status(), 200)
        assert.match(await downloaded.text(), /2026-10-05,A,100/)
        await page.screenshot({
          path: path.join(directory, "report-result-mobile.png"),
          fullPage: true,
        })
        await page.getByRole("link", { name: "定时例程", exact: true }).click()
        await page.locator("summary").filter({ hasText: "成果检查与单次预算" }).click()
        await page.getByLabel("名称", { exact: true }).fill("网页条件通知 fixture")
        await page.getByLabel("执行 Agent", { exact: true }).selectOption(agent.id)
        await page
          .getByLabel("每次要做的工作", { exact: true })
          .fill("下载两期 CSV 并比较。")
        await page.getByLabel("比较前后两周报表", { exact: true }).check()
        await page.getByLabel("变化阈值", { exact: true }).fill("5.25")
        await page.getByLabel("变化方向", { exact: true }).selectOption("decrease")
        await page.getByLabel("启用计划", { exact: true }).uncheck()
        assert.equal(
          await page.getByLabel("日期范围", { exact: true }).inputValue(),
          "previous_week"
        )
        await page.screenshot({
          path: path.join(directory, "report-rule-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "report-rule-desktop.png"),
          fullPage: true,
        })
        await page.getByRole("button", { name: "创建计划", exact: true }).click()
        await page
          .getByText("计划已保存。已受理的任务继续使用原计划快照。", { exact: true })
          .waitFor()
        const created = (
          await pool.query(
            "SELECT date_range,completion_contract FROM routines WHERE name='网页条件通知 fixture'"
          )
        ).rows[0]
        assert.equal(created.date_range, "previous_week")
        assert.equal(created.completion_contract.comparison.threshold, "5.25")
        assert.equal(created.completion_contract.comparison.direction, "decrease")
        assert.deepEqual(errors, [])
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "reports-web.log"), webLog)
      }
      checks.push({
        check:
          "Actual mobile/desktop report UI separates program decision from contradictory model text, downloads private baseline bytes, and saves a disabled comparison routine with exact threshold/direction/notification policy",
      })
    }
    if (focus === "routines") {
      const {
        calendarWindow,
        saveRoutine,
        runRoutineNow,
        stageDueRoutines,
        routinePlanSchema,
        freezeRoutine,
        deleteRoutine,
        routineOverview,
      } = await import("@/lib/routines")
      const { eq } = await import("drizzle-orm")
      await stop("SIGTERM")
      const taipei = await calendarWindow(
        { kind: "daily", time: "09:00" },
        "Asia/Taipei",
        new Date("2026-10-24T16:30:00Z")
      )
      assert.equal(taipei.next!.toISOString(), "2026-10-25T01:00:00.000Z")
      const gap = await calendarWindow(
        { kind: "daily", time: "02:30" },
        "America/New_York",
        new Date("2026-03-08T05:00:00Z")
      )
      assert.equal(gap.next!.toISOString(), "2026-03-08T07:30:00.000Z")
      const fold = await calendarWindow(
        { kind: "daily", time: "01:30" },
        "America/New_York",
        new Date("2026-11-01T05:45:00Z")
      )
      assert.equal(fold.next!.toISOString(), "2026-11-01T06:30:00.000Z")
      assert.equal(
        (
          await calendarWindow(
            { kind: "daily", time: "01:30" },
            "America/New_York",
            fold.next!
          )
        ).next!.toISOString(),
        "2026-11-02T06:30:00.000Z"
      )
      assert.equal(
        (
          await calendarWindow(
            { kind: "weekdays", time: "09:00" },
            "Asia/Taipei",
            new Date("2026-10-23T02:00:00Z")
          )
        ).next!.toISOString(),
        "2026-10-26T01:00:00.000Z"
      )
      assert.equal(
        (
          await calendarWindow(
            { kind: "weekly", time: "09:00", day: 1 },
            "Asia/Taipei",
            new Date("2026-10-26T01:00:00Z")
          )
        ).next!.toISOString(),
        "2026-11-02T01:00:00.000Z"
      )
      assert.equal(
        schema.routineScheduleSchema.safeParse({ kind: "once", at: "2026-02-29T09:00" })
          .success,
        false
      )
      assert.equal(
        schema.routineScheduleSchema.safeParse({ kind: "once", at: "2028-02-29T09:00" })
          .success,
        true
      )
      checks.push({
        check:
          "Actual PostgreSQL wall-clock recurrence: Taipei, weekdays/weekly strict boundary, New York DST gap forward and fold later exactly once; invalid calendar dates rejected",
      })

      const marker = randomUUID(),
        scenario: Scenario = { kind: "routine", calls: [] }
      scenarios.set(marker, scenario)
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Routine fixture",
          role: "Protocol-driven scheduled tasks",
          model: "custom/runtime-fixture",
        })
        .returning()
      agents.push(agent.id)
      const plan = routinePlanSchema.parse({
        name: "周报 fixture",
        agentId: agent.id,
        prompt: `CASE=routine RUN=${marker} Summarize the previous full natural week.`,
        schedule: { kind: "daily", time: "09:00" },
        timeZone: "Asia/Taipei",
        dateRange: "previous_week",
        enabled: false,
      })
      assert.equal(
        routinePlanSchema.safeParse({ ...plan, timeZone: "Moon/Mare" }).success,
        false
      )
      assert.equal(
        routinePlanSchema.safeParse({ ...plan, squadId: "unsupported" }).success,
        false
      )
      let routine = await saveRoutine(plan)
      const frozen = await freezeRoutine(
        { ...routine, timeZone: "America/New_York" },
        ownerId,
        new Date("2026-11-02T14:00:00Z"),
        "week-fixture"
      )
      assert.deepEqual(frozen.range, {
        from: "2026-10-26",
        to: "2026-11-01",
        startsAt: "2026-10-26T04:00:00Z",
        endsAt: "2026-11-02T05:00:00Z",
      })
      assert.equal(frozen.input.timeZone, "America/New_York")
      const withContract = await freezeRoutine(
        {
          ...routine,
          completionContract: {
            requireHumanReview: false,
            artifact: {
              path: "report.csv",
              requiredColumns: ["date"],
              minRows: 1,
              dateColumn: "date",
            },
          },
        },
        ownerId,
        new Date("2026-10-26T01:00:00Z"),
        "contract-fixture"
      )
      assert.equal(withContract.input.completionContract.artifact!.dateFrom, "2026-10-19")
      assert.equal(withContract.input.completionContract.artifact!.dateTo, "2026-10-25")
      await db
        .update(schema.routines)
        .set({ enabled: true, nextRunAt: new Date("2026-10-20T01:00:00Z") })
        .where(eq(schema.routines.id, routine.id))
      await Promise.all([
        stageDueRoutines(new Date("2026-10-24T01:00:10Z")),
        stageDueRoutines(new Date("2026-10-24T01:00:10Z")),
      ])
      const staged = (
        await pool.query(
          "SELECT * FROM routine_runs WHERE routine_id=$1 ORDER BY status",
          [routine.id]
        )
      ).rows
      assert.equal(staged.length, 2)
      assert.equal(
        staged.find((run) => run.status === "queued").due_at.toISOString(),
        "2026-10-24T01:00:00.000Z"
      )
      assert.match(staged.find((run) => run.status === "skipped").detail, /不含末次/)
      const queued = staged.find((run) => run.status === "queued")
      const savedSnapshot = queued.snapshot
      routine = await saveRoutine(
        { ...plan, prompt: `CASE=routine RUN=${marker} Edited plan.` },
        routine.id,
        routine.planVersion
      )
      assert.equal(routine.planVersion, 2)
      assert.deepEqual(
        (await pool.query("SELECT snapshot FROM routine_runs WHERE id=$1", [queued.id]))
          .rows[0].snapshot,
        savedSnapshot
      )
      await assert.rejects(saveRoutine(plan, routine.id, 1), /plan changed/)
      checks.push({
        check:
          "Concurrent due scans create one latest catch-up plus visible coalesced skipped range; edits version future plans, reject stale edits and preserve accepted prompt/timezone/date/contract snapshots across a 169-hour DST week",
      })

      const skipped = await saveRoutine({
        ...plan,
        name: "跳过 fixture",
        missedRunPolicy: "skip",
      })
      await db
        .update(schema.routines)
        .set({ enabled: true, nextRunAt: new Date("2026-10-23T01:00:00Z") })
        .where(eq(schema.routines.id, skipped.id))
      await stageDueRoutines(new Date("2026-10-24T01:02:00Z"))
      assert.deepEqual(
        (
          await pool.query("SELECT status FROM routine_runs WHERE routine_id=$1", [
            skipped.id,
          ])
        ).rows,
        [{ status: "skipped" }]
      )
      await db
        .update(schema.routines)
        .set({ enabled: false, nextRunAt: null })
        .where(eq(schema.routines.id, skipped.id))
      const hourly = await saveRoutine({
        ...plan,
        name: "间隔 fixture",
        schedule: { kind: "hourly", every: 5 },
      })
      await db
        .update(schema.routines)
        .set({ enabled: true, nextRunAt: new Date("2026-10-23T22:20:00Z") })
        .where(eq(schema.routines.id, hourly.id))
      await stageDueRoutines(new Date("2026-10-24T12:30:00Z"))
      const hourlyState = (
        await pool.query("SELECT next_run_at FROM routines WHERE id=$1", [hourly.id])
      ).rows[0]
      assert.equal(hourlyState.next_run_at.toISOString(), "2026-10-24T13:20:00.000Z")
      assert.equal(
        (
          await pool.query(
            "SELECT due_at FROM routine_runs WHERE routine_id=$1 AND status='queued'",
            [hourly.id]
          )
        ).rows[0].due_at.toISOString(),
        "2026-10-24T08:20:00.000Z"
      )
      await db
        .update(schema.routines)
        .set({ enabled: false, nextRunAt: null })
        .where(eq(schema.routines.id, hourly.id))
      checks.push({
        check:
          "Explicit skip policy records overdue work; five-hour recurrence retains its persisted absolute-time anchor without restarting from current time",
      })

      // Exact crash window: submitTask committed, routine run's task receipt blocked.
      await assert.rejects(
        runRoutineNow(ownerId, routine.id, randomUUID(), 1),
        /plan changed/
      )
      const manualId = await runRoutineNow(
        ownerId,
        routine.id,
        marker,
        routine.planVersion
      )
      assert.equal(await runRoutineNow(ownerId, routine.id, marker, 1), manualId)
      const blocker = await pool.connect()
      try {
        await blocker.query("BEGIN")
        await blocker.query("SELECT id FROM routine_runs WHERE id=$1 FOR UPDATE", [
          manualId,
        ])
        await start()
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM tasks WHERE source='routine' AND request_key=$1",
                [`routine:${routine.id}:manual:${marker}`]
              )
            ).rowCount === 1,
          "routine task committed"
        )
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'update %routine_runs%'",
                []
              )
            ).rowCount! > 0,
          "routine task receipt blocked"
        )
        await stop()
        await blocker.query("ROLLBACK")
      } finally {
        blocker.release()
      }
      await start()
      const accepted = await until(
        async () =>
          (
            await pool.query(
              "SELECT task_id FROM routine_runs WHERE id=$1 AND task_id IS NOT NULL",
              [manualId]
            )
          ).rows[0],
        "recover routine receipt"
      )
      await completed(accepted.task_id)
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM tasks WHERE source='routine' AND request_key=$1",
            [`routine:${routine.id}:manual:${marker}`]
          )
        ).rows[0].n,
        1
      )
      assert.equal(
        (
          await pool.query(
            "SELECT config_snapshot->>'timeZone' AS zone FROM tasks WHERE id=$1",
            [accepted.task_id]
          )
        ).rows[0].zone,
        "Asia/Taipei"
      )
      assert.match((await getTask(ownerId, accepted.task_id)).goal, /Edited plan/)
      checks.push({
        check:
          "Real worker SIGKILL after atomic task enqueue but before routine task receipt: restart reuses the exact task/source key and frozen payload; duplicate manual acceptance returns the same run",
        taskId: accepted.task_id,
      })

      const held = await submit("usage_hold")
      await until(
        async () => !!held.scenario.release,
        "workstation occupied by an active task"
      )
      const oncePlan = await saveRoutine({
        ...plan,
        agentId: held.agentId,
        name: "一次性排队 fixture",
        schedule: { kind: "once", at: "2090-10-24T09:00" },
      })
      const due = new Date(Date.now() - 1000)
      const local = due.toISOString().slice(0, 16)
      await db
        .update(schema.routines)
        .set({
          enabled: true,
          timeZone: "UTC",
          schedule: { kind: "once", at: local },
          nextRunAt: new Date(`${local}:00Z`),
        })
        .where(eq(schema.routines.id, oncePlan.id))
      // Schedule actually wakes this occurrence; no test-side dispatcher invocation.
      const waiting = await until(
        async () =>
          (
            await pool.query(
              "SELECT task_id FROM routine_runs WHERE routine_id=$1 AND task_id IS NOT NULL",
              [oncePlan.id]
            )
          ).rows[0],
        "DBOS schedule dispatches busy once job"
      )
      assert.equal((await getTask(ownerId, waiting.task_id)).status, "queued")
      assert.equal(
        (await pool.query("SELECT enabled FROM routines WHERE id=$1", [oncePlan.id]))
          .rows[0].enabled,
        false
      )
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_model_decisions WHERE task_id=$1",
            [waiting.task_id]
          )
        ).rows[0].n,
        0
      )
      await deleteRoutine(oncePlan.id, oncePlan.planVersion)
      held.scenario.release!()
      await completed(held.taskId)
      await completed(waiting.task_id)
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM routine_runs WHERE routine_id=$1",
            [oncePlan.id]
          )
        ).rows[0].n,
        1
      )
      checks.push({
        check:
          "Actual DBOS timed trigger while the same workstation is busy: once plan enqueues independently, disables future scheduling, survives plan deletion with history, and runs after prior task releases the workstation",
        taskId: waiting.task_id,
      })

      const overview = await routineOverview(ownerId)
      assert(!overview.routines.some((plan) => plan.id === oncePlan.id))
      assert(
        overview.runs.some(
          (run) => run.routine_id === oncePlan.id && run.task_id === waiting.task_id
        )
      )
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Routines Web ready")
        assert.equal((await fetch(`${process.env.APP_URL}/api/routines`)).status, 401)
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          timezoneId: "America/New_York",
          locale: "en-US",
        })
        const page = await context.newPage(),
          pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "定时例程", exact: true }).click()
        await page.getByRole("heading", { name: "定时例程", exact: true }).waitFor()
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/routines`, {
              headers: { Origin: "https://untrusted.fixture.test" },
              data: { action: "delete", id: routine.id, version: routine.planVersion },
            })
          ).status(),
          403
        )
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/routines`, {
              headers: { Origin: process.env.APP_URL! },
              data: {
                action: "create",
                input: { ...plan, schedule: { kind: "once", at: "2026-02-30T09:00" } },
              },
            })
          ).status(),
          400
        )
        await page.getByLabel("名称", { exact: true }).fill("网页例程 fixture")
        await page.getByLabel("执行 Agent", { exact: true }).selectOption(agent.id)
        await page
          .getByLabel("每次要做的工作", { exact: true })
          .fill(`CASE=routine RUN=${marker} UI routine.`)
        await page.getByLabel("IANA 时区", { exact: true }).fill("Asia/Taipei")
        await page.getByLabel("日期范围", { exact: true }).selectOption("previous_week")
        await page.getByLabel("启用计划", { exact: true }).uncheck()
        await page.getByRole("button", { name: "创建计划", exact: true }).click()
        await page
          .getByText("计划已保存。已受理的任务继续使用原计划快照。", { exact: true })
          .waitFor()
        await page
          .getByRole("button", { name: "编辑 网页例程 fixture", exact: true })
          .click()
        await page.getByLabel("名称", { exact: true }).fill("网页例程 v2 fixture")
        await page.getByRole("button", { name: "保存计划", exact: true }).click()
        await page
          .getByRole("button", { name: "立即运行 网页例程 v2 fixture", exact: true })
          .click()
        await page
          .getByText("已受理。工作站忙时等待排队，可在历史中打开任务。", { exact: true })
          .waitFor()
        const uiRun = await until(
          async () =>
            (
              await pool.query(
                "SELECT rr.task_id FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id WHERE r.name='网页例程 v2 fixture' AND rr.task_id IS NOT NULL"
              )
            ).rows[0],
          "UI routine accepted by worker"
        )
        await completed(uiRun.task_id)
        await page.getByRole("button", { name: "刷新状态", exact: true }).click()
        await page
          .getByRole("region", { name: "运行历史", exact: true })
          .locator("article")
          .filter({ hasText: "网页例程 v2 fixture · v2 · 手动" })
          .getByText("已完成", { exact: true })
          .waitFor()
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.screenshot({
          path: path.join(directory, "routines-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "routines-desktop.png"),
          fullPage: true,
        })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "routines-web.log"), webLog)
      }
      checks.push({
        check:
          "Actual owner-authenticated mobile/desktop routines UI: create disabled plan, versioned edit, manual durable acceptance and task history; cross-origin and invalid-date API rejection; browser timezone does not define plan timezone",
      })
    }
    if (focus === "core") {
      const report = await submit("report", true)
      const review = await pending(report.taskId, "completion")
      assert.equal(report.scenario.calls.length, 4)
      await assert.rejects(respondToRequest(ownerId, review.id, "complete", 9, {}), {
        status: 409,
      })
      await respondToRequest(ownerId, review.id, "complete", review.payloadVersion, {
        note: "Checked by fixture owner",
      })
      const result = await completed(report.taskId)
      assert.equal(result.artifacts.length, 1)
      assert.equal(result.artifacts[0].verification.grade, "program_checked")
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, result.artifacts[0].storagePath),
          "utf8"
        ),
        goodCsv
      )
      assert.equal(
        result.result?.verification &&
          (result.result.verification as { grade: string }).grade,
        "human_confirmed"
      )
      assert.equal(result.usage.decisions, 4)
      assert.equal(result.usage.known_cost_micros, "560")
      assert.equal(report.scenario.calls.length, 4)
      checks.push({
        check:
          "Production provider/SDK/workflow: invalid CSV rejected, model corrects it, trusted extraction checks date/columns, owner approval resumes, one artifact and four non-duplicated model charges",
        taskId: report.taskId,
      })

      const cancelled = await submit("cancel")
      await until(async () => !!cancelled.scenario.pending, "in-flight model request")
      await requestCancellation(ownerId, cancelled.taskId)
      await until(async () => {
        const task = await getTask(ownerId, cancelled.taskId)
        return task.status === "cancelled" && !task.cancelWorkflowPending
      }, "actual/native cancellation during model call")
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_actions WHERE task_id=$1",
            [cancelled.taskId]
          )
        ).rows[0].n,
        0
      )
      assert.notEqual(
        (await dockerRaw(["inspect", workstationName(cancelled.agentId)])).exitCode,
        0
      )
      assert.equal(cancelled.scenario.pending!.destroyed, true)
      assert.equal(
        (await getTask(ownerId, cancelled.taskId)).requests.filter(
          (request) => request.payload.purpose === "execution_error"
        ).length,
        0
      )
      checks.push({
        check:
          "Cancellation aborts the real HTTP model request, stops the workstation, and dispatches no model tools",
      })
    }
    if (focus === "continuity") {
      const { appendTaskSupplement, taskSupplements } =
        await import("@/lib/task-supplements")
      const { confirmErrand, syncErrands } = await import("@/lib/companion/errands")
      const { updateCompanion } = await import("@/lib/companion/store")
      const { saveImage } = await import("@/lib/companion/images")
      const { default: sharp } = await import("sharp")
      const run = randomUUID(),
        agentId = randomUUID(),
        sourceId = randomUUID(),
        proposalId = randomUUID()
      const scenario: Scenario = { kind: "continuity", calls: [] }
      scenarios.set(run, scenario)
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Continuity','Personal assistant','fixture','custom/runtime-fixture',now(),now())",
        [agentId]
      )
      agents.push(agentId)
      await updateCompanion(ownerId, agentId, { typingPace: "off" })
      const photo = await saveImage(
        agentId,
        await sharp({
          create: { width: 32, height: 32, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer()
      )
      scenario.itemId = photo.id
      await pool.query(
        "INSERT INTO companion_messages(id,agent_id,role,content,metadata,created_at) VALUES($1,$2,'user','Chinese headings from source chat',$3,now()-interval '1 minute')",
        [sourceId, agentId, JSON.stringify({ imageId: photo.id })]
      )
      const goal = `CASE=continuity RUN=${run}; Prepare the report from our chat and picture.`
      await pool.query(
        "INSERT INTO companion_messages(id,agent_id,role,kind,content,metadata,created_at) VALUES($1,$2,'assistant','errand_proposal',$3,$4,now())",
        [
          proposalId,
          agentId,
          goal,
          JSON.stringify({ goal, status: "pending", sourceMessageId: sourceId }),
        ]
      )
      const submitted = await confirmErrand(ownerId, proposalId)
      await until(async () => scenario.release, "initial model response held")
      const note = { text: "Use the revised totals", clientRequestId: randomUUID() }
      await appendTaskSupplement(ownerId, submitted.taskId, note)
      scenario.release!()
      const request = await pending(submitted.taskId, "question")
      assert.equal(scenario.calls.length, 4)
      await stop()
      await appendTaskSupplement(ownerId, submitted.taskId, {
        text: "Double the total after restart",
        clientRequestId: randomUUID(),
      })
      await respondToRequest(ownerId, request.id, "approve", request.payloadVersion, {
        answer: "owner confirmed total",
        note: "owner confirmed total",
      })
      await start()
      const result = await completed(submitted.taskId)
      assert.equal(scenario.calls.length, 6, "saved model decisions are not replayed")
      assert.equal((await taskSupplements(submitted.taskId)).length, 2)
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, result.artifacts[0].storagePath),
          "utf8"
        ),
        doubledCsv
      )
      const absent = await dockerRaw([
        "exec",
        workstationName(agentId),
        "test",
        "!",
        "-e",
        "/home/agent/superseded.txt",
      ])
      assert.equal(absent.exitCode, 0, "the old in-flight decision did not write a file")
      const writes = await pool.query(
        "SELECT input->>'content' AS content FROM task_actions WHERE task_id=$1 AND kind='fs_write' AND status='succeeded' ORDER BY action_no",
        [submitted.taskId]
      )
      assert.deepEqual(
        writes.rows.map((row) => row.content),
        [goodCsv, doubledCsv]
      )
      await syncErrands()
      assert.equal((await confirmErrand(ownerId, proposalId)).taskId, submitted.taskId)
      checks.push({
        check:
          "Confirmed source chat and actual picture reach model; in-flight old write rejected; supplements survive worker restart and owner question; actual file bytes and one logical task verified",
        taskId: submitted.taskId,
      })
    }
    if (focus === "chat") {
      const { getThread, listThreads, renameThread } = await import("@/lib/threads")
      const first = await submit("report")
      const firstResult = await completed(first.taskId)
      const threadId = firstResult.threadId!
      assert.equal(firstResult.threadTurn, 1)
      async function followup(kind: string) {
        const run = randomUUID(),
          scenario: Scenario = { kind, calls: [] }
        scenarios.set(run, scenario)
        const input = {
          agentId: first.agentId,
          threadId,
          goal: `CASE=${kind} RUN=${run}; Continue the previous report in this conversation.`,
          clientRequestId: run,
          completionContract: { requireHumanReview: false },
          budget: { maxSteps: 10 },
        }
        return { ...(await submitTask(ownerId, "test", input)), input, scenario }
      }
      const edited = await followup("chat_edit")
      const duplicate = await Promise.all(
        Array.from({ length: 4 }, () => submitTask(ownerId, "test", edited.input))
      )
      assert(duplicate.every((task) => task.taskId === edited.taskId && task.reused))
      const editedResult = await completed(edited.taskId)
      assert.equal(editedResult.threadTurn, 2)
      assert.equal(edited.scenario.calls.length, 3)
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, editedResult.artifacts[0].storagePath),
          "utf8"
        ),
        doubledCsv
      )
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, firstResult.artifacts[0].storagePath),
          "utf8"
        ),
        goodCsv,
        "Editing the guest path must not overwrite a previously delivered artifact"
      )
      await assert.rejects(getThread("another-owner", threadId), { status: 404 })
      await assert.rejects(renameThread("another-owner", threadId, "unauthorized"), {
        status: 404,
      })
      const [other] = await db
        .insert(schema.agents)
        .values({
          name: "Other conversation agent",
          role: "Isolation check",
          model: "custom/runtime-fixture",
        })
        .returning()
      agents.push(other.id)
      await assert.rejects(
        submitTask(ownerId, "test", {
          ...edited.input,
          agentId: other.id,
          clientRequestId: randomUUID(),
        }),
        { status: 404 }
      )
      await assert.rejects(
        submitTask("another-owner", "test", {
          ...edited.input,
          clientRequestId: randomUUID(),
        }),
        { status: 404 }
      )
      const racing = await Promise.allSettled([
        followup("chat_question"),
        followup("chat_question"),
      ])
      const success = racing.find((result) => result.status === "fulfilled")!
      const rejected = racing.find((result) => result.status === "rejected")!
      assert.equal(success.status, "fulfilled")
      assert.equal(rejected.status, "rejected")
      if (success.status !== "fulfilled" || rejected.status !== "rejected")
        throw new Error("One conversation turn must win the race")
      assert.equal(rejected.reason.status, 409)
      const question = success.value,
        request = await pending(question.taskId, "question")
      assert.equal((await getTask(ownerId, question.taskId)).threadTurn, 3)
      await stop()
      await start()
      assert.equal(
        question.scenario.calls.length,
        1,
        "Restart during a question must preserve the model decision and conversation snapshot"
      )
      await respondToRequest(ownerId, request.id, "approve", request.payloadVersion, {
        note: "请用中文摘要 fixture",
        answer: "请用中文摘要 fixture",
      })
      await completed(question.taskId)
      const cancelled = await followup("cancel")
      await until(async () => !!cancelled.scenario.pending, "in-flight chat turn")
      await requestCancellation(ownerId, cancelled.taskId)
      await until(async () => {
        const task = await getTask(ownerId, cancelled.taskId)
        return task.status === "cancelled" && !task.cancelWorkflowPending
      }, "cancelled chat turn")
      const afterCancel = await followup("chat_after_cancel")
      await completed(afterCancel.taskId)
      for (let i = 0; i < 18; i++) {
        const turn = await followup("chat_short")
        await completed(turn.taskId)
      }
      const page = await getThread(ownerId, threadId)
      assert.equal(page.turns.length, 20)
      assert.equal(page.turns[0].threadTurn, 4)
      assert.equal(page.turns.at(-1)!.threadTurn, 23)
      assert.equal(page.hasEarlier, true)
      const earlier = await getThread(ownerId, threadId, page.turns[0].threadTurn)
      assert.deepEqual(
        earlier.turns.map((turn) => turn.threadTurn),
        [1, 2, 3]
      )
      assert.equal(earlier.hasEarlier, false)
      assert.match(earlier.turns[0].reply!, /已交付通过字段与日期检查的报表/)
      assert.equal(earlier.turns[2].interactions![0].answer, "请用中文摘要 fixture")
      assert.equal(page.turns[0].status, "cancelled")
      assert.equal(page.turns[0].reply, null)
      await renameThread(ownerId, threadId, "报表追问与修正")
      assert.equal((await listThreads(ownerId))[0].title, "报表追问与修正")
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM tasks WHERE thread_id=$1", [
            threadId,
          ])
        ).rows[0].n,
        23
      )
      const latestSnapshot = (
        await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [
          page.turns.at(-1)!.id,
        ])
      ).rows[0].config_snapshot
      assert.equal(latestSnapshot.conversation.length, 44)
      checks.push({
        check:
          "23 actual durable chat turns: historical goals/replies/artifact paths, guest-file correction with original delivery preserved, duplicate submission and concurrent-turn exclusion, owner/agent isolation, question wait + worker restart, cancellation followed by another turn, complete ordered pagination and rename",
        threadId,
      })
    }
    if (focus === "usage") {
      const { monthlyUsage, usageOverview, reconcileUsage, setCustomPrice } =
        await import("@/lib/spend")
      const zone = (await pool.query("SELECT time_zone FROM owners")).rows[0].time_zone
      await pool.query("UPDATE owners SET time_zone='America/New_York'")
      const october = await monthlyUsage(
        ownerId,
        undefined,
        new Date("2026-11-01T03:30:00Z")
      )
      const november = await monthlyUsage(
        ownerId,
        undefined,
        new Date("2026-11-01T04:30:00Z")
      )
      assert.equal(october.month, "2026-10")
      assert.equal(october.startsAt.toISOString(), "2026-10-01T04:00:00.000Z")
      assert.equal(november.month, "2026-11")
      assert.equal(november.startsAt.toISOString(), "2026-11-01T04:00:00.000Z")
      assert.equal(november.endsAt.toISOString(), "2026-12-01T05:00:00.000Z")
      await pool.query("UPDATE owners SET time_zone='Asia/Taipei'")
      assert.equal(
        (await monthlyUsage(ownerId, undefined, new Date("2026-10-31T16:00:00Z"))).month,
        "2026-11"
      )
      await pool.query("UPDATE owners SET time_zone=$1", [zone])
      checks.push({
        check:
          "PostgreSQL owner-timezone month accounting at Taipei midnight and New York month boundary across DST; server timezone does not define the billing month",
      })

      await setSetting("usage.monthlyBudget", "0.01")
      const held = await submit("usage_hold")
      await until(async () => !!held.scenario.release, "first paid request in flight")
      const other = await submit("usage_quick")
      await until(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid=$1 AND output LIKE '%capacity%'",
              [`${other.taskId}:1`]
            )
          ).rowCount === 1,
        "second paid request waits at budget admission"
      )
      assert.equal(other.scenario.calls.length, 0)
      assert.equal((await monthlyUsage(ownerId)).pendingPaid, 1)
      await requestCancellation(ownerId, other.taskId)
      await until(
        async () => (await getTask(ownerId, other.taskId)).status === "cancelled",
        "cancel task waiting for paid capacity"
      )
      held.scenario.release!()
      await completed(held.taskId)
      assert.equal((await monthlyUsage(ownerId)).knownCostMicros, "10000")
      const capped = await submit("usage_cap")
      let capRequest = await pending(capped.taskId, "monthly")
      assert.equal(capped.scenario.calls.length, 0)
      await respondToRequest(
        ownerId,
        capRequest.id,
        "continue",
        capRequest.payloadVersion,
        {}
      )
      capRequest = await until(async () => {
        const next = (await getTask(ownerId, capped.taskId)).requests.find(
          (request) =>
            request.status === "pending" &&
            request.payload.purpose === "monthly" &&
            request.id !== capRequest.id
        )
        return next
      }, "continuing unchanged budget creates another explicit hold, never an API call")
      assert.equal(capped.scenario.calls.length, 0)
      await setSetting("usage.monthlyBudget", "0.02")
      await respondToRequest(
        ownerId,
        capRequest.id,
        "continue",
        capRequest.payloadVersion,
        {}
      )
      const secondHold = await until(
        async () =>
          (await getTask(ownerId, capped.taskId)).requests.find(
            (request) =>
              request.status === "pending" &&
              request.payload.purpose === "monthly" &&
              request.id !== capRequest.id
          ),
        "mid-task monthly pause"
      )
      assert.equal(capped.scenario.calls.length, 1)
      await setSetting("usage.monthlyBudget", "0.03")
      await respondToRequest(
        ownerId,
        secondHold.id,
        "continue",
        secondHold.payloadVersion,
        {}
      )
      await completed(capped.taskId)
      assert.equal(capped.scenario.calls.length, 2)
      assert.equal((await monthlyUsage(ownerId)).knownCostMicros, "30000")
      checks.push({
        check:
          "Two real workstations compete for a capped month: only one paid call is admitted; waiting capacity can cancel; exhausted/unchanged cap sends no HTTP call; raising the cap resumes and can pause again mid-task",
      })

      await setSetting("usage.monthlyBudget", "0.10")
      await setSetting("pricing.custom", "{}")
      const unpriced = await submit("usage_quick")
      const priceHold = await pending(unpriced.taskId, "monthly")
      assert.match(String(priceHold.payload.message), /定价/)
      assert.equal(unpriced.scenario.calls.length, 0)
      await setCustomPrice("custom/runtime-fixture", { input: 1, output: 2, cached: 0 })
      await respondToRequest(
        ownerId,
        priceHold.id,
        "continue",
        priceHold.payloadVersion,
        {}
      )
      await completed(unpriced.taskId)
      const interrupted = await submit("cancel")
      await until(
        async () => !!interrupted.scenario.pending,
        "possibly billed model request"
      )
      await requestCancellation(ownerId, interrupted.taskId)
      await until(async () => {
        const task = await getTask(ownerId, interrupted.taskId)
        return task.status === "cancelled" && !task.cancelWorkflowPending
      }, "actual HTTP cancellation saves unknown attempt")
      const unknown = (
        await pool.query(
          "SELECT id::text FROM task_model_attempts WHERE task_id=$1 AND status='unknown'",
          [interrupted.taskId]
        )
      ).rows[0]
      assert(unknown)
      const afterUnknown = await submit("usage_quick")
      const unknownHold = await pending(afterUnknown.taskId, "monthly")
      assert.match(String(unknownHold.payload.message), /核对/)
      assert.equal(afterUnknown.scenario.calls.length, 0)
      await assert.rejects(
        reconcileUsage("foreign-owner", {
          id: unknown.id,
          costMicros: 0,
          note: "untrusted",
        }),
        { status: 404 }
      )
      await reconcileUsage(ownerId, {
        id: unknown.id,
        costMicros: 0,
        note: "Controlled provider confirms no charge fixture",
      })
      assert.equal((await monthlyUsage(ownerId)).unknown, 0)
      await respondToRequest(
        ownerId,
        unknownHold.id,
        "continue",
        unknownHold.payloadVersion,
        {}
      )
      await completed(afterUnknown.taskId)
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND type='usage_reconciled'",
            [interrupted.taskId]
          )
        ).rows[0].n,
        1
      )
      assert.equal(
        (
          await pool.query(
            "SELECT status,reconciled_cost_micros FROM task_model_attempts WHERE id=$1",
            [unknown.id]
          )
        ).rows[0].status,
        "unknown"
      )
      checks.push({
        check:
          "Unknown current price blocks before HTTP; new custom rates affect new attempts; cancelled unreceipted request remains unknown, blocks paid work, and owner-only auditable reconciliation releases the hold without fabricating a provider receipt",
      })

      await setSetting("usage.monthlyBudget", "0")
      await setSetting("provider.lmstudio.baseUrl", `http://127.0.0.1:${port}/v1`)
      const local = await submit("usage_quick", false, "lmstudio/usage-local")
      const localTask = await completed(local.taskId)
      assert.equal(localTask.usage.known_cost_micros, "0")
      const reset = await submit("usage_quick")
      const resetHold = await pending(reset.taskId, "monthly")
      assert.equal(reset.scenario.calls.length, 0)
      await stop()
      await start()
      assert.equal(reset.scenario.calls.length, 0)
      await setSetting("usage.monthlyBudget", null)
      await pool.query(
        "UPDATE task_requests SET payload=jsonb_set(payload,'{monthly,endsAt}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1",
        [resetHold.id]
      )
      await until(async () => {
        const task = await getTask(ownerId, reset.taskId)
        if (task.status === "failed")
          throw new Error(task.error ?? "Monthly resume failed")
        return task.status === "completed" && task
      }, "persisted month deadline automatically resumes the waiting workflow")
      assert.equal(reset.scenario.calls.length, 1)
      const resetEvent = (
        await pool.query(
          "SELECT payload FROM task_events WHERE task_id=$1 AND type='request_decided'",
          [reset.taskId]
        )
      ).rows[0].payload
      assert.equal(resetEvent.actor, "calendar")
      checks.push({
        check:
          "Zero cap pauses paid calls while the real local-compatible SDK path remains free; waiting month survives worker restart, an expired persisted month deadline automatically rechecks through the normal gate with calendar attribution",
      })

      await setCustomPrice("custom/runtime-fixture", { input: 1000, output: 2000 })
      const large = await submit("usage_big")
      assert.equal((await completed(large.taskId)).usage.known_cost_micros, "3000000000")
      await setCustomPrice("custom/runtime-fixture", { input: 1, output: 2 })
      const missing = await submit("usage_missing")
      await completed(missing.taskId)
      const missingAttempt = (
        await pool.query(
          "SELECT id::text,usage,cost_micros FROM task_model_attempts WHERE task_id=$1",
          [missing.taskId]
        )
      ).rows[0]
      assert.equal(missingAttempt.cost_micros, null)
      assert.equal(missingAttempt.usage.missing, true)
      // Run the migration's actual backfill against a controlled legacy decision, not an alternate test implementation.
      await pool.query(
        `INSERT INTO task_model_decisions(task_id,segment_no,decision_no,epoch,status,attempts,uncertain_attempts,result,cost_micros,created_at,finished_at)
        VALUES($1,1,9000,1,'succeeded',2,1,$2,500,date_trunc('month',now())-interval '1 day',now())`,
        [
          large.taskId,
          JSON.stringify({
            usage: { input: 1, output: 2, cached: 0, reasoning: 0, missing: false },
          }),
        ]
      )
      const migration = await readFile("db/migrations/0008_fearless_spot.sql", "utf8")
      const backfill = migration.slice(
        migration.indexOf("-- Backfill historical attempts")
      )
      await pool.query(backfill)
      await pool.query(backfill)
      const legacy = (
        await pool.query(
          "SELECT status,cost_micros,legacy FROM task_model_attempts WHERE task_id=$1 AND decision_no=9000 ORDER BY attempt_no",
          [large.taskId]
        )
      ).rows
      assert.equal(legacy.length, 2)
      assert.deepEqual(
        legacy.map((row) => row.cost_micros),
        [null, "500"]
      )
      assert(legacy.every((row) => row.legacy))
      checks.push({
        check:
          "BIGINT preserves a 3-billion-micro controlled charge; missing provider usage remains unknown; actual migration backfill retains unknown earlier attempt and known final receipt, labels legacy timestamps, and is idempotent",
      })

      await pool.query(
        `INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,cost_micros,legacy,started_at)
        SELECT $1,1,10000+n,1,'fixture/history','succeeded',0,true,now()-interval '1 day' FROM generate_series(1,53) n`,
        [large.taskId]
      )
      const overview = await usageOverview(ownerId)
      assert.equal(overview.attempts.length, 50)
      assert.equal(overview.hasMore, true)
      const earlier = await usageOverview(ownerId, overview.attempts.at(-1)!.id)
      assert(earlier.attempts.length > 0)
      assert(
        !earlier.attempts.some((row) =>
          overview.attempts.some((current) => current.id === row.id)
        )
      )

      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as any).cause?.code === "ECONNREFUSED") return false
            throw error
          }
        }, "Usage Web ready")
        assert.equal((await fetch(`${process.env.APP_URL}/api/usage`)).status, 401)
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
        })
        const page = await context.newPage(),
          pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "用量与预算", exact: true }).click()
        await page.getByRole("heading", { name: "用量与预算", exact: true }).waitFor()
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/usage`, {
              headers: { Origin: "https://untrusted.fixture.test" },
              data: { action: "budget", value: "1" },
            })
          ).status(),
          403
        )
        assert.equal(
          (
            await context.request.get(`${process.env.APP_URL}/api/usage?before=0`)
          ).status(),
          400
        )
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/usage`, {
              headers: { Origin: process.env.APP_URL! },
              data: {
                action: "price",
                model: "custom/test",
                rate: { input: -1, output: 1 },
              },
            })
          ).status(),
          400
        )
        await page.getByLabel("定价模型 ID", { exact: true }).fill("custom/ui-price")
        await page.getByLabel("输入单价", { exact: true }).fill("1.5")
        await page.getByLabel("输出单价", { exact: true }).fill("2.5")
        await page.getByLabel("缓存输入单价（可选）", { exact: true }).fill("0.1")
        await page.getByRole("button", { name: "保存模型单价", exact: true }).click()
        await page
          .getByRole("button", { name: "移除 custom/ui-price 自定义单价", exact: true })
          .waitFor()
        assert.equal(
          (
            await pool.query(
              "SELECT price_snapshot FROM task_model_attempts WHERE task_id=$1 AND NOT legacy",
              [large.taskId]
            )
          ).rows[0].price_snapshot.price.input,
          1000
        )
        await page.getByRole("button", { name: "加载更早请求", exact: true }).click()
        await page.getByLabel(`核对费用 ${missingAttempt.id}`, { exact: true }).fill("0")
        await page
          .getByLabel(`核对说明 ${missingAttempt.id}`, { exact: true })
          .fill("Provider confirmed no billed usage fixture")
        await page
          .getByRole("button", { name: `保存费用核对 ${missingAttempt.id}`, exact: true })
          .click()
        await until(
          async () =>
            (
              await pool.query(
                "SELECT reconciled_cost_micros FROM task_model_attempts WHERE id=$1",
                [missingAttempt.id]
              )
            ).rows[0].reconciled_cost_micros === "0",
          "owner UI reconciles missing usage"
        )
        await page.getByLabel("每月预算", { exact: true }).fill("0")
        await page.getByRole("button", { name: "保存月预算", exact: true }).click()
        await until(
          async () => (await monthlyUsage(ownerId)).budgetMicros === 0,
          "owner UI saves monthly zero cap"
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.screenshot({
          path: path.join(directory, "usage-mobile.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: path.join(directory, "usage-desktop.png"),
          fullPage: true,
        })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser?.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "usage-web.log"), webLog)
      }
      checks.push({
        check:
          "Owner mobile/desktop usage UI: immutable price receipts, custom rates, unknown-cost reconciliation, zero monthly cap; API auth/Origin/money/cursor validation; pagination uses 53 explicitly seeded history rows without overlap",
      })
    }
    if (focus === "crossapps") {
      const { ensureWorkstation, workstationHealth } = await import("@/lib/workstation")
      const { crossAppTemplate } = await import("@/lib/cross-app-template")
      const { importWorkflowPackage, exportWorkflowPackage } =
        await import("@/lib/workflow-packages")
      const { getWorkflowVersion } = await import("@/lib/workflows")
      const { validateWorkflowPackage } = await import("@/lib/workflow-package")
      async function runner() {
        const agentId = randomUUID()
        await pool.query(
          "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Cross-app runner','Assistant','fixture','custom/runtime-fixture',now(),now())",
          [agentId]
        )
        agents.push(agentId)
        const workspace = await ensureWorkstation(agentId),
          health = await workstationHealth(agentId)
        const [container] = JSON.parse(
          (await docker(["inspect", workspace.containerName])).stdout.toString()
        )
        return {
          agentId,
          environment: {
            workstationImageId: container.Image as string,
            guestProtocol: health.protocolVersion,
            locale: (container.Config.Env as string[])
              .find((value) => value.startsWith("LANG="))!
              .slice(5),
            application: "Desktop" as const,
          },
        }
      }
      async function runFlow(
        agentId: string,
        versionId: string,
        purpose: "verify" | "run",
        name: string
      ) {
        return submitTask(ownerId, "test", {
          agentId,
          goal: `Execute ${name}`,
          completionContract: { requireHumanReview: false },
          clientRequestId: randomUUID(),
          workflowExecution: {
            versionId,
            purpose,
            parameters: { input1: name },
            maxActions: 120,
            maxDurationSeconds: 300,
          },
          budget: { maxSteps: 5 },
        })
      }
      async function delivered(taskId: string) {
        try {
          const result = await completed(taskId)
          const checked = result.artifacts.find(
            (a) => (a.verification as { grade: string }).grade === "program_checked"
          )!
          assert(checked, "host must verify CSV")
          const bytes = await readFile(
            path.join(process.env.ARTIFACT_DIR!, checked.storagePath),
            "utf8"
          )
          assert.equal(bytes.trim().replaceAll("\r", ""), "name,total\nExample,42")
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM task_model_attempts WHERE task_id=$1",
                [taskId]
              )
            ).rows[0].n,
            0
          )
          checks.push({
            check:
              "Real application clipboard transfer, CSV bytes and host contract, no model calls",
            taskId,
          })
          return result
        } finally {
          await writeFile(
            path.join(directory, `cross-app-${taskId}.json`),
            JSON.stringify(await getTask(ownerId, taskId), null, 2)
          )
          await writeFile(
            path.join(directory, `cross-app-actions-${taskId}.json`),
            JSON.stringify(
              (
                await pool.query(
                  "SELECT action_no,kind,status,input,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
                  [taskId]
                )
              ).rows,
              null,
              2
            )
          )
        }
      }
      const first = await runner(),
        pack = crossAppTemplate(first.environment, randomUUID())
      const imported = await importWorkflowPackage(ownerId, {
        clientRequestId: randomUUID(),
        reviewed: true,
        package: pack,
      })
      for (let n = 1; n <= 3; n++) {
        const agentId = n === 1 ? first.agentId : (await runner()).agentId
        const task = await runFlow(agentId, imported.versionId, "verify", `Browser-${n}`)
        await delivered(task.taskId)
        assert.equal(
          (await getWorkflowVersion(ownerId, imported.versionId)).status,
          n === 3 ? "ready" : "verifying"
        )
      }
      const reuse = await runner()
      await delivered(
        (await runFlow(reuse.agentId, imported.versionId, "run", "Reused")).taskId
      )
      const exported = await exportWorkflowPackage(ownerId, imported.versionId)
      const another = await importWorkflowPackage(ownerId, {
        clientRequestId: randomUUID(),
        reviewed: true,
        package: exported,
      })
      assert.equal((await getWorkflowVersion(ownerId, another.versionId)).status, "draft")
      const recipient = await runner()
      await delivered(
        (await runFlow(recipient.agentId, another.versionId, "verify", "Imported")).taskId
      )
      assert.equal(
        (await getWorkflowVersion(ownerId, another.versionId)).status,
        "verifying"
      )
      const office = await runner(),
        officePack = crossAppTemplate(office.environment, randomUUID(), "Writer")
      const officeVersion = await importWorkflowPackage(ownerId, {
        clientRequestId: randomUUID(),
        reviewed: true,
        package: officePack,
      })
      await delivered(
        (await runFlow(office.agentId, officeVersion.versionId, "verify", "Writer"))
          .taskId
      )
      // A checkpoint after the clipboard copy tests durable restart without retyping/re-copying.
      const recovery = await runner(),
        recoveryPack = validateWorkflowPackage({
          ...pack,
          packageId: randomUUID(),
          steps: [
            ...pack.steps.slice(0, 6),
            {
              id: "human",
              label: "Restart checkpoint",
              operation: "human_checkpoint",
              reason: "Inspect clipboard and return",
            },
            ...pack.steps.slice(6),
          ],
        })
      const recoveryVersion = await importWorkflowPackage(ownerId, {
        clientRequestId: randomUUID(),
        reviewed: true,
        package: recoveryPack,
      })
      const recovered = await runFlow(
        recovery.agentId,
        recoveryVersion.versionId,
        "verify",
        "Recovered"
      )
      const request = await until(async () => {
        const task = await getTask(ownerId, recovered.taskId)
        return task.control?.mode === "human"
          ? task.requests.find((r) => r.kind === "takeover" && r.status === "pending")
          : undefined
      }, "cross-app human checkpoint")
      const before = (
        await pool.query(
          "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='key_type'",
          [recovered.taskId]
        )
      ).rows
      await stop()
      await start()
      await respondToRequest(ownerId, request.id, "handback", request.payloadVersion, {
        note: "Continue from the saved checkpoint",
      })
      await delivered(recovered.taskId)
      const after = (
        await pool.query(
          "SELECT action_no FROM task_actions WHERE task_id=$1 AND kind='key_type' ORDER BY action_no",
          [recovered.taskId]
        )
      ).rows
      assert.deepEqual(after.slice(0, before.length), before)
      assert.equal(after.length, before.length + 1)
      // A mismatched guard stops before any typing; manual completion is checked but cannot certify.
      const blocked = await runner(),
        badPack = validateWorkflowPackage({
          ...pack,
          packageId: randomUUID(),
          steps: pack.steps.map((step, index) =>
            index === 1
              ? {
                  ...step,
                  when: {
                    application: "Browser",
                    title: [{ literal: "Missing window" }],
                  },
                }
              : step
          ),
        })
      const badVersion = await importWorkflowPackage(ownerId, {
        clientRequestId: randomUUID(),
        reviewed: true,
        package: badPack,
      })
      const bad = await runFlow(
        blocked.agentId,
        badVersion.versionId,
        "verify",
        "Blocked"
      )
      const review = await pending(bad.taskId, "workflow_review")
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_actions WHERE task_id=$1 AND kind IN ('key_type','key_press')",
            [bad.taskId]
          )
        ).rows[0].n,
        0
      )
      await docker([
        "exec",
        workstationName(blocked.agentId),
        "python3",
        "-c",
        "from pathlib import Path; Path('/home/agent/Blocked.csv').write_text('name,total\\nExample,42')",
      ])
      await respondToRequest(ownerId, review.id, "continue", review.payloadVersion, {})
      await delivered(bad.taskId)
      assert.equal(
        (await getWorkflowVersion(ownerId, badVersion.versionId)).status,
        "verifying"
      )
      checks.push({
        check:
          "Three independent samples certify; ready run; exported package requires independent checks; Writer transfer; worker restart resumes checkpoint; wrong window blocks input and manual recovery cannot certify",
      })
    }
    if (focus === "demonstrations") {
      const { ensureWorkstation, workspaceRow } = await import("@/lib/workstation")
      const {
        startDemonstration,
        recordDemonstration,
        finishDemonstration,
        saveDemonstrationManual,
      } = await import("@/lib/demonstrations")
      const agentId = randomUUID(),
        run = randomUUID(),
        scenario: Scenario = { kind: "demonstrations", calls: [] }
      scenarios.set(run, scenario)
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Demonstration','Assistant','fixture','custom/runtime-fixture',now(),now())",
        [agentId]
      )
      agents.push(agentId)
      await ensureWorkstation(agentId)
      await docker(["exec", "--detach", workstationName(agentId), "mousepad"])
      await until(async () => {
        const state = await dockerRaw([
          "exec",
          workstationName(agentId),
          "xdotool",
          "search",
          "--onlyvisible",
          "--class",
          "Mousepad",
        ])
        return state.exitCode === 0
      }, "editor ready")
      const demo = await startDemonstration(ownerId, agentId, "Edit a report")
      await docker(["exec", workstationName(agentId), "xdotool", "key", "ctrl+n"])
      const event = await recordDemonstration(ownerId, demo.id, {
        seq: 1,
        event: { kind: "key", key: "Enter", ctrl: false, alt: false, shift: false },
      })
      assert.match(event.application ?? "", /mousepad/i)
      await docker([
        "exec",
        workstationName(agentId),
        "xdotool",
        "type",
        "private-value-not-recorded",
      ])
      await recordDemonstration(ownerId, demo.id, {
        seq: 2,
        event: { kind: "protected_input", text: "private-value-not-recorded" },
      })
      await recordDemonstration(ownerId, demo.id, {
        seq: 3,
        event: {
          kind: "checkpoint",
          note: "Write DEMONSTRATED_RESULT to demonstrated.txt and verify the file",
        },
      })
      const draft = await finishDemonstration(ownerId, demo.id)
      assert(!JSON.stringify(draft).includes("private-value-not-recorded"))
      await saveDemonstrationManual(ownerId, demo.id, draft)
      scenario.itemId = demo.id
      const task = await submitTask(ownerId, "test", {
        agentId,
        goal: `CASE=demonstrations RUN=${run}; Apply the demonstrated report manual.`,
        manualId: demo.id,
        clientRequestId: run,
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 8 },
      })
      const result = await completed(task.taskId)
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, result.artifacts[0].storagePath),
          "utf8"
        ),
        "DEMONSTRATED_RESULT"
      )
      assert.equal(scenario.calls.length, 3)
      assert.equal((await workspaceRow(agentId)).mode, "idle")
      checks.push({
        check:
          "Actual editor human input observed by application class, private text omitted; editable demonstration manual saved and loaded by a new Task with verified output file",
        taskId: task.taskId,
      })
    }
    if (focus === "automations") {
      const { manageChatRoutine } = await import("@/lib/companion/routines")
      const { rotateRoutineWebhook, acceptRoutineEvent } =
        await import("@/lib/routine-events")
      const { updateCompanion } = await import("@/lib/companion/store")
      const run = randomUUID(),
        agentId = randomUUID(),
        scenario: Scenario = { kind: "automations", calls: [] }
      scenarios.set(run, scenario)
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Automation','Assistant','fixture','custom/runtime-fixture',now(),now())",
        [agentId]
      )
      agents.push(agentId)
      await updateCompanion(ownerId, agentId, { typingPace: "off" })
      const routine = (await manageChatRoutine(ownerId, agentId, `runtime:${run}`, {
        action: "create",
        plan: {
          name: "Event processing",
          prompt: `CASE=automations RUN=${run}; Process trigger value`,
          schedule: { kind: "daily", time: "09:00" },
          eventTrigger: { kind: "webhook" },
          enabled: true,
        },
      })) as { id: string }
      const credential = await rotateRoutineWebhook(routine.id)
      const event = { id: run, data: { message: "trigger value" } }
      const accepted = await acceptRoutineEvent(routine.id, credential.token, event)
      assert.equal(
        (await acceptRoutineEvent(routine.id, credential.token, event)).runId,
        accepted.runId
      )
      const taskId = await until(
        async () =>
          (
            await pool.query("SELECT task_id FROM routine_runs WHERE id=$1", [
              accepted.runId,
            ])
          ).rows[0].task_id,
        "DBOS event dispatch"
      )
      await completed(taskId)
      assert.equal(scenario.calls.length, 1)
      await manageChatRoutine(ownerId, agentId, `pause:${run}`, {
        action: "pause",
        id: routine.id,
        version: 1,
      })
      await assert.rejects(
        acceptRoutineEvent(routine.id, credential.token, { ...event, id: randomUUID() }),
        { status: 409 }
      )
      checks.push({
        check:
          "Chat-created webhook routine reaches existing DBOS dispatcher and actual Task once; duplicate event reuses run, pause rejects new events",
        taskId,
      })
    }
    if (focus === "connections") {
      const { startMcpFixture } = await import("./fixtures/mcp-server.mjs")
      const { saveConnection, discoverConnection } = await import("@/lib/connections")
      const fixture = await startMcpFixture()
      try {
        const connection = await saveConnection(ownerId, {
          name: "Runtime service",
          enabled: true,
          config: {
            kind: "mcp_http",
            url: fixture.url + "/mcp",
            bearer: "fixture-access",
          },
        })
        await discoverConnection(ownerId, connection.id)
        const run = await submit(
          "connections",
          false,
          "custom/runtime-fixture",
          async (scenario) => {
            scenario.itemId = connection.id
          }
        )
        const first = await pending(run.taskId, "connection_call")
        assert.deepEqual(fixture.writes, [])
        assert.deepEqual(first.payload.input, {
          connectionId: connection.id,
          tool: "fixture_write",
          args: { text: "approved-once" },
        })
        await stop()
        await respondToRequest(ownerId, first.id, "approve", first.payloadVersion, {
          answer: "Approve exact first write",
        })
        await start()
        const second = await pending(run.taskId, "connection_call")
        assert.deepEqual(fixture.writes, ["approved-once"])
        await respondToRequest(ownerId, second.id, "approve", second.payloadVersion, {
          answer: "Approve controlled lost-response case",
        })
        const review = await until(async () => {
          const task = await getTask(ownerId, run.taskId)
          return task.requests.find(
            (request) =>
              request.status === "pending" && request.payload.tool === "connection_call"
          )
        }, "connection effect review")
        assert.deepEqual(fixture.writes, ["approved-once", "lose-receipt"])
        await stop()
        await respondToRequest(ownerId, review.id, "continue", review.payloadVersion, {
          note: "Fixture service shows the write happened; continue without another send",
        })
        await start()
        await completed(run.taskId)
        assert.deepEqual(fixture.writes, ["approved-once", "lose-receipt"])
        assert.equal(run.scenario.calls.length, 4)
        const actions = await pool.query(
          "SELECT status FROM task_actions WHERE task_id=$1 AND kind='connection_call' ORDER BY action_no",
          [run.taskId]
        )
        assert.deepEqual(
          actions.rows.map((row) => row.status),
          ["succeeded", "succeeded", "unknown"]
        )
        checks.push({
          check:
            "Actual MCP read; exact write approval survives worker restart; interrupted external response is reconciled through owner review without another call",
          taskId: run.taskId,
        })
      } finally {
        await fixture.close()
      }
    }
    if (focus === "fileinput") {
      const { saveUpload } = await import("@/lib/uploads")
      const { appendTaskSupplement } = await import("@/lib/task-supplements")
      const { default: sharp } = await import("sharp")
      const run = randomUUID(),
        agentId = randomUUID(),
        scenario: Scenario = { kind: "fileinput", calls: [] }
      scenarios.set(run, scenario)
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'File input','Assistant','fixture','custom/runtime-fixture',now(),now())",
        [agentId]
      )
      agents.push(agentId)
      const generated = spawnSync(
        "python3",
        ["tests/fixtures/input-files.py", directory],
        { encoding: "utf8" }
      )
      assert.equal(generated.status, 0, generated.stderr)
      const files = []
      for (const name of [
        "values.csv",
        "instructions.docx",
        "totals.xlsx",
        "reference.pdf",
      ])
        files.push(
          await saveUpload(
            ownerId,
            agentId,
            name,
            await readFile(path.join(directory, name))
          )
        )
      files.push(
        await saveUpload(
          ownerId,
          agentId,
          "picture.png",
          await sharp({
            create: { width: 16, height: 16, channels: 3, background: "blue" },
          })
            .png()
            .toBuffer()
        )
      )
      const task = await submitTask(ownerId, "test", {
        agentId,
        goal: `CASE=fileinput RUN=${run}; Read all attached inputs, wait for revised CSV, deliver combined result.`,
        clientRequestId: run,
        attachmentIds: files.map((file) => file.id),
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 12 },
      })
      const request = await pending(task.taskId, "question")
      await stop()
      const revised = await saveUpload(
        ownerId,
        agentId,
        "revised.csv",
        Buffer.from("name,total\nRevised,84\n")
      )
      await appendTaskSupplement(ownerId, task.taskId, {
        text: "Use the attached revised CSV",
        clientRequestId: randomUUID(),
        attachmentIds: [revised.id],
      })
      await respondToRequest(ownerId, request.id, "approve", request.payloadVersion, {
        answer: "Read the revised attachment",
        note: "Read the revised attachment",
      })
      await start()
      const result = await completed(task.taskId)
      assert.equal(scenario.calls.length, 5)
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, result.artifacts[0].storagePath),
          "utf8"
        ),
        "PDF WORD EXCEL CSV IMAGE: 42; revised CSV: 84"
      )
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_events WHERE task_id=$1 AND type='upload_imported'",
            [task.taskId]
          )
        ).rows[0].n,
        6
      )
      checks.push({
        check:
          "Real task reads PDF via Poppler, Word/Excel via LibreOffice, CSV via Python and actual image in model; attachment added during restart is imported once and final bytes verified",
        taskId: task.taskId,
      })
    }
    if (focus === "memoryrecall") {
      const summaryId = randomUUID(),
        oldId = randomUUID()
      const run = await submit(
        "memoryrecall",
        false,
        "custom/runtime-fixture",
        async (_scenario, agentId) => {
          await pool.query(
            "INSERT INTO memories(id,agent_id,kind,topic,content,created_at) VALUES($1,$2,'summary','Reports','Report preferences',now())",
            [summaryId, agentId]
          )
          await pool.query(
            "INSERT INTO memories(id,agent_id,summary_id,content,created_at) VALUES($1,$2,$3,'Old preference: blue',now()-interval '1 year')",
            [oldId, agentId, summaryId]
          )
          await pool.query(
            "INSERT INTO memories(id,agent_id,summary_id,content,created_at,updated_at) SELECT gen_random_uuid()::text,$1,$2,'Recent note '||n,now()+n*interval '1 second',now()+n*interval '1 second' FROM generate_series(1,70) n",
            [agentId, summaryId]
          )
        }
      )
      const request = await pending(run.taskId, "question")
      assert.equal(run.scenario.calls.length, 5)
      await stop()
      await pool.query(
        "UPDATE memories SET content='Current preference: green',updated_at=now()+interval '5 minutes' WHERE id=$1",
        [oldId]
      )
      await pool.query(
        "UPDATE memories SET content='Current report preferences' WHERE id=$1",
        [summaryId]
      )
      await pool.query(
        "DELETE FROM memories WHERE agent_id=$1 AND content='Recent note 70'",
        [run.agentId]
      )
      await respondToRequest(ownerId, request.id, "approve", request.payloadVersion, {
        answer: "Use current preferences",
        note: "Use current preferences",
      })
      await start()
      const result = await completed(run.taskId)
      assert.equal(run.scenario.calls.length, 8)
      assert.equal(
        await readFile(
          path.join(process.env.ARTIFACT_DIR!, result.artifacts[0].storagePath),
          "utf8"
        ),
        "green"
      )
      const writes = await pool.query(
        "SELECT input->>'content' AS content FROM task_actions WHERE task_id=$1 AND kind='fs_write' AND status='succeeded' ORDER BY action_no",
        [run.taskId]
      )
      assert.deepEqual(
        writes.rows.map((row) => row.content),
        ["blue", "green"]
      )
      checks.push({
        check:
          "Real task recalls note beyond initial 30 through topic pages, writes its value, resumes after worker restart with edited summary/deleted recent note and delivers updated recalled value",
        taskId: run.taskId,
      })
    }
    if (focus === "memory") {
      const memory = await submit("memory")
      await completed(memory.taskId)
      assert.equal(memory.scenario.calls.length, 5)
      const receipts = (
        await pool.query(
          "SELECT payload FROM task_events WHERE task_id=$1 AND type='memory_changed' ORDER BY seq",
          [memory.taskId]
        )
      ).rows
      assert.equal(receipts.length, 4)
      const { executeMemoryTool } = await import("@/worker/memory")
      const replay = await executeMemoryTool(
        memory.taskId,
        1,
        1,
        "memory_write",
        { note: "Remembered then deliberately forgotten fixture" },
        0
      )
      assert.deepEqual(
        replay,
        receipts[0].payload.result,
        "Business receipt survives a missing workflow checkpoint"
      )
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM memories WHERE id=$1", [
            replay.output.id,
          ])
        ).rows[0].n,
        0,
        "Replaying a previously committed write must not resurrect a later-forgotten note"
      )
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM memories WHERE id=$1", [
            memory.scenario.otherMemoryId,
          ])
        ).rows[0].n,
        1
      )
      const run = randomUUID(),
        next: Scenario = { kind: "memory_read", calls: [] }
      scenarios.set(run, next)
      const { taskId } = await submitTask(ownerId, "test", {
        agentId: memory.agentId,
        goal: `CASE=memory_read RUN=${run}; Use the saved preferences.`,
        clientRequestId: run,
        completionContract: { requireHumanReview: false },
        budget: { maxSteps: 5 },
      })
      await completed(taskId)
      assert.equal(next.calls.length, 1)
      checks.push({
        check:
          "Durable memory tools save/forget per-agent notes, refuse another agent's id, atomically replay prior receipts without resurrecting deleted notes, and load retained preferences into a future task",
        taskId: memory.taskId,
        nextTaskId: taskId,
      })
    }
    if (focus === "recovery") {
      const checkpoint = await submit("checkpoint")
      await until(
        async () => !!checkpoint.scenario.release,
        "model request reached the controlled provider"
      )
      const lock = await pool.connect()
      await lock.query("BEGIN")
      await lock.query("LOCK TABLE dbos.operation_outputs IN SHARE MODE")
      try {
        checkpoint.scenario.release!()
        await until(
          async () =>
            (
              await pool.query(
                "SELECT status FROM task_model_decisions WHERE task_id=$1 AND decision_no=1",
                [checkpoint.taskId]
              )
            ).rows[0]?.status === "succeeded",
          "model response journal committed before DBOS checkpoint"
        )
        await stop()
      } finally {
        await lock.query("ROLLBACK")
        lock.release()
      }
      await start()
      const recovered = await completed(checkpoint.taskId)
      assert.equal(checkpoint.scenario.calls.length, 3)
      assert.equal(
        (
          await pool.query(
            "SELECT attempts FROM task_model_decisions WHERE task_id=$1 AND decision_no=1",
            [checkpoint.taskId]
          )
        ).rows[0].attempts,
        1
      )
      assert.equal(recovered.artifacts.length, 1)
      assert(
        JSON.stringify(checkpoint.scenario.calls[1].messages).includes("image_url"),
        "Fresh post-restart screenshot must reach the compatible provider as an image"
      )
      checks.push({
        check:
          "Saved model response survives a missing DBOS checkpoint; no repeat generation, stale decision refused and a fresh CUA screenshot reaches the next model call",
      })

      const interrupted = await submit("interrupted")
      await until(async () => !!interrupted.scenario.pending, "unanswered model call")
      await stop()
      await start()
      const retry = await pending(interrupted.taskId, "model_retry")
      assert.equal(
        interrupted.scenario.calls.length,
        1,
        "A possibly billed request must not be retried automatically"
      )
      await respondToRequest(ownerId, retry.id, "continue", retry.payloadVersion, {})
      const resolved = await completed(interrupted.taskId)
      assert.equal(interrupted.scenario.calls.length, 3)
      assert.equal(resolved.usage.uncertain_attempts, 1)
      assert.equal(resolved.usage.unknown_cost_attempts, 1)
      assert.equal(resolved.artifacts.length, 1)
      checks.push({
        check:
          "Unanswered model request + worker SIGKILL waits for owner consent; explicit retry succeeds and retains the possibly billed attempt as unknown cost",
      })
    }
    if (focus === "cua") {
      const cua = await submit("cua")
      await until(async () => !!cua.scenario.release, "CUA model request ready")
      const { controller, workspaceRow } = await import("@/lib/workstation")
      const name = workstationName(cua.agentId)
      await docker([
        "cp",
        "tests/fixtures/report-site.mjs",
        `${name}:/tmp/report-site.mjs`,
      ])
      await docker(["exec", "-d", name, "node", "/tmp/report-site.mjs"])
      await until(
        async () =>
          (
            await dockerRaw([
              "exec",
              name,
              "curl",
              "-fsS",
              "http://127.0.0.1:8081/health",
            ])
          ).exitCode === 0,
        "CUA fixture site ready"
      )
      cua.scenario.release!()
      const takeover = await until(async () => {
        const task = await getTask(ownerId, cua.taskId)
        const failure = task.requests.find(
          (request) =>
            request.status === "pending" && request.payload.purpose === "execution_error"
        )
        if (failure) throw new Error(JSON.stringify(failure.payload))
        return task.control?.mode === "human"
          ? task.requests.find(
              (request) => request.kind === "takeover" && request.status === "pending"
            )
          : undefined
      }, "CUA human-ready")
      await stop()
      await start()
      assert.equal(
        cua.scenario.calls.length,
        4,
        "Restart during human wait must not regenerate model decisions"
      )
      const human = await workspaceRow(cua.agentId)
      await docker(["exec", name, "xdotool", "key", "Tab"])
      await docker([
        "exec",
        name,
        "xdotool",
        "type",
        "--clearmodifiers",
        "--delay",
        "10",
        "demo",
      ])
      await docker(["exec", name, "xdotool", "key", "Return"])
      await until(async () => {
        const pages = await controller<{ pages: { pageId: string }[] }>(
          cua.agentId,
          "/pages",
          { epoch: human.epoch }
        )
        for (const page of pages.pages) {
          const observation = await controller<{ text: string }>(
            cua.agentId,
            "/observe",
            { epoch: human.epoch, pageId: page.pageId }
          )
          if (observation.text.includes("Signed in as demo")) return true
        }
        return false
      }, "human desktop login visible to DOM")
      await respondToRequest(ownerId, takeover.id, "handback", takeover.payloadVersion, {
        note: "manual login completed fixture",
      })
      const delivered = await completed(cua.taskId)
      assert.equal(cua.scenario.calls.length, 9)
      const bytes = await readFile(
        path.join(process.env.ARTIFACT_DIR!, delivered.artifacts[0].storagePath),
        "utf8"
      )
      assert.match(bytes, /^date,site,amount\n2026-10-12,A,100/)
      assert.equal(
        JSON.parse(
          (
            await docker(["exec", name, "curl", "-fsS", "http://127.0.0.1:8081/state"])
          ).stdout.toString()
        ).downloads,
        1
      )
      checks.push({
        check:
          "CUA model loop: DOM login preparation -> durable human takeover -> real desktop keyboard login -> handback note/fresh screenshot -> fresh DOM download -> checked artifact; one browser and one download; tool-image batch ordering and worker restart during human wait",
        taskId: cua.taskId,
      })
    }
    if (focus === "ui") {
      await setSetting("provider.custom.apiKey", null)
      const web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17097",
        ],
        { env: process.env, detached: true }
      )
      let webLog = ""
      web.stdout!.on("data", (data) => {
        webLog += data
      })
      web.stderr!.on("data", (data) => {
        webLog += data
      })
      const { chromium } = await import("playwright")
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        await until(async () => {
          if (web.exitCode !== null) throw new Error(webLog)
          try {
            return (await fetch(`${process.env.APP_URL}/login`)).ok
          } catch (error) {
            if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED")
              return false
            throw error
          }
        }, "UI Web ready")
        assert.equal((await fetch(`${process.env.APP_URL}/api/settings`)).status, 401)
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.UI_BROWSER_PATH,
        })
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        })
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).click()
        await page.getByRole("heading", { name: "模型与 Agent", exact: true }).waitFor()
        await page.getByLabel("模型服务商").selectOption("custom")
        await page.getByLabel(/API Key/).fill(testKey)
        await page
          .getByLabel("API 地址", { exact: true })
          .fill(`http://127.0.0.1:${port}/v1`)
        await page.getByRole("button", { name: "保存服务配置", exact: true }).click()
        await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor()
        assert.equal(await page.getByLabel(/API Key/).inputValue(), "")
        const settingsJson = await (
          await context.request.get(`${process.env.APP_URL}/api/settings`)
        ).json()
        assert(!JSON.stringify(settingsJson).includes(testKey))
        const crossOrigin = await context.request.patch(
          `${process.env.APP_URL}/api/settings`,
          {
            headers: { Origin: "https://untrusted.fixture.test" },
            data: [{ key: "model.default", value: "custom/runtime-fixture" }],
          }
        )
        assert.equal(crossOrigin.status(), 403)
        await page.getByLabel("默认模型", { exact: true }).fill("custom/runtime-fixture")
        await page.getByRole("button", { name: "保存默认配置", exact: true }).click()
        await page
          .getByRole("button", { name: "保存默认配置", exact: true })
          .waitFor({ state: "visible" })
        await page.getByLabel("Agent 名称", { exact: true }).fill("UI Agent")
        await page.getByLabel("Agent 职责", { exact: true }).fill("Report preparation")
        await page
          .getByLabel("Agent 长期指令", { exact: true })
          .fill("Deliver checked reports and explicitly identify unverified facts.")
        const createdResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/agents" &&
            response.request().method() === "POST"
        )
        await page.getByRole("button", { name: "创建 Agent", exact: true }).click()
        const created = await createdResponse
        assert.equal(created.status(), 201)
        const agent = await created.json()
        agents.push(agent.id)
        await page.getByRole("status").filter({ hasText: "Agent 已保存" }).waitFor()
        await page
          .getByLabel("新增记忆", { exact: true })
          .fill("UI memory fixture: weekly reports use three Chinese bullet points.")
        await page.getByRole("button", { name: "保存记忆", exact: true }).click()
        await page
          .getByText(
            "UI memory fixture: weekly reports use three Chinese bullet points.",
            { exact: true }
          )
          .waitFor()
        await page.getByRole("button", { name: "刷新记忆", exact: true }).click()
        await page
          .getByText(
            "UI memory fixture: weekly reports use three Chinese bullet points.",
            { exact: true }
          )
          .waitFor()
        const wrongAgentDelete = await context.request.delete(
          `${process.env.APP_URL}/api/agents/${agent.id}/memory`,
          { headers: { Origin: process.env.APP_URL! }, data: { id: "unrelated-note" } }
        )
        assert.equal(wrongAgentDelete.status(), 404)
        assert(!(await page.content().then((html) => html.includes(testKey))))
        await page.screenshot({
          path: path.join(directory, "settings.png"),
          fullPage: true,
        })
        await page.getByRole("link", { name: "返回工作现场", exact: true }).click()
        await page.getByLabel("选择 Agent").selectOption(agent.id)
        const run = randomUUID(),
          scenario: Scenario = { kind: "report", calls: [] }
        scenarios.set(run, scenario)
        await page
          .getByLabel("交办任务", { exact: true })
          .fill(`CASE=report RUN=${run}; Prepare the weekly CSV report.`)
        await page.getByText("交付检查与执行额度（可选）", { exact: true }).click()
        await page.getByLabel("CSV 文件路径", { exact: true }).fill("report.csv")
        await page.getByLabel("CSV 必需字段", { exact: true }).fill("date,amount")
        await page.getByLabel("CSV 最少数据行", { exact: true }).fill("2")
        await page.getByLabel("CSV 日期字段", { exact: true }).fill("date")
        await page.getByLabel("CSV 开始日期", { exact: true }).fill("2026-10-12")
        await page.getByLabel("CSV 结束日期", { exact: true }).fill("2026-10-18")
        await page.getByLabel("交付前由我确认", { exact: true }).check()
        const acceptedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/tasks" &&
            response.request().method() === "POST"
        )
        await page.getByRole("button", { name: "交给 Agent", exact: true }).click()
        const accepted = await acceptedResponse
        assert.equal(accepted.status(), 202, await accepted.text())
        const { taskId } = await accepted.json()
        await page.getByText(`任务 ID：${taskId}`, { exact: true }).waitFor()
        await page
          .getByRole("heading", { name: "请检查交付结果", exact: true })
          .waitFor({ timeout: 60000 })
        assert.equal(scenario.calls.length, 4)
        assert.match(
          JSON.stringify(scenario.calls[0].messages),
          /UI memory fixture: weekly reports use three Chinese bullet points/
        )
        await page.getByRole("button", { name: "确认交付", exact: true }).click()
        await page.getByRole("heading", { name: "已完成", exact: true }).waitFor()
        const downloadEvent = page.waitForEvent("download")
        await page.getByRole("link", { name: "report.csv", exact: true }).click()
        const download = await downloadEvent
        assert.equal(await download.failure(), null)
        await download.saveAs(path.join(directory, "ui-report.csv"))
        assert.equal(
          await readFile(path.join(directory, "ui-report.csv"), "utf8"),
          goodCsv
        )
        await page.screenshot({
          path: path.join(directory, "report.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 390, height: 844 })
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
          ),
          false
        )
        await page.screenshot({
          path: path.join(directory, "mobile-report.png"),
          fullPage: true,
        })
        const chatRun = randomUUID(),
          chatScenario: Scenario = { kind: "chat_edit", calls: [] }
        scenarios.set(chatRun, chatScenario)
        const followupText = `CASE=chat_edit RUN=${chatRun}; 把刚才报表的金额翻倍。`
        await page.getByLabel("继续对话", { exact: true }).fill(followupText)
        await page.getByLabel("继续对话", { exact: true }).press("Shift+Enter")
        assert.equal(
          await page.getByLabel("继续对话", { exact: true }).inputValue(),
          followupText + "\n"
        )
        await page.getByLabel("继续对话", { exact: true }).fill(followupText)
        let acceptedButLost: { taskId: string; threadId: string } | undefined
        let interceptError: string | undefined,
          interceptFinished = false
        await page.route("**/api/tasks", async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue()
            return
          }
          try {
            const actual = await route.fetch({ timeout: 15000 })
            assert.equal(actual.status(), 202)
            acceptedButLost = await actual.json()
            await route.abort("failed")
          } catch (cause) {
            interceptError =
              cause instanceof Error ? cause.message.split("Call log:")[0] : String(cause)
          } finally {
            interceptFinished = true
          }
        })
        await page.getByRole("button", { name: "发送追问", exact: true }).click()
        await until(async () => {
          if (interceptError) throw new Error(interceptError)
          return interceptFinished
        }, "accepted HTTP response intentionally lost")
        await page.getByRole("alert", { name: "任务错误", exact: true }).waitFor()
        assert.equal(
          await page.getByLabel("继续对话", { exact: true }).inputValue(),
          followupText
        )
        assert(acceptedButLost)
        await completed(acceptedButLost.taskId)
        await page.unroute("**/api/tasks")
        await page.reload()
        await page.getByLabel("继续对话", { exact: true }).waitFor()
        await until(
          async () =>
            (await page.getByLabel("继续对话", { exact: true }).inputValue()) ===
            followupText,
          "draft survives reload after a lost acceptance response"
        )
        const repeatedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/tasks" &&
            response.request().method() === "POST"
        )
        await page.getByRole("button", { name: "发送追问", exact: true }).click()
        const repeated = await repeatedResponse
        assert.equal(repeated.status(), 200)
        assert.equal((await repeated.json()).taskId, acceptedButLost.taskId)
        await page
          .getByText(`任务 ID：${acceptedButLost.taskId}`, { exact: true })
          .waitFor()
        await page
          .getByRole("link", { name: "report-doubled.csv", exact: true })
          .waitFor()
        assert.equal(chatScenario.calls.length, 3)
        assert.equal(
          (
            await pool.query("SELECT count(*)::int AS n FROM tasks WHERE thread_id=$1", [
              acceptedButLost.threadId,
            ])
          ).rows[0].n,
          2
        )
        const revisedDownloadEvent = page.waitForEvent("download")
        await page.getByRole("link", { name: "report-doubled.csv", exact: true }).click()
        const revisedDownload = await revisedDownloadEvent
        await revisedDownload.saveAs(path.join(directory, "ui-report-doubled.csv"))
        assert.equal(
          await readFile(path.join(directory, "ui-report-doubled.csv"), "utf8"),
          doubledCsv
        )
        assert.equal(
          await page.evaluate(
            () => (window as { __agentInjected?: boolean }).__agentInjected
          ),
          undefined
        )
        await page.getByRole("button", { name: "重命名对话", exact: true }).click()
        await page.getByLabel("对话名称", { exact: true }).fill("周报追问与修正")
        await page.getByRole("button", { name: "保存名称", exact: true }).click()
        await page.getByRole("heading", { name: "周报追问与修正", exact: true }).waitFor()
        const exportedEvent = page.waitForEvent("download")
        await page.getByRole("link", { name: "导出对话", exact: true }).click()
        const exported = await exportedEvent
        await exported.saveAs(path.join(directory, "conversation.md"))
        const exportedText = await readFile(
          path.join(directory, "conversation.md"),
          "utf8"
        )
        assert.match(exportedText, /Prepare the weekly CSV report/)
        assert.match(exportedText, /把刚才报表的金额翻倍/)
        assert.match(exportedText, /原交付文件保持不变/)
        assert.equal(
          (
            await context.request.get(
              `${process.env.APP_URL}/api/threads/${acceptedButLost.threadId}?before=0`
            )
          ).status(),
          400
        )
        assert.equal(
          (
            await context.request.patch(
              `${process.env.APP_URL}/api/threads/${acceptedButLost.threadId}`,
              {
                headers: { Origin: "https://untrusted.fixture.test" },
                data: { title: "untrusted" },
              }
            )
          ).status(),
          403
        )
        await page.reload()
        await page
          .getByText(`任务 ID：${acceptedButLost.taskId}`, { exact: true })
          .waitFor()
        await page.getByRole("heading", { name: "周报追问与修正", exact: true }).waitFor()
        await page
          .getByLabel("消息列表", { exact: true })
          .getByText("已将刚才报表的金额翻倍，原交付文件保持不变。", { exact: true })
          .waitFor()
        await until(
          async () =>
            page
              .getByLabel("消息列表", { exact: true })
              .evaluate(
                (element) =>
                  element.scrollHeight - element.scrollTop - element.clientHeight < 2
              ),
          "reloaded chat follows the latest reply"
        )
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth
          ),
          false
        )
        await page.screenshot({
          path: path.join(directory, "mobile-chat.png"),
          fullPage: true,
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({ path: path.join(directory, "chat.png"), fullPage: true })
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).click()
        await page.getByLabel("编辑 Agent", { exact: true }).selectOption(agent.id)
        await page
          .getByRole("button", {
            name: "忘记：UI memory fixture: weekly reports use three Chinese bullet points.",
            exact: true,
          })
          .click()
        await page
          .getByText("还没有记忆。可以在此添加，也可以让 Agent 记住你的偏好。", {
            exact: true,
          })
          .waitFor()
        assert.deepEqual(pageErrors, [])
        checks.push({
          check:
            "Owner UI: configuration/agent/memory, CSV correction/approval/download; same-thread follow-up edits original guest file, acceptance-response loss + reload preserves draft/idempotency key and reuses the accepted task; ordered transcript, rename/export, persistent task URL, mobile layout, raw HTML/external image blocking and Origin/input guards",
          taskId,
          browser: browser.version(),
        })
      } finally {
        for (const context of browser?.contexts() ?? [])
          await context.unrouteAll({ behavior: "wait" })
        await browser?.close()
        if (web.exitCode === null && web.pid) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "web.log"), webLog)
      }
    }
    const stored = await pool.query("SELECT config_snapshot,result FROM tasks")
    const durableOutputs = await pool.query(
      "SELECT output,error FROM dbos.operation_outputs"
    )
    assert(!JSON.stringify([stored.rows, durableOutputs.rows]).includes(testKey))
    checks.push({
      check:
        "Provider key encrypted at rest, local config overrides env, masked settings view; plaintext key absent from task/DBOS records",
    })
    assert.deepEqual(serverErrors, [])
    await stop("SIGTERM")
    if (
      focus === "vault" ||
      focus === "vaultfill" ||
      focus === "identity" ||
      focus === "payments" ||
      focus === "paymentdeadline" ||
      focus === "paymentsubmit"
    ) {
      for (const name of (await readdir(directory)).filter((name) =>
        name.endsWith(".log")
      )) {
        const log = await readFile(path.join(directory, name), "utf8")
        for (const value of vaultPlaintexts)
          assert(!log.includes(value), `Plaintext in ${name}`)
      }
      checks.push({
        check:
          focus === "vaultfill" ||
          focus === "identity" ||
          focus === "payments" ||
          focus === "paymentdeadline" ||
          focus === "paymentsubmit"
            ? "Completed Web/worker logs, actual guest journals/controller logs and model requests contain no sample secret values; website inputs are independently counted and matched"
            : "Completed Web/worker logs contain no sample vault plaintext; storage/provisioning slice does not evaluate guest filling",
      })
    }
    if (focus === "vaultfill") assert.equal(guestFillTasksEvaluated, 13)
    if (focus === "identity") assert.equal(identityTasksEvaluated, 10)
    if (focus === "payments") assert.equal(paymentTasksEvaluated, 15)
    if (focus === "paymentdeadline") assert.equal(paymentTasksEvaluated, 1)
    if (focus === "paymentsubmit")
      assert.equal(
        paymentTasksEvaluated,
        paymentEdgesOnly ? 11 : paymentRecoveryOnly ? 1 : 9
      )
    if (focus === "handoff") assert.equal(handoffTasksEvaluated, 11)
    if (focus === "routinehandoff") assert.equal(routineHandoffTasksEvaluated, 3)
    passed = true
  } finally {
    if (worker) await stop()
    for (const id of agents) {
      for (const name of [viewerName(id), workstationName(id)]) {
        const log = await dockerRaw(["logs", name])
        await writeFile(
          path.join(directory, `${name}.log`),
          log.stdout.toString() + log.stderr
        )
        const result = await dockerRaw(["rm", "--force", name])
        if (result.exitCode !== 0 && !/no such (container|object)/i.test(result.stderr))
          console.error(result.stderr)
      }
      for (const volume of [workstationVolume(id), displayVolume(id)]) {
        const result = await dockerRaw(["volume", "rm", volume])
        if (result.exitCode !== 0 && !/no such volume/i.test(result.stderr))
          console.error(result.stderr)
      }
    }
    await closeDurableClient()
    await pool.end()
  }
} finally {
  for (const scenario of scenarios.values()) {
    scenario.pending?.destroy()
    scenario.release?.()
  }
  modelServer.closeAllConnections()
  modelServer.close()
  await once(modelServer, "close")
  const applicationVersion = (await import("@/lib/durable")).APPLICATION_VERSION
  const migration = JSON.parse(await readFile("db/migrations/meta/_journal.json", "utf8"))
    .entries.at(-1)
    .tag.split("_")[0]
  const result = {
    passed,
    applicationVersion,
    migration,
    controlledProvider: true,
    realModelJudgmentEvaluated: false,
    ...(focus === "routinehandoff"
      ? {
          guestProtocolVersion: 5,
          routineDelegationRosterEvaluated: passed,
          routineHandoffTasksEvaluated,
          originalHandoffSuiteRerun: false,
        }
      : {}),
    ...(focus === "handoff"
      ? {
          applicationVersion,
          migration,
          guestProtocolVersion: 5,
          controlledWebsite: false,
          sequentialHandoffEvaluated: passed,
          handoffTasksEvaluated,
          parallelDelegationEvaluated: false,
          realModelJudgmentEvaluated: false,
        }
      : {}),
    ...(focus === "vaultfill"
      ? {
          applicationVersion,
          guestProtocolVersion: 5,
          workstationImage: process.env.WORKSTATION_IMAGE,
          controlledWebsite: true,
          guestFillEvaluated: passed,
          guestFillTasksEvaluated,
        }
      : {}),
    ...(focus === "identity"
      ? {
          applicationVersion,
          guestProtocolVersion: 5,
          workstationImage: process.env.WORKSTATION_IMAGE,
          controlledWebsite: true,
          identityFillEvaluated: passed,
          identityTasksEvaluated,
          paymentFillEvaluated: false,
          paymentSubmissionEvaluated: false,
        }
      : {}),
    ...(focus === "payments"
      ? {
          applicationVersion,
          guestProtocolVersion: 5,
          workstationImage: process.env.WORKSTATION_IMAGE,
          controlledWebsite: true,
          paymentPreparationEvaluated: passed,
          paymentTasksEvaluated,
          paymentSubmissionEvaluated: false,
          realPaymentEvaluated: false,
        }
      : {}),
    ...(focus === "paymentdeadline"
      ? {
          applicationVersion,
          guestProtocolVersion: 5,
          controlledWebsite: true,
          paymentDeadlineBeforeReleaseVerified: passed,
          paymentTasksEvaluated,
          actualPaymentEvaluated: false,
        }
      : {}),
    ...(focus === "paymentsubmit"
      ? {
          applicationVersion,
          guestProtocolVersion: 5,
          workstationImage: process.env.WORKSTATION_IMAGE,
          migration,
          controlledWebsite: true,
          paymentSubmissionControlledEvaluated:
            passed && !paymentRecoveryOnly && !paymentEdgesOnly,
          paymentSubmissionRecoveryEvaluated: passed && paymentRecoveryOnly,
          paymentSubmissionEdgesEvaluated: passed && paymentEdgesOnly,
          focusedLostReceiptOnly: paymentRecoveryOnly,
          focusedEdgesOnly: paymentEdgesOnly,
          paymentTasksEvaluated,
          realPaymentEvaluated: false,
          independentSettlementVerified: false,
        }
      : {}),
    ...(focus === "reports"
      ? {
          controlledWebsite: true,
          controlledTelegramApi: true,
          realTelegramConnectivityEvaluated: false,
          realSourceAuthenticityEvaluated: false,
        }
      : {}),
    checks,
    directory,
    recordedAt: new Date().toISOString(),
  }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n"
  )
  if (passed) {
    await writeFile(
      `docs/evidence/runtime${focus === "core" ? "" : `-${focus}${paymentRecoveryOnly ? "-recovery" : paymentEdgesOnly ? "-edges" : ""}`}.json`,
      JSON.stringify(result, null, 2) + "\n"
    )
    await until(
      async () =>
        (
          await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [
            database,
          ])
        ).rowCount === 0,
      "Test database clients actually disconnected",
      5000
    )
    await admin.query(`DROP DATABASE "${database}"`)
  }
  await admin.end()
  console.log(JSON.stringify(result, null, 2))
}
