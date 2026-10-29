// Adapted from the pinned MIT upstream lib/telegram/bridge.ts (pinned v0.6.0, MIT, Sourav Bera).
// Retains private pairing, /agents /new /stop /status and plain-fetch long polling.
// Runtime maps and startTurn are replaced by durable source keys, inbox/outbox and task APIs.
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { PoolClient } from "pg"
import { pool } from "@/db"
import { getSetting } from "@/lib/config"
import { decryptSecret, encryptSecret } from "@/lib/secrets"
import { HttpError } from "@/lib/errors"
import { submitTask } from "@/lib/tasks"
import { requestCancellation, respondToRequest } from "@/lib/task-control"
import type { TaskInput } from "@/db/schema"
import {
  callTelegram,
  telegramUpdatesSchema,
  telegramUserSchema,
  TelegramError,
  type TgUpdate,
} from "./api"
import {
  ensureTelegramConnection,
  lockTelegram,
  createPairCode,
  type Connection,
} from "./state"
import {
  collectTelegramNotifications,
  deliverTelegramOutbox,
  queueTelegram,
  recoverTelegramSends,
  taskLink,
  type RequestContext,
} from "./notifications"

type Command =
  | { type: "ignore" }
  | { type: "pair"; name: string; chatId: string }
  | { type: "notice"; text: string }
  | { type: "target"; agentId: string }
  | { type: "new" }
  | { type: "cancel"; taskId: string }
  | { type: "task"; input: TaskInput }
  | {
      type: "respond"
      context: RequestContext
      decision: string
      response: Record<string, unknown>
      callbackId?: string
    }

const HELP =
  "直接发送任务。/agents 查看 Agent；/use ID 切换；/new 新对话；/stop 停止当前任务；/status 查看状态。需要回答时直接回复对应通知。桌面登录和追加预算请打开网页。不要通过消息发送密码或验证码。"

async function makeCommand(
  client: PoolClient,
  state: Connection,
  update: TgUpdate
): Promise<Command> {
  const query = update.callback_query
  const message = query?.message ?? update.message
  const sender = query?.from ?? message?.from
  if (
    !message ||
    !sender ||
    sender.is_bot ||
    message.chat.type !== "private" ||
    String(message.chat.id) !== String(sender.id)
  )
    return { type: "ignore" }
  const text = (message.text ?? "").trim()
  if (String(sender.id) !== state.user_id || String(message.chat.id) !== state.chat_id) {
    const code = /^\/(?:start|pair)(?:@\w+)?\s+([A-Za-z0-9]+)$/.exec(text)
    if (
      !query &&
      !state.user_id &&
      code &&
      state.pair_code &&
      state.pair_expires_at! > new Date() &&
      code[1].toUpperCase() === decryptSecret(state.pair_code)
    )
      return {
        type: "pair",
        chatId: String(message.chat.id),
        name: sender.username ? `@${sender.username}` : sender.first_name,
      }
    return { type: "ignore" }
  }
  if (!query && message.date < Math.floor(state.paired_at!.getTime() / 1000))
    return { type: "ignore" }
  const callback = query?.data
    ? /^r:([a-f0-9-]{36}):(approve|decline|continue|complete|cancel|handback)$/.exec(
        query.data
      )
    : null
  const explicitReply = /^\/reply\s+([a-f0-9-]{36})\s+([\s\S]+)$/.exec(text)
  if (query || explicitReply || (message.reply_to_message && !text.startsWith("/"))) {
    if (query && (!callback || String(message.from?.id) !== state.bot_id))
      return { type: "notice", text: "这个按钮已经失效，请打开当前任务。" }
    const notices = await client.query(
      `SELECT * FROM telegram_outbox WHERE generation=$1 AND chat_id=$2 AND context IS NOT NULL
      AND ${callback || explicitReply ? "id=$3" : "message_id=$3"} AND status IN ('sent','unknown')`,
      [
        state.generation,
        state.chat_id,
        callback?.[1] ?? explicitReply?.[1] ?? message.reply_to_message!.message_id,
      ]
    )
    const notice = notices.rows[0]
    if (
      !notice ||
      (query && notice.message_id !== null && notice.message_id !== message.message_id) ||
      (!query &&
        message.reply_to_message &&
        String(message.reply_to_message.from?.id) !== state.bot_id)
    )
      return { type: "notice", text: "未找到当前配对的请求通知，请打开网页处理。" }
    if (
      callback &&
      !notice.payload.reply_markup?.inline_keyboard
        .flat()
        .some((button: { callback_data: string }) => button.callback_data === query!.data)
    )
      return { type: "notice", text: "这个按钮不属于当前请求。" }
    const context = notice.context as RequestContext
    if (
      !query &&
      (context.kind === "budget" ||
        (context.kind !== "takeover" && context.purpose !== "question"))
    )
      return {
        type: "notice",
        text: `请使用该通知上的按钮或网页处理：${taskLink(context.taskId)}`,
      }
    const answer = explicitReply?.[2] ?? text
    if (!query && !answer) return { type: "notice", text: "请用文字回复通知。" }
    return {
      type: "respond",
      context,
      decision: callback?.[2] ?? (context.kind === "takeover" ? "handback" : "approve"),
      response: query
        ? {}
        : context.kind === "takeover"
          ? { note: answer }
          : { answer, note: answer },
      ...(query ? { callbackId: query.id } : {}),
    }
  }
  const command = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text)
  if (command) {
    const [, name, rest] = command
    if (["start", "help"].includes(name)) return { type: "notice", text: HELP }
    if (name === "agents") {
      const agents = await client.query(
        "SELECT id,name,role FROM agents ORDER BY created_at,id LIMIT 30"
      )
      return {
        type: "notice",
        text:
          agents.rows
            .map((agent) => `${agent.name}：${agent.role}\n/use ${agent.id}`)
            .join("\n\n") || "请先在网页创建 Agent。",
      }
    }
    if (name === "use") {
      const agent = await client.query("SELECT id FROM agents WHERE id=$1", [rest.trim()])
      return agent.rowCount
        ? { type: "target", agentId: rest.trim() }
        : { type: "notice", text: "Agent 不存在，请用 /agents 查看。" }
    }
    if (name === "new") return { type: "new" }
    if (name === "stop")
      return state.task_id
        ? { type: "cancel", taskId: state.task_id }
        : { type: "notice", text: "当前没有选中的任务。" }
    if (name === "status") {
      const task = state.task_id
        ? (
            await client.query(
              "SELECT status,goal FROM tasks WHERE id=$1 AND owner_id=$2",
              [state.task_id, state.owner_id]
            )
          ).rows[0]
        : null
      return {
        type: "notice",
        text: `Agent：${state.agent_id ?? "尚未选择"}\n${task ? `任务：${task.status}\n${task.goal.slice(0, 500)}\n${taskLink(state.task_id!)}` : "当前没有任务。"}`,
      }
    }
    return { type: "notice", text: HELP }
  }
  if (!text) return { type: "notice", text: "当前支持文字任务；语音和附件请在网页处理。" }
  if (!state.agent_id)
    return {
      type: "notice",
      text: "请先使用 /agents 和 /use ID 选择 Agent，或在网页 Telegram 设置中选择。",
    }
  return {
    type: "task",
    input: {
      agentId: state.agent_id,
      ...(state.delegate_agent_ids.length
        ? { delegateAgentIds: state.delegate_agent_ids }
        : {}),
      ...(state.thread_id ? { threadId: state.thread_id } : {}),
      goal: text,
      clientRequestId: `${state.generation}:${update.update_id}`,
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 40 },
    },
  }
}

