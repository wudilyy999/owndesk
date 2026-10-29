import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { z } from "zod"
import { pool } from "@/db"
import { env } from "@/lib/env"
import { plainText } from "@/lib/telegram/format"
import { callTelegram, TelegramError, type InlineKeyboard } from "./api"
import { lockTelegram, type Connection } from "./state"
import { comparisonSummary, type ComparisonResult } from "@/lib/report-comparison"

export type RequestContext = {
  taskId: string
  requestId: string
  payloadVersion: number
  kind: string
  purpose?: string
}
export async function queueTelegram(
  client: PoolClient,
  state: Connection,
  key: string,
  text: string,
  options: {
    context?: RequestContext
    decisions?: [string, string][]
    callbackId?: string
  } = {}
) {
  const id = randomUUID()
  const keyboard: InlineKeyboard =
    options.decisions?.map(([label, decision]) => [
      { text: label, callback_data: `r:${id}:${decision}` },
    ]) ?? []
  const payload = options.callbackId
    ? { callback_query_id: options.callbackId, text: text.slice(0, 180) }
    : {
        chat_id: state.chat_id,
        text: plainText(text).slice(0, 3900),
        link_preview_options: { is_disabled: true },
        ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }
  await client.query(
    `INSERT INTO telegram_outbox(id,generation,key,chat_id,method,payload,context,created_at,next_attempt_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()) ON CONFLICT(generation,key) DO NOTHING`,
    [
      id,
      state.generation,
      key,
      state.chat_id,
      options.callbackId ? "answerCallbackQuery" : "sendMessage",
      JSON.stringify(payload),
      options.context ? JSON.stringify(options.context) : null,
    ]
  )
}
export function taskLink(taskId: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/?task=${encodeURIComponent(taskId)}`
}

export async function collectTelegramNotifications(generation: string) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const state = await lockTelegram(client, generation)
    if (state?.user_id) {
      const requests = await client.query(
        `SELECT r.*,t.goal FROM task_requests r JOIN tasks t ON t.id=r.task_id
        LEFT JOIN workstation_control w ON w.request_id=r.id
        WHERE t.owner_id=$1 AND r.created_at >= $2 AND r.status='pending' AND t.cancel_requested_at IS NULL
        AND t.status NOT IN ('completed','failed','cancelled') AND (r.kind<>'takeover' OR w.mode='human')
        AND NOT EXISTS(SELECT 1 FROM telegram_outbox o WHERE o.generation=$3 AND o.key='request:'||r.id||':'||r.payload_version)
        ORDER BY r.created_at,r.id LIMIT 20`,
        [state.owner_id, state.paired_at, generation]
      )
      for (const request of requests.rows) {
        const purpose = String(request.payload.purpose ?? "")
        const context = {
          taskId: request.task_id,
          requestId: request.id,
          payloadVersion: request.payload_version,
          kind: request.kind,
          purpose,
        }
        let decisions: [string, string][] = []
        const question = request.kind === "approval" && purpose === "question"
        if (["vault_secret", "vault_fill", "payment", "payment_submit"].includes(purpose))
          decisions = [
            ["拒绝", "decline"],
            ["取消任务", "cancel"],
          ]
        else if (request.kind === "takeover")
          decisions = [["我已操作完，交还", "handback"]]
        else if (request.kind === "approval" && !question)
          decisions = [
            ["同意", "approve"],
            ["拒绝", "decline"],
            ["取消任务", "cancel"],
          ]
        else if (request.kind === "budget")
          decisions = ["limits", "monthly"].includes(purpose)
            ? [["取消任务", "cancel"]]
            : [
                ["允许再次请求（可能计费）", "continue"],
                ["取消任务", "cancel"],
              ]
        else if (request.kind === "review")
          decisions =
            ["execution_error", "control_recovery"].includes(purpose) ||
            ["vault_fill", "payment_submit"].includes(String(request.payload.tool))
              ? [
                  ["继续", "continue"],
                  ["取消任务", "cancel"],
                ]
              : [
                  ["继续修正", "continue"],
                  ["确认完成", "complete"],
                  ["取消任务", "cancel"],
                ]
        const detail =
          purpose === "payment_submit"
            ? `付款提交（可能扣款）：${request.payload.merchant} / ${request.payload.amount}；站点 ${request.payload.origin}。请在认证网页核对具体按钮并批准；结果未知请核对账单，不重复提交。`
            : purpose === "payment"
              ? `支付资料选择（不授权提交）：${request.payload.merchant} / ${request.payload.amount}；站点 ${request.payload.origin}。请在网页核对实际原文、选择方式或接管。`
              : (request.payload.question ??
                request.payload.reason ??
                request.payload.message ??
                request.payload.summary ??
                JSON.stringify(request.payload))
        await queueTelegram(
          client,
          state,
          `request:${request.id}:${request.payload_version}`,
          `需要你处理：${request.payload.comparison ? `${comparisonSummary(request.payload.comparison as ComparisonResult)}\n\n模型摘要（未独立核实）：` : ""}${String(detail).slice(0, 2000)}\n\n${purpose === "vault_fill" ? `请打开网页核对 ${request.payload.origin} 的条目和字段后授权本次填写，不要在 Telegram 回复秘密。\n` : purpose === "vault_secret" ? `请打开认证网页安全提供凭据，目标站点：${request.payload.origin}。不要在 Telegram 回复密码或验证码。\n` : question ? "直接回复这条通知，填写你的答案。\n" : request.kind === "takeover" ? "打开网页接管桌面；也可回复这条通知附交还说明。\n" : request.kind === "budget" && ["limits", "monthly"].includes(purpose) ? "在网页调整额度或核对费用，再重新检查。\n" : ""}${taskLink(request.task_id)}`,
          { context, decisions }
        )
      }
      const tasks = await client.query(
        `SELECT t.* FROM tasks t WHERE owner_id=$1 AND created_at >= $2
        AND status IN ('completed','failed','cancelled') AND NOT cancel_workflow_pending
        AND (status<>'completed' OR result->'notification'->>'send' IS DISTINCT FROM 'false')
        AND NOT EXISTS(SELECT 1 FROM telegram_outbox o WHERE o.generation=$3 AND o.key='task:'||t.id||':'||t.status)
        ORDER BY updated_at,id LIMIT 20`,
        [state.owner_id, state.paired_at, generation]
      )
      for (const task of tasks.rows) {
        const result = task.result ?? {}
        await queueTelegram(
          client,
          state,
          `task:${task.id}:${task.status}`,
          `任务${task.status === "completed" ? "完成" : task.status === "cancelled" ? "已取消" : "失败"}：${task.goal.slice(0, 300)}\n\n${result.comparison ? `${comparisonSummary(result.comparison as ComparisonResult)}\n\n模型摘要（未独立核实）：` : ""}${String(result.summary ?? task.error ?? "打开网页查看状态和成果。").slice(0, 2200)}\n\n${taskLink(task.id)}`
        )
      }
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function recoverTelegramSends() {
  await pool.query(
    "UPDATE telegram_outbox SET status='unknown',uncertain_attempts=uncertain_attempts+1,last_error='Worker stopped during send; delivery is unknown' WHERE status='sending'"
  )
}
export async function deliverTelegramOutbox(
  token: string,
  generation: string,
  signal: AbortSignal
) {
  // One leased worker dispatches; committed sending intent survives a process exit.
  const result = await pool.query(
    `UPDATE telegram_outbox SET status='sending',attempts=attempts+1 WHERE id=(
    SELECT o.id FROM telegram_outbox o JOIN telegram_connection c ON c.generation=o.generation AND c.chat_id=o.chat_id
    WHERE o.generation=$1 AND o.status='pending' AND o.next_attempt_at<=now() AND c.user_id IS NOT NULL ORDER BY o.created_at,o.id LIMIT 1)
    RETURNING *`,
    [generation]
  )
  const notice = result.rows[0]
  if (!notice) return false
  try {
    const result = await callTelegram<unknown>(token, notice.method, notice.payload, {
      signal,
    })
    const message =
      notice.method === "sendMessage"
        ? z
            .object({
              message_id: z.number().int().positive(),
              chat: z.object({ id: z.number().int().safe() }),
            })
            .safeParse(result)
        : null
    if (
      notice.method === "sendMessage"
        ? !message?.success || String(message.data.chat.id) !== notice.chat_id
        : result !== true
    )
      throw new TelegramError(
        "Telegram returned an invalid send receipt; delivery is unknown",
        true
      )
    await pool.query(
      "UPDATE telegram_outbox SET status='sent',message_id=$2,last_error=NULL WHERE id=$1",
      [notice.id, message?.success ? message.data.message_id : null]
    )
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error
    if (!error.uncertain && error.code === 429) {
      await pool.query(
        "UPDATE telegram_outbox SET status='pending',next_attempt_at=now()+($2*interval '1 second'),last_error=$3 WHERE id=$1",
        [notice.id, error.retryAfter ?? 30, error.message]
      )
    } else {
      await pool.query(
        "UPDATE telegram_outbox SET status=$2,uncertain_attempts=uncertain_attempts+$3,last_error=$4 WHERE id=$1",
        [
          notice.id,
          error.uncertain ? "unknown" : "failed",
          error.uncertain ? 1 : 0,
          error.message,
        ]
      )
    }
  }
  return true
}
