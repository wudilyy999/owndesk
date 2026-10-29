// Payment choice intent adapted from the pinned MIT upstream lib/vault-requests.ts (MIT).
import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { assertCredentialScope } from "@/lib/vault"
import { requestTakeover, respondToRequest } from "@/lib/task-control"
import { paymentApprovalSchema, paymentChoiceSchema } from "@/lib/payment-schema"
import type { z } from "zod"

export async function choosePayment(
  ownerId: string,
  requestId: string,
  input: z.infer<typeof paymentChoiceSchema>
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [candidate],
    } = await client.query<{ task_id: string }>(
      "SELECT r.task_id FROM task_requests r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND t.owner_id=$2",
      [requestId, ownerId]
    )
    if (!candidate) throw new HttpError(404, "支付请求不存在。")
    const {
      rows: [task],
    } = await client.query<{ status: string; cancel_requested_at: Date | null }>(
      "SELECT status,cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [candidate.task_id]
    )
    const {
      rows: [request],
    } = await client.query<{
      kind: string
      payload: unknown
      payload_version: number
      status: string
      decision: string | null
      response: Record<string, unknown> | null
    }>(
      "SELECT kind,payload,payload_version,status,decision,response FROM task_requests WHERE id=$1 FOR UPDATE",
      [requestId]
    )
    const parsed = paymentApprovalSchema.safeParse(request.payload)
    if (request.kind !== "approval" || !parsed.success)
      throw new HttpError(400, "该请求不接受支付选择。")
    if (request.payload_version !== input.payloadVersion)
      throw new HttpError(409, "支付请求版本已变化。")
    const approval = parsed.data
    const method =
      input.action === "select"
        ? approval.methods.find(
            (item) => item.id === input.itemId && item.revision === input.revision
          )
        : undefined
    if (input.action === "select" && !method)
      throw new HttpError(409, "请选择本次请求列出的条目版本。")
    const response: Record<string, unknown> = method
      ? { itemId: method.id, revision: method.revision, kind: method.kind }
      : { takeoverRequestId: `${requestId}-takeover` }
    if (request.decision) {
      if (
        request.decision !== "approve" ||
        !isDeepStrictEqual(request.response, response)
      )
        throw new HttpError(409, "支付请求已有不同的决定。")
      await client.query("COMMIT")
      return { status: request.status, ...response }
    }
    if (
      request.status !== "pending" ||
      task.cancel_requested_at ||
      ["completed", "failed", "cancelled"].includes(task.status)
    )
      throw new HttpError(409, "支付请求已失效。")
    await assertCredentialScope(client, candidate.task_id, approval)
    if (method) {
      const item = await client.query(
        `SELECT id FROM vault_items WHERE id=$1 AND revision=$2 AND kind=$3 AND origin=$4
        AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (scope_task_id IS NULL OR scope_task_id=$5) FOR UPDATE`,
        [method.id, method.revision, method.kind, approval.origin, candidate.task_id]
      )
      if (!item.rowCount)
        throw new HttpError(409, "支付条目已变化、过期或不适用于当前任务。")
    } else {
      const takeover = await requestTakeover(
        candidate.task_id,
        `人工处理 ${approval.merchant} / ${approval.amount}；付款结果需另行核对。`,
        String(response.takeoverRequestId),
        ownerId,
        approval.actionNo,
        client
      )
      if (takeover.requestId !== response.takeoverRequestId)
        throw new HttpError(409, "已有其他接管请求，请先处理当前接管。")
    }
    const result = await respondToRequest(
      ownerId,
      requestId,
      "approve",
      input.payloadVersion,
      response,
      "owner",
      { client, purpose: "payment" }
    )
    await client.query("COMMIT")
    return { ...result, ...response }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
