import { ensureRecoveryLab } from "./fixtures/recovery-lab"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

const focus = process.argv[2] ?? "core"
assert(process.argv.length <= 3 && ["core", "handoff"].includes(focus))
process.loadEnvFile(".env")
const database = `agent_telegram_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  APP_URL: "http://127.0.0.1:17297",
  WORKER_PORT: "17298",
  WORKSTATION_MEMORY_MB: "2048",
  OWNER_EMAIL: "telegram@fixture.test",
  OWNER_PASSWORD: randomUUID(),
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.1",
})
const token = `123456:${randomUUID().replaceAll("-", "")}`
const userId = 99900001,
  botId = 123456
let updateId = 100,
  messageId = 1000,
  passed = false,
  worker: ChildProcess | undefined,
  web: ChildProcess | undefined,
  round = 0
let taskCounts: { status: string; count: number }[] = []
const checks: { check: string }[] = [],
  errors: string[] = [],
  updates: any[] = [],
  sends: any[] = [],
  modelRequests: any[] = []
const rosterCases = new Map<string, { targetId: string; expected: string[] }>()
let workerLogSaved = Promise.resolve()
let pendingSend: ServerResponse | undefined,
  webhook = "",
  rateLimited = false
const botUser = {
  id: botId,
  is_bot: true,
  first_name: "Fixture Bot",
  username: "personal_fixture_bot",
}
const botServer = createServer((req, res) => {
  void (async () => {
    const method = req.url!.split("/").at(-1)
    let raw = ""
    for await (const chunk of req) raw += chunk
    const params = JSON.parse(raw)
    const answer = (result: unknown) =>
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true, result }))
    if (method === "getMe") return answer(botUser)
    if (method === "getWebhookInfo") return answer({ url: webhook })
    if (method === "getUpdates") {
      const available = updates.filter((update) => update.update_id >= params.offset)
      if (!available.length) await delay(100)
      return answer(available)
    }
    if (method === "sendMessage") {
      sends.push({ ...params, message_id: ++messageId })
      if (params.text === "unknown-send-fixture") {
        req.socket.destroy()
        return
      }
      if (params.text === "crash-send-fixture") {
        pendingSend = res
        return
      }
      if (params.text === "rejected-send-fixture")
        return res.writeHead(400).end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: `Rejected ${token}`,
          })
        )
      if (params.text === "rate-send-fixture" && !rateLimited) {
        rateLimited = true
        return res.writeHead(429).end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Rate limit",
            parameters: { retry_after: 1 },
          })
        )
      }
      return answer({
        message_id: messageId,
        from: botUser,
        chat: { id: Number(params.chat_id), type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: params.text,
      })
    }
    if (method === "answerCallbackQuery") return answer(true)
    throw new Error(`Unexpected Telegram method: ${method}`)
  })().catch((error) => {
    errors.push(String(error))
    res.destroy()
  })
})
await new Promise<void>((resolve) => botServer.listen(0, "127.0.0.1", resolve))
const botPort = (botServer.address() as { port: number }).port
process.env.TELEGRAM_API_URL = `http://127.0.0.1:${botPort}`
delete process.env.TELEGRAM_BOT_TOKEN
const modelServer = createServer((req, res) => {
  void (async () => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    modelRequests.push(body)
    let name: string, input: Record<string, unknown>
    if (focus === "handoff") {
      const prompt = body.messages.findLast(
        (message: any) =>
          message.role === "user" &&
          /CASE=tgroster RUN=([a-f0-9-]+)/.test(JSON.stringify(message.content))
      )
      const marker = /CASE=tgroster RUN=([a-f0-9-]+)/.exec(
        JSON.stringify(prompt.content)
      )![1]
      const scenario = rosterCases.get(marker)!
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? [])
      const listed = calls.find((call: any) => call.function.name === "list_agents")
      if (!listed) {
        name = "list_agents"
        input = {}
      } else {
        const roster = JSON.parse(
          body.messages.find((message: any) => message.tool_call_id === listed.id).content
        )
        assert.deepEqual(
          roster.agents.map((agent: any) => agent.id).sort(),
          [...scenario.expected].sort()
        )
        const recipient = JSON.stringify(body.messages).includes(
          "Historical handoff from agent "
        )
        const delegated = calls.find((call: any) => call.function.name === "delegate")
        if (!recipient && !delegated) {
          name = "delegate"
          input = {
            agentId: scenario.targetId,
            brief: "Finish the phone task with its original frozen roster.",
          }
        } else {
          if (!recipient)
            assert.match(
              body.messages.find((message: any) => message.tool_call_id === delegated.id)
                .content,
              /outside this task's owner-approved delegation roster/
            )
          name = "complete_task"
          input = {
            summary: recipient
              ? "Phone handoff completed."
              : "Phone delegation disabled.",
            files: [],
          }
        }
      }
    } else {
      const first = !body.messages.some((message: any) =>
        message.tool_calls?.some((call: any) => call.function.name === "ask_user")
      )
      const followup = JSON.stringify(body.messages).includes("FOLLOWUP")
      if (followup) assert.match(JSON.stringify(body.messages), /中文回答 fixture/)
      name = !followup && first ? "ask_user" : "complete_task"
      if (!first && !followup)
        assert.match(JSON.stringify(body.messages), /中文回答 fixture/)
      input =
        name === "ask_user"
          ? { question: "请确认使用哪种语言？" }
          : { summary: "已按中文完成 Telegram 任务 fixture。", files: [] }
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "telegram-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${modelRequests.length}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(input),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
    )
  })().catch((error) => {
    errors.push(String(error))
    res.destroy()
  })
})
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve))
const modelPort = (modelServer.address() as { port: number }).port
const logs: string[] = []
async function until<T>(
  check: () => Promise<T | false | undefined>,
  name: string,
  timeout = 75000
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [])
    const result = await check()
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
    env: process.env,
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
    logs.push(output)
    await writeFile(log, output)
  })
  await until(async () => {
    if (worker!.exitCode !== null) throw new Error(output)
    return output.includes("Worker ready")
  }, "worker startup")
}
async function stop(signal: NodeJS.Signals = "SIGKILL") {
  assert(worker?.pid)
  const exited = once(worker, "exit")
  process.kill(-worker.pid, signal)
  await exited
  await workerLogSaved
  worker = undefined
}
function message(
  text: string,
  from = userId,
  type: "private" | "group" = "private",
  extra: Record<string, unknown> = {}
) {
  const update = {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      from: { id: from, is_bot: false, first_name: "Fixture Owner" },
      chat: { id: from, type },
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    },
  }
  updates.push(update)
  return update
}