export async function processTelegramUpdate(generation: string, update: TgUpdate) {
  const sender = update.callback_query?.from ?? update.message?.from
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const state = await lockTelegram(client, generation)
    if (!state) {
      await client.query("COMMIT")
      return false
    }
    const exists = await client.query(
      "SELECT 1 FROM telegram_updates WHERE generation=$1 AND update_id=$2",
      [generation, update.update_id]
    )
    if (!exists.rowCount)
      await client.query(
        `INSERT INTO telegram_updates(generation,update_id,sender_id,command,created_at) VALUES($1,$2,$3,$4,now())`,
        [
          generation,
          update.update_id,
          sender ? String(sender.id) : null,
          JSON.stringify(await makeCommand(client, state, update)),
        ]
      )
    // Freeze the task's selected Agent/thread before calling its separately committed submit transaction.
    await client.query("COMMIT")
    await client.query("BEGIN")
    const current = await lockTelegram(client, generation)
    if (!current) {
      await client.query("COMMIT")
      return false
    }
    const {
      rows: [inbox],
    } = await client.query(
      "SELECT * FROM telegram_updates WHERE generation=$1 AND update_id=$2 FOR UPDATE",
      [generation, update.update_id]
    )
    if (!inbox.processed_at) {
      const command = inbox.command as Command
      const authorized =
        command.type === "pair"
          ? !current.user_id &&
            !!current.pair_code &&
            current.pair_expires_at! > new Date()
          : current.user_id === inbox.sender_id
      let text = ""
      if (command.type === "pair" && authorized) {
        await client.query(
          "UPDATE telegram_connection SET user_id=$1,chat_id=$2,owner_name=$3,paired_at=clock_timestamp(),pair_code=NULL,pair_expires_at=NULL WHERE id=1",
          [inbox.sender_id, command.chatId, command.name]
        )
        current.chat_id = command.chatId
        text = `配对成功。只有此 Telegram 账号可以交办任务。\n\n${HELP}`
      } else if (authorized && command.type !== "ignore" && command.type !== "pair") {
        try {
          if (command.type === "task") {
            const task = await submitTask(current.owner_id, "telegram", command.input)
            await client.query(
              "UPDATE telegram_connection SET task_id=$1,thread_id=$2 WHERE id=1",
              [task.taskId, task.threadId]
            )
            text = `任务已受理。${task.reused ? "已复用原任务。" : ""}\n${taskLink(task.taskId)}`
          } else if (command.type === "respond") {
            await respondToRequest(
              current.owner_id,
              command.context.requestId,
              command.decision,
              command.context.payloadVersion,
              command.response
            )
            text = "已记录你的决定。打开网页查看任务后续状态。"
          } else if (command.type === "cancel") {
            const result = await requestCancellation(current.owner_id, command.taskId)
            text =
              result.status === "stopping"
                ? "已请求停止，正在核对实际操作是否结束。"
                : `任务状态：${result.status}`
          } else if (command.type === "target") {
            await client.query(
              "UPDATE telegram_connection SET agent_id=$1,delegate_agent_ids='[]'::jsonb,thread_id=NULL,task_id=NULL WHERE id=1",
              [command.agentId]
            )
            text =
              "Agent 已切换，下一条消息创建新对话；交接权限已清空，请在网页重新选择。"
          } else if (command.type === "new") {
            await client.query(
              "UPDATE telegram_connection SET thread_id=NULL,task_id=NULL WHERE id=1"
            )
            text = "已开始新对话；已运行任务保持原状态。"
          } else text = command.text
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          text = `无法处理：${error.message}`
        }
      }
      if (text) {
        await queueTelegram(client, current, `update:${update.update_id}`, text)
        if (command.type === "respond" && command.callbackId)
          await queueTelegram(client, current, `callback:${update.update_id}`, text, {
            callbackId: command.callbackId,
          })
      }
      await client.query(
        "UPDATE telegram_updates SET processed_at=now() WHERE generation=$1 AND update_id=$2",
        [generation, update.update_id]
      )
    }
    await client.query(
      "UPDATE telegram_connection SET cursor=GREATEST(cursor,$1) WHERE id=1",
      [update.update_id]
    )
    await client.query("COMMIT")
    return true
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function runTelegram(signal: AbortSignal) {
  await recoverTelegramSends()
  let validatedToken: string | undefined
  while (!signal.aborted) {
    let state = await ensureTelegramConnection()
    const token = await getSetting("telegram.botToken")
    if (!token) {
      await delay(1000, undefined, { signal })
      continue
    }
    if (!state) {
      await delay(1000, undefined, { signal })
      continue
    }
    try {
      if (validatedToken !== token || !state.bot_id) {
        const me = telegramUserSchema.safeParse(
          await callTelegram(token, "getMe", {}, { signal })
        )
        if (!me.success || !me.data.is_bot)
          throw new TelegramError("Telegram getMe: invalid bot identity", true)
        const webhook = await callTelegram<{ url: string }>(
          token,
          "getWebhookInfo",
          {},
          { signal }
        )
        if (typeof webhook.url !== "string" || webhook.url)
          throw new TelegramError(
            "This bot has a webhook. Remove it before enabling this deployment's polling.",
            false,
            409
          )
        if (state.bot_id && state.bot_id !== String(me.data.id)) {
          await pool.query(
            `UPDATE telegram_connection SET generation=$1,cursor=0,user_id=NULL,chat_id=NULL,owner_name=NULL,paired_at=NULL,
            thread_id=NULL,task_id=NULL,delegate_agent_ids='[]'::jsonb,pair_code=$2,pair_expires_at=now()+interval '10 minutes',bot_id=NULL WHERE generation=$3`,
            [randomUUID(), encryptSecret(createPairCode()), state.generation]
          )
          continue
        }
        const saved = await pool.query(
          "UPDATE telegram_connection SET bot_id=$1,bot_username=$2 WHERE generation=$3 RETURNING id",
          [String(me.data.id), me.data.username ?? null, state.generation]
        )
        if (!saved.rowCount) continue
        validatedToken = token
      }
      await collectTelegramNotifications(state.generation)
      for (let sent = 0; sent < 20 && !signal.aborted; sent++)
        if (!(await deliverTelegramOutbox(token, state.generation, signal))) break
      const updates = telegramUpdatesSchema.safeParse(
        await callTelegram(
          token,
          "getUpdates",
          {
            offset: state.cursor + 1,
            timeout: 20,
            allowed_updates: ["message", "callback_query"],
          },
          { signal, timeoutMs: 35000 }
        )
      )
      if (!updates.success)
        throw new TelegramError(
          "Telegram getUpdates: invalid update envelope; cursor unchanged",
          true
        )
      for (const update of updates.data.sort((a, b) => a.update_id - b.update_id))
        if (!(await processTelegramUpdate(state.generation, update))) break
      await pool.query(
        "UPDATE telegram_connection SET last_poll_at=now(),last_error=NULL WHERE generation=$1",
        [state.generation]
      )
    } catch (error) {
      if (signal.aborted) return
      if (!(error instanceof TelegramError)) throw error
      await pool.query(
        "UPDATE telegram_connection SET last_error=$1 WHERE generation=$2",
        [error.message, state.generation]
      )
      await delay((error.retryAfter ?? 5) * 1000, undefined, { signal })
    }
  }
}