try {
  await command("scripts/migrate.ts")
  await command("scripts/owner.ts")
  await ensureRecoveryLab()
  const { pool, db } = await import("@/db")
  const schema = await import("@/db/schema")
  const { telegramStatus, changeTelegram, ensureTelegramConnection } =
    await import("@/lib/telegram/state")
  const { processTelegramUpdate } = await import("@/lib/telegram/bridge")
  const { queueTelegram } = await import("@/lib/telegram/notifications")
  const { setSetting } = await import("@/lib/config")
  const { closeDurableClient } = await import("@/lib/durable")
  const { dockerRaw } = await import("@/lib/docker")
  const { workstationName, viewerName, workstationVolume, displayVolume } =
    await import("@/lib/workstation")
  const modelAgentIds: string[] = []
  const owner = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  const fixtureAgent = (
    await pool.query("SELECT id FROM agents WHERE model='fixture/durable-report'")
  ).rows[0].id
  const state = async () => (await ensureTelegramConnection())!
  const processed = (id: number) =>
    until(async () => (await state()).cursor >= id, `update ${id} committed`)
  const noticeByKey = async (key: string) =>
    (
      await pool.query("SELECT * FROM telegram_outbox WHERE generation=$1 AND key=$2", [
        (await state()).generation,
        key,
      ])
    ).rows[0]
  const sentNotice = (key: string) =>
    until(async () => {
      const row = await noticeByKey(key)
      return row?.status === "sent" && row
    }, `notification ${key}`)
  try {
    if (focus === "core") {
      await assert.rejects(telegramStatus("foreign-owner"), { status: 403 })
      await changeTelegram(owner, { action: "token", token })
      await changeTelegram(owner, { action: "agent", agentId: fixtureAgent })
      const pair = await telegramStatus(owner)
      assert(pair.pairCode)
      assert(
        !(
          await pool.query("SELECT value FROM settings WHERE key='telegram.botToken'")
        ).rows[0].value.includes(token)
      )
      assert(!(await state()).pair_code!.includes(pair.pairCode))
      webhook = "https://existing.fixture.test/hook"
      await start()
      await until(
        async () => (await state()).last_error?.includes("webhook"),
        "existing webhook is surfaced without deletion"
      )
      assert.equal(
        (await fetch(`http://127.0.0.1:${process.env.WORKER_PORT}/health`)).status,
        200
      )
      webhook = ""
      await until(
        async () => (await state()).bot_id === String(botId),
        "verified bot identity"
      )
      await processed(message(`/pair ${pair.pairCode}`, userId + 1, "group").update_id)
      await processed(message("/pair INCORRECT").update_id)
      assert.equal((await state()).user_id, null)
      const pairing = message(`/pair ${pair.pairCode}`)
      await processed(pairing.update_id)
      await sentNotice(`update:${pairing.update_id}`)
      assert.equal((await state()).user_id, String(userId))
      await processed(message("unauthorized task", userId + 1).update_id)
      await processed(message("group task", userId, "group").update_id)
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
        0
      )
      checks.push({
        check:
          "Owner-only encrypted token/pairing, expiring one-time private pairing; foreign/group updates consumed without tasks or replies",
      })

      // Block the connection update AFTER submitTask commits; crash before inbox/cursor commit.
      const barrier = new pg.Client({ connectionString: url.toString() })
      await barrier.connect()
      await barrier.query("SELECT pg_advisory_lock(72131009)")
      await pool.query(`CREATE FUNCTION telegram_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.task_id IS DISTINCT FROM OLD.task_id AND NEW.task_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(72131009); END IF;
      RETURN NEW; END $$; CREATE TRIGGER telegram_test_barrier BEFORE UPDATE ON telegram_connection FOR EACH ROW EXECUTE FUNCTION telegram_test_barrier()`)
      const accepted = message("durable acceptance crash fixture")
      const task = await until(
        async () =>
          (await pool.query("SELECT * FROM tasks WHERE source='telegram'")).rows[0],
        "task committed before inbox receipt"
      )
      await until(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'UPDATE telegram_connection SET task_id=%'"
            )
          ).rowCount === 1,
        "exact post-submit barrier"
      )
      await stop()
      await barrier.query("SELECT pg_advisory_unlock(72131009)")
      await barrier.end()
      await pool.query(
        "DROP TRIGGER telegram_test_barrier ON telegram_connection; DROP FUNCTION telegram_test_barrier()"
      )
      await start()
      await processed(accepted.update_id)
      await sentNotice(`update:${accepted.update_id}`)
      await until(
        async () =>
          (await pool.query("SELECT status FROM tasks WHERE id=$1", [task.id])).rows[0]
            .status === "completed",
        "fixture workflow completes after restart"
      )
      await sentNotice(`task:${task.id}:completed`)
      await processTelegramUpdate((await state()).generation, accepted)
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM tasks WHERE source='telegram'"))
          .rows[0].n,
        1
      )
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
            [task.id]
          )
        ).rows[0].n,
        1
      )
      checks.push({
        check:
          "Exact crash after task/DBOS enqueue commit and before inbox/cursor commit; replay reuses one task/workflow and sends a completion notification",
      })

      await processed(message("cancel fixture from phone").update_id)
      const cancelTask = (await state()).task_id!
      await processed(
        message("/stop", userId, "private", {
          reply_to_message: { message_id: 987654, from: botUser },
        }).update_id
      )
      await until(async () => {
        const row = (
          await pool.query(
            "SELECT status,cancel_workflow_pending FROM tasks WHERE id=$1",
            [cancelTask]
          )
        ).rows[0]
        return row.status === "cancelled" && !row.cancel_workflow_pending
      }, "phone cancellation finishes actual fixture activity")
      await sentNotice(`task:${cancelTask}:cancelled`)
      checks.push({
        check:
          "Telegram /stop, even when sent as a reply, uses actual cancellation and emits terminal notification; webhook transport conflict leaves worker health/control available",
      })

      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Telegram model fixture",
          role: "Controlled model protocol",
          model: "custom/telegram-fixture",
        })
        .returning()
      modelAgentIds.push(agent.id)
      await setSetting("provider.custom.apiKey", "controlled-provider-key")
      await setSetting("provider.custom.baseUrl", `http://127.0.0.1:${modelPort}/v1`)
      await changeTelegram(owner, { action: "agent", agentId: agent.id })
      const first = message("QUESTION: ask which language before completing")
      await processed(first.update_id)
      const request = await until(
        async () =>
          (
            await pool.query(
              "SELECT r.* FROM task_requests r JOIN tasks t ON t.id=r.task_id WHERE t.agent_id=$1 AND r.payload->>'purpose'='question'",
              [agent.id]
            )
          ).rows[0],
        "model asks a durable question"
      )
      const questionNotice = await sentNotice(`request:${request.id}:1`)
      await stop()
      await start()
      assert.equal(modelRequests.length, 1)
      await processed(
        message("中文回答 fixture", userId, "private", {
          reply_to_message: { message_id: questionNotice.message_id, from: botUser },
        }).update_id
      )
      await sentNotice(`task:${request.task_id}:completed`)
      assert.equal(modelRequests.length, 2)
      const firstThread = (await state()).thread_id
      const followup = message("FOLLOWUP: reuse my previous answer")
      await processed(followup.update_id)
      const followupTask = (
        await pool.query(
          "SELECT * FROM tasks WHERE agent_id=$1 ORDER BY thread_turn DESC LIMIT 1",
          [agent.id]
        )
      ).rows[0]
      await sentNotice(`task:${followupTask.id}:completed`)
      assert.equal((await state()).thread_id, firstThread)
      assert.equal(followupTask.thread_turn, 2)
      checks.push({
        check:
          "Production model/desktop runtime from phone: question notification, worker restart while waiting, native reply, model completion, then same-thread follow-up with historical answer",
      })

      // Test callback binding/version checks against an actual task with the production request API.
      await changeTelegram(owner, { action: "agent", agentId: fixtureAgent })
      const controlJob = message("callback review fixture")
      await processed(controlJob.update_id)
      const controlTask = (await state()).task_id!
      const { createTaskRequest } = await import("@/worker/requests")
      const requestId = randomUUID()
      await createTaskRequest(controlTask, 1, requestId, "review", {
        purpose: "completion",
        summary: "Review fixture",
      })
      const reviewNotice = await sentNotice(`request:${requestId}:1`)
      const callbackData =
        reviewNotice.payload.reply_markup.inline_keyboard[1][0].callback_data
      const callback = (data: string, from = userId) => {
        const update = {
          update_id: ++updateId,
          callback_query: {
            id: randomUUID(),
            from: { id: from, is_bot: false, first_name: "Fixture Owner" },
            message: {
              message_id: reviewNotice.message_id,
              from: botUser,
              chat: { id: userId, type: "private" },
              date: Math.floor(Date.now() / 1000),
              text: reviewNotice.payload.text,
            },
            data,
          },
        }
        updates.push(update)
        return update
      }
      await processed(callback(callbackData, userId + 1).update_id)
      assert.equal(
        (await pool.query("SELECT decision FROM task_requests WHERE id=$1", [requestId]))
          .rows[0].decision,
        null
      )
      await pool.query("UPDATE task_requests SET payload_version=2 WHERE id=$1", [
        requestId,
      ])
      await processed(callback(callbackData).update_id)
      assert.equal(
        (await pool.query("SELECT decision FROM task_requests WHERE id=$1", [requestId]))
          .rows[0].decision,
        null
      )
      const currentNotice = await sentNotice(`request:${requestId}:2`)
      const valid = {
        update_id: ++updateId,
        callback_query: {
          id: randomUUID(),
          from: { id: userId, is_bot: false, first_name: "Owner" },
          message: {
            message_id: currentNotice.message_id,
            from: botUser,
            chat: { id: userId, type: "private" },
            date: Math.floor(Date.now() / 1000),
          },
          data: currentNotice.payload.reply_markup.inline_keyboard[1][0].callback_data,
        },
      }
      updates.push(valid)
      await processed(valid.update_id)
      assert.equal(
        (await pool.query("SELECT decision FROM task_requests WHERE id=$1", [requestId]))
          .rows[0].decision,
        "complete"
      )
      await until(
        async () =>
          (await pool.query("SELECT status FROM tasks WHERE id=$1", [controlTask]))
            .rows[0].status === "completed",
        "callback fixture completes"
      )
      checks.push({
        check:
          "Callback binds paired sender/private chat/bot message/outbox generation/request version; foreign sender and stale version rejected, current completion decision recorded",
      })

      async function queue(text: string) {
        const client = await pool.connect()
        const key = randomUUID()
        try {
          await queueTelegram(client, await state(), key, text)
        } finally {
          client.release()
        }
        return key
      }
      const unknownKey = await queue("unknown-send-fixture")
      await until(
        async () => (await noticeByKey(unknownKey))?.status === "unknown",
        "transport close after server delivery"
      )
      assert.equal(sends.filter((send) => send.text === "unknown-send-fixture").length, 1)
      const crashKey = await queue("crash-send-fixture")
      await until(
        async () => !!pendingSend && (await noticeByKey(crashKey))?.status === "sending",
        "in-flight outbound send"
      )
      await stop()
      pendingSend!.destroy()
      pendingSend = undefined
      await start()
      await until(
        async () => (await noticeByKey(crashKey))?.status === "unknown",
        "restart conservatively reconciles in-flight send"
      )
      await processed(message("/status").update_id)
      assert.equal(sends.filter((send) => send.text === "unknown-send-fixture").length, 1)
      assert.equal(sends.filter((send) => send.text === "crash-send-fixture").length, 1)
      const unknown = await noticeByKey(unknownKey)
      await changeTelegram(owner, {
        action: "retry",
        id: unknown.id,
        acknowledgeDuplicate: true,
      })
      await until(
        async () =>
          (await noticeByKey(unknownKey))?.attempts === 2 &&
          (await noticeByKey(unknownKey))?.status === "unknown",
        "explicit duplicate-risk retry"
      )
      const rate = await queue("rate-send-fixture")
      await sentNotice(rate)
      assert.equal((await noticeByKey(rate)).attempts, 2)
      const rejected = await queue("rejected-send-fixture")
      await until(
        async () => (await noticeByKey(rejected))?.status === "failed",
        "explicit rejection"
      )
      assert(!(await noticeByKey(rejected)).last_error.includes(token))
      checks.push({
        check:
          "Outbound intent journal survives worker kill; delivered-but-disconnected and in-flight sends become unknown without blind resend; explicit consent retries; explicit 429 safely retried; token-echoing errors scrubbed",
      })

      const oldGeneration = (await state()).generation
      await changeTelegram(owner, { action: "unpair" })
      const revoked = callback(callbackData)
      await processed(revoked.update_id)
      assert.notEqual((await state()).generation, oldGeneration)
      assert.equal((await state()).user_id, null)
      const pair2 = await telegramStatus(owner)
      await pool.query(
        "UPDATE telegram_connection SET pair_expires_at=now()-interval '1 second' WHERE id=1"
      )
      await processed(message(`/pair ${pair2.pairCode}`).update_id)
      assert.equal((await state()).user_id, null)
      await changeTelegram(owner, { action: "rotate" })
      const pair3 = await telegramStatus(owner)
      await processed(message(`/pair ${pair3.pairCode}`).update_id)
      assert.equal((await state()).user_id, String(userId))
      await assert.rejects(
        changeTelegram(owner, {
          action: "retry",
          id: unknown.id,
          acknowledgeDuplicate: true,
        }),
        { status: 409 }
      )
      checks.push({
        check:
          "Unpair rotates transport generation; old callbacks/retry entries cannot act; expired pair code rejected and rotated one-time code succeeds",
      })

      // Authenticated HTTP/UI boundary, using only a dedicated dev server/database.
      web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17297",
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
      web.on("exit", () => {
        void writeFile(path.join(directory, "web.log"), webLog).catch((error) =>
          console.error(error)
        )
      })
      await until(async () => {
        if (web!.exitCode !== null) throw new Error(webLog)
        try {
          return (await fetch(`${process.env.APP_URL}/login`)).ok
        } catch (error) {
          if ((error as any).cause?.code === "ECONNREFUSED") return false
          throw error
        }
      }, "Telegram settings UI ready")
      assert.equal((await fetch(`${process.env.APP_URL}/api/telegram`)).status, 401)
      const { chromium } = await import("playwright")
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.UI_BROWSER_PATH,
      })
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
        })
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        await page.goto(`${process.env.APP_URL}/login`)
        await page.getByLabel("邮箱").fill(process.env.OWNER_EMAIL!)
        await page.getByLabel("密码").fill(process.env.OWNER_PASSWORD!)
        await page.getByRole("button", { name: "登录", exact: true }).click()
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).click()
        await page.getByLabel("Telegram 远程入口", { exact: true }).waitFor()
        await page.getByText("已配对 Fixture Owner", { exact: false }).waitFor()
        const response = await context.request.post(
          `${process.env.APP_URL}/api/telegram`,
          {
            headers: { Origin: "https://untrusted.fixture.test" },
            data: { action: "unpair" },
          }
        )
        assert.equal(response.status(), 403)
        assert.equal(
          (
            await context.request.post(`${process.env.APP_URL}/api/telegram`, {
              headers: { Origin: process.env.APP_URL! },
              data: { action: "retry", id: unknown.id, acknowledgeDuplicate: false },
            })
          ).status(),
          400
        )
        const settingResult = await context.request.patch(
          `${process.env.APP_URL}/api/settings`,
          {
            headers: { Origin: process.env.APP_URL! },
            data: [{ key: "telegram.botToken", value: token }],
          }
        )
        assert.equal(settingResult.status(), 400)
        const statusText = await (
          await context.request.get(`${process.env.APP_URL}/api/telegram`)
        ).text()
        assert(!statusText.includes(token))
        await page
          .getByRole("button", { name: "解除 Telegram 配对", exact: true })
          .click()
        await page.getByLabel("Telegram 配对口令", { exact: true }).waitFor()
        const codeText = await page
          .getByLabel("Telegram 配对口令", { exact: true })
          .innerText()
        await processed(message(codeText).update_id)
        await page.getByText("已配对 Fixture Owner", { exact: false }).waitFor()
        await page
          .getByLabel("Telegram 默认 Agent", { exact: true })
          .selectOption(agent.id)
        await until(
          async () => (await state()).agent_id === agent.id,
          "UI changes Telegram target"
        )
        assert.equal(await page.getByLabel("Telegram Bot Token").inputValue(), "")
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page
          .getByLabel("Telegram 远程入口", { exact: true })
          .screenshot({ path: path.join(directory, "telegram-mobile.png") })
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
      checks.push({
        check:
          "Actual owner mobile settings UI: status, unpair/re-pair and target selection; unauthenticated/foreign-Origin/internal-token mutation and unacknowledged retry rejected; token absent from status",
      })
    } else {
      const probe = await pool.connect()
      try {
        await probe.query("CREATE SCHEMA telegram_roster_probe")
        await probe.query("SET search_path=telegram_roster_probe")
        await probe.query("CREATE TABLE telegram_connection(id integer PRIMARY KEY)")
        await probe.query("INSERT INTO telegram_connection VALUES(1)")
        await probe.query(
          await readFile("db/migrations/0015_familiar_magneto.sql", "utf8")
        )
        await probe.query("INSERT INTO telegram_connection(id) VALUES(2)")
        assert.deepEqual(
          (await probe.query("SELECT delegate_agent_ids FROM telegram_connection")).rows,
          [{ delegate_agent_ids: [] }, { delegate_agent_ids: [] }]
        )
        await assert.rejects(
          probe.query("INSERT INTO telegram_connection VALUES(3,null)"),
          (error: any) => error.code === "23502"
        )
        await probe.query("RESET search_path")
        await probe.query("DROP SCHEMA telegram_roster_probe CASCADE")
      } finally {
        probe.release()
      }
      const crew = await db
        .insert(schema.agents)
        .values([
          { name: "手机入口", role: "Phone source", model: "custom/telegram-fixture" },
          {
            name: "原接手者",
            role: "Frozen recipient",
            model: "custom/telegram-fixture",
          },
          {
            name: "后续接手者",
            role: "Future recipient",
            model: "custom/telegram-fixture",
          },
        ])
        .returning()
      const [source, first, future] = crew
      modelAgentIds.push(...crew.map((agent) => agent.id))
      await setSetting("provider.custom.apiKey", "controlled-provider-key")
      await setSetting("provider.custom.baseUrl", `http://127.0.0.1:${modelPort}/v1`)
      await changeTelegram(owner, { action: "token", token })
      await changeTelegram(owner, { action: "agent", agentId: source.id })
      assert.deepEqual((await state()).delegate_agent_ids, [])
      await start()
      await processed(
        message(`/pair ${(await telegramStatus(owner)).pairCode}`).update_id
      )
      assert.equal((await state()).user_id, String(userId))
      async function roster(ids: string[]) {
        return changeTelegram(owner, {
          action: "roster",
          generation: (await state()).generation,
          agentId: source.id,
          delegateAgentIds: ids,
        })
      }
      await assert.rejects(roster(["missing-agent"]), { status: 400 })
      await assert.rejects(roster([fixtureAgent]), { status: 400 })
      await roster([first.id])
      checks.push({
        check:
          "Unmodified SQL0015 narrow schema probe sets [] on an existing row and omitted new value, rejects null; initial Telegram permissions disabled and missing/fixture targets rejected.",
      })

      // Freeze the inbox before submitTask can create a task, then change the setting after a real process death.
      const barrier = new pg.Client({ connectionString: url.toString() })
      await barrier.connect()
      await barrier.query("SELECT pg_advisory_lock(72131012)")
      await pool.query(`CREATE FUNCTION telegram_roster_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.source='telegram' THEN PERFORM pg_advisory_xact_lock(72131012); END IF; RETURN NEW; END $$;
        CREATE TRIGGER telegram_roster_barrier BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION telegram_roster_barrier()`)
      const marker = randomUUID()
      rosterCases.set(marker, { targetId: first.id, expected: [first.id] })
      const frozenGeneration = (await state()).generation
      const accepted = message(`CASE=tgroster RUN=${marker} Complete the phone task.`)
      let frozen: any
      try {
        frozen = await until(
          async () =>
            (
              await pool.query(
                "SELECT command FROM telegram_updates WHERE generation=$1 AND update_id=$2",
                [frozenGeneration, accepted.update_id]
              )
            ).rows[0],
          "Inbox roster durably frozen"
        )
        assert.deepEqual(frozen.command.input.delegateAgentIds, [first.id])
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%INSERT INTO tasks%'"
              )
            ).rowCount === 1,
          "Task admission blocked after inbox commit"
        )
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
          0
        )
        assert.equal(modelRequests.length, 0)
        await stop()
      } finally {
        await barrier.query("SELECT pg_advisory_unlock(72131012)")
        await barrier.end()
        await pool.query(
          "DROP TRIGGER telegram_roster_barrier ON tasks; DROP FUNCTION telegram_roster_barrier()"
        )
      }
      await roster([future.id])
      const generation = (await state()).generation
      await start()
      await processed(accepted.update_id)
      const task = (
        await pool.query(
          "SELECT * FROM tasks WHERE source='telegram' AND request_key=$1",
          [`${generation}:${accepted.update_id}`]
        )
      ).rows[0]
      await sentNotice(`task:${task.id}:completed`)
      const firstResult = (await pool.query("SELECT * FROM tasks WHERE id=$1", [task.id]))
        .rows[0]
      assert.equal(firstResult.agent_id, first.id)
      assert.deepEqual(firstResult.request_payload.delegateAgentIds, [first.id])
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
            [task.id]
          )
        ).rows[0].n,
        2
      )
      await processTelegramUpdate(generation, accepted)
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n,
        1
      )
      checks.push({
        check:
          "Actual SIGKILL after frozen inbox commit and before Task admission, with zero tasks/model calls at the barrier; changed owner roster does not alter replay. Original recipient executes a two-segment no-file handoff, exact update replay creates no duplicate.",
      })

      const originalThread = (await state()).thread_id
      const nextMarker = randomUUID()
      rosterCases.set(nextMarker, { targetId: future.id, expected: [future.id] })
      const follow = message(
        `CASE=tgroster RUN=${nextMarker} Continue in my original conversation.`
      )
      await processed(follow.update_id)
      const followTask = (await state()).task_id!
      await sentNotice(`task:${followTask}:completed`)
      const followed = (await pool.query("SELECT * FROM tasks WHERE id=$1", [followTask]))
        .rows[0]
      assert.equal(followed.agent_id, future.id)
      assert.equal(followed.request_payload.agentId, source.id)
      assert.deepEqual(followed.request_payload.delegateAgentIds, [future.id])
      assert.equal((await state()).thread_id, originalThread)
      assert.equal(followed.thread_turn, 2)
      await processed(message("/new").update_id)
      assert.deepEqual((await state()).delegate_agent_ids, [future.id])
      await processed(message(`/use ${source.id}`).update_id)
      assert.deepEqual((await state()).delegate_agent_ids, [])
      const emptyMarker = randomUUID()
      rosterCases.set(emptyMarker, { targetId: first.id, expected: [] })
      await processed(
        message(`CASE=tgroster RUN=${emptyMarker} Try a disabled delegation.`).update_id
      )
      const deniedTask = (await state()).task_id!
      await sentNotice(`task:${deniedTask}:completed`)
      const denied = (await pool.query("SELECT * FROM tasks WHERE id=$1", [deniedTask]))
        .rows[0]
      assert.equal(denied.agent_id, source.id)
      assert.equal(denied.request_payload.delegateAgentIds, undefined)
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM task_segments WHERE task_id=$1",
            [deniedTask]
          )
        ).rows[0].n,
        1
      )
      checks.push({
        check:
          "Next phone turn retains the original source conversation but freezes the new roster and hands off to its new recipient. /new retains source permissions; /use clears them, and an actual subsequent delegate is denied without creating a new segment.",
      })

      web = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "17297",
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
      await until(async () => {
        if (web!.exitCode !== null) throw new Error(webLog)
        try {
          return (await fetch(`${process.env.APP_URL}/login`)).ok
        } catch (error) {
          if ((error as any).cause?.code === "ECONNREFUSED") return false
          throw error
        }
      }, "Telegram roster settings ready")
      assert.equal((await fetch(`${process.env.APP_URL}/api/telegram`)).status, 401)
      const { chromium } = await import("playwright")
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.UI_BROWSER_PATH,
      })
      try {
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
        await page.getByRole("link", { name: "模型与 Agent 设置", exact: true }).click()
        const form = page.getByRole("form", { name: "Telegram 交接权限", exact: true })
        await form.waitFor()
        assert.equal(await form.locator("input:checked").count(), 0)
        const binding = {
          action: "roster",
          generation,
          agentId: source.id,
          delegateAgentIds: [first.id],
        }
        const post = (input: unknown, origin = process.env.APP_URL!) =>
          context.request.post(`${process.env.APP_URL}/api/telegram`, {
            headers: { Origin: origin },
            data: input,
          })
        assert.equal(
          (await post(binding, "https://untrusted.fixture.test")).status(),
          403
        )
        for (const ids of [
          ["missing-agent"],
          [fixtureAgent],
          [""],
          Array(33).fill(first.id),
        ])
          assert.equal((await post({ ...binding, delegateAgentIds: ids })).status(), 400)
        await form.getByLabel(first.name, { exact: true }).check()
        await page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/telegram") &&
            response.request().method() === "GET"
        )
        assert.equal(
          await form.getByLabel(first.name, { exact: true }).isChecked(),
          true,
          "Polling preserves an unsaved roster draft in the same pairing/agent context"
        )
        await form.getByRole("button", { name: "保存手机交接权限", exact: true }).click()
        await until(
          async () => (await state()).delegate_agent_ids.join() === first.id,
          "Owner roster form saved"
        )
        await page
          .getByLabel("Telegram 默认 Agent", { exact: true })
          .selectOption(future.id)
        await until(
          async () => (await state()).agent_id === future.id,
          "UI target selection resets delegation"
        )
        assert.deepEqual((await state()).delegate_agent_ids, [])
        assert.equal(
          (await post(binding)).status(),
          409,
          "Old source binding cannot grant a new source"
        )
        await page
          .getByLabel("Telegram 默认 Agent", { exact: true })
          .selectOption(source.id)
        await until(
          async () => (await state()).agent_id === source.id,
          "UI returns to original source"
        )
        await form.getByLabel(first.name, { exact: true }).check()
        await form.getByRole("button", { name: "保存手机交接权限", exact: true }).click()
        await form.getByText(`已保存：${first.name}`, { exact: true }).waitFor()
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page
          .getByLabel("Telegram 远程入口", { exact: true })
          .screenshot({ path: path.join(directory, "telegram-roster-mobile.png") })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page
          .getByLabel("Telegram 远程入口", { exact: true })
          .screenshot({ path: path.join(directory, "telegram-roster-desktop.png") })
        assert.deepEqual(pageErrors, [])
        await page
          .getByRole("button", { name: "解除 Telegram 配对", exact: true })
          .click()
        await page.getByLabel("Telegram 配对口令", { exact: true }).waitFor()
        assert.deepEqual((await state()).delegate_agent_ids, [])
        assert.equal(
          (await post(binding)).status(),
          409,
          "Old pairing binding cannot restore permission"
        )
      } finally {
        await browser.close()
        if (web.pid && web.exitCode === null) {
          const exited = once(web, "exit")
          process.kill(-web.pid, "SIGTERM")
          await exited
        }
        await writeFile(path.join(directory, "web.log"), webLog)
      }
      await roster([first.id])
      await changeTelegram(owner, { action: "rotate" })
      assert.deepEqual((await state()).delegate_agent_ids, [])
      await roster([first.id])
      await changeTelegram(owner, { action: "token", token })
      assert.deepEqual((await state()).delegate_agent_ids, [])
      await roster([first.id])
      await stop()
      const previousGeneration = (await state()).generation
      await pool.query("UPDATE telegram_connection SET bot_id=$1 WHERE id=1", [
        String(botId + 1),
      ])
      await start()
      await until(
        async () => (await state()).generation !== previousGeneration,
        "Worker bot-identity change revokes generation"
      )
      assert.deepEqual((await state()).delegate_agent_ids, [])
      checks.push({
        check:
          "Actual owner mobile/desktop roster form preserves drafts across status polls, saves explicit permission and clears on source selection/unpair; stale source or generation, anonymous/cross-Origin/invalid or oversized rosters denied. Rotate/token/bot-identity generation change also clears permission; no extra tasks.",
      })
    }
    taskCounts = (
      await pool.query(
        "SELECT status,count(*)::int AS count FROM tasks GROUP BY status ORDER BY status"
      )
    ).rows
    assert.deepEqual(
      taskCounts,
      focus === "handoff"
        ? [{ status: "completed", count: 3 }]
        : [
            { status: "cancelled", count: 1 },
            { status: "completed", count: 4 },
          ]
    )
    if (focus === "core") assert.equal(checks.length, 8)
    await stop("SIGTERM")
    assert(!logs.join("\n").includes(token))
    assert.deepEqual(errors, [])
    passed = true
  } finally {
    if (worker) await stop()
    if (web?.pid && web.exitCode === null) {
      const exited = once(web, "exit")
      process.kill(-web.pid, "SIGTERM")
      await exited
    }
    for (const modelAgentId of modelAgentIds) {
      for (const name of [viewerName(modelAgentId), workstationName(modelAgentId)]) {
        const result = await dockerRaw(["rm", "--force", name])
        if (result.exitCode !== 0 && !/no such (container|object)/i.test(result.stderr))
          console.error(result.stderr)
      }
      for (const volume of [
        workstationVolume(modelAgentId),
        displayVolume(modelAgentId),
      ]) {
        const result = await dockerRaw(["volume", "rm", volume])
        if (result.exitCode !== 0 && !/no such volume/i.test(result.stderr))
          console.error(result.stderr)
      }
    }
    await closeDurableClient()
    await pool.end()
  }
} finally {
  pendingSend?.destroy()
  for (const server of [botServer, modelServer]) {
    server.closeAllConnections()
    server.close()
    await once(server, "close")
  }
  const result = {
    passed,
    applicationVersion: (await import("@/lib/durable")).APPLICATION_VERSION,
    migration: JSON.parse(await readFile("db/migrations/meta/_journal.json", "utf8"))
      .entries.at(-1)
      .tag.split("_")[0],
    guestProtocolVersion: 5,
    focus,
    taskCounts,
    actualTasks: taskCounts.reduce((sum, row) => sum + row.count, 0),
    controlledTelegram: true,
    controlledProvider: true,
    realTelegramConnectivityEvaluated: false,
    realModelJudgmentEvaluated: false,
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
      `docs/evidence/telegram${focus === "handoff" ? "-handoff" : ""}.json`,
      JSON.stringify(result, null, 2) + "\n"
    )
    await until(
      async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",
            [database]
          )
        ).rows[0].n === 0,
      "Test database connections closed",
      5000
    )
    await admin.query(`DROP DATABASE "${database}"`)
  }
  await admin.end()
  console.log(JSON.stringify(result, null, 2))
}
