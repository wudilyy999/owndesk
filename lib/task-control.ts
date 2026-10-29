import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { budgetChangesSchema } from "@/db/schema"
import { pool } from "@/db"
import { durableClient } from "@/lib/durable"
import { HttpError } from "@/lib/errors"
import { appendEventInTransaction } from "@/lib/task-events"
import type { PoolClient } from "pg"
import { vaultGrantSchema } from "@/lib/vault-schema"
import { assertVaultGrant } from "@/lib/vault"
import { assertPaymentSubmission } from "@/lib/payment-submission"
import { paymentSubmitGrantSchema } from "@/lib/payment-schema"

const terminal = new Set(["completed", "failed", "cancelled"])

export async function requestCancellation(ownerId: string, taskId: string) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{
      status: string
      agent_id: string
      cancel_requested_at: Date | null
    }>(
      "SELECT status,agent_id,cancel_requested_at FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [taskId, ownerId]
    )
    if (!task) throw new HttpError(404, "Task not found")
    if (terminal.has(task.status)) {
      await client.query("COMMIT")
      return { status: task.status }
    }
    await client.query(
      "UPDATE tasks SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id=$1",
      [taskId]
    )
    await appendEventInTransaction(
      client,
      taskId,
      "cancel-requested",
      "cancel_requested",
      { message: "Cancellation requested; stopping actual operations" }
    )
    const active = await client.query(
      "UPDATE workstation_control SET desired_mode='cancelled',updated_at=now() WHERE agent_id=$1 AND active_task_id=$2 RETURNING agent_id",
      [task.agent_id, taskId]
    )
    if (!active.rowCount && task.status === "queued") {
      await client.query(
        "UPDATE tasks SET status='cancelled',cancel_workflow_pending=true,updated_at=now() WHERE id=$1",
        [taskId]
      )
      await appendEventInTransaction(client, taskId, "cancelled", "cancelled", {
        message: "Queued task cancelled before workstation acquisition",
      })
    }
    await client.query("COMMIT")
    return {
      status: !active.rowCount && task.status === "queued" ? "cancelled" : "stopping",
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function requestTakeover(
  taskId: string,
  reason: string,
  requestId: string = randomUUID(),
  ownerId?: string,
  actionNo?: number,
  transaction?: PoolClient
) {
  const client = transaction ?? (await pool.connect())
  try {
    if (!transaction) await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{
      owner_id: string
      status: string
      agent_id: string
      active_segment: number
      cancel_requested_at: Date | null
    }>(
      "SELECT owner_id,status,agent_id,active_segment,cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId]
    )
    if (!task || (ownerId && task.owner_id !== ownerId))
      throw new HttpError(404, "Task not found")
    if (terminal.has(task.status) || task.cancel_requested_at)
      throw new HttpError(409, "Task is no longer available for takeover")
    const {
      rows: [workspace],
    } = await client.query<{
      active_task_id: string | null
      request_id: string | null
      mode: string
      desired_mode: string | null
    }>(
      "SELECT active_task_id,request_id,mode,desired_mode FROM workstation_control WHERE agent_id=$1 FOR UPDATE",
      [task.agent_id]
    )
    if (!workspace || workspace.active_task_id !== taskId)
      throw new HttpError(409, "Task has not acquired its workstation")
    if (workspace.request_id) {
      const {
        rows: [existing],
      } = await client.query("SELECT id,status FROM task_requests WHERE id=$1", [
        workspace.request_id,
      ])
      if (!transaction) await client.query("COMMIT")
      return {
        requestId: existing.id as string,
        status: workspace.mode === "human" ? "human" : "quiescing",
      }
    }
    await client.query(
      `INSERT INTO task_requests(id,task_id,agent_id,segment_no,action_no,kind,payload,payload_version,status,created_at)
      VALUES($1,$2,$3,$4,$5,'takeover',$6,1,'pending',now())`,
      [
        requestId,
        taskId,
        task.agent_id,
        task.active_segment,
        actionNo ?? null,
        JSON.stringify({ reason }),
      ]
    )
    await client.query(
      "UPDATE workstation_control SET desired_mode='human',request_id=$2,updated_at=now() WHERE agent_id=$1",
      [task.agent_id, requestId]
    )
    await appendEventInTransaction(
      client,
      taskId,
      `takeover-requested:${requestId}`,
      "takeover_requested",
      {
        requestId,
        reason,
        message: "Preparing human control; agent input must stop first",
      }
    )
    if (!transaction) await client.query("COMMIT")
    return { requestId, status: "quiescing" }
  } catch (error) {
    if (!transaction) await client.query("ROLLBACK")
    throw error
  } finally {
    if (!transaction) client.release()
  }
}

export async function respondToRequest(
  ownerId: string,
  requestId: string,
  decision: string,
  payloadVersion: number,
  response: Record<string, unknown>,
  actor: "owner" | "calendar" = "owner",
  provision?: {
    client: PoolClient
    purpose: "vault_secret" | "payment" | "payment_submit"
    item?: { itemId: string; revision: number }
  }
) {
  const durable = await durableClient()
  const client = provision?.client ?? (await pool.connect())
  try {
    if (!provision) await client.query("BEGIN")
    const {
      rows: [candidate],
    } = await client.query<{ task_id: string }>(
      "SELECT r.task_id FROM task_requests r JOIN tasks t ON t.id=r.task_id WHERE r.id=$1 AND t.owner_id=$2",
      [requestId, ownerId]
    )
    if (!candidate) throw new HttpError(404, "Request not found")
    const {
      rows: [task],
    } = await client.query<{
      status: string
      cancel_requested_at: Date | null
      active_segment: number
    }>(
      "SELECT status,cancel_requested_at,active_segment FROM tasks WHERE id=$1 FOR UPDATE",
      [candidate.task_id]
    )
    const {
      rows: [request],
    } = await client.query<{
      task_id: string
      agent_id: string
      segment_no: number
      kind: string
      payload: Record<string, unknown>
      status: string
      decision: string | null
      payload_version: number
      response: Record<string, unknown> | null
    }>("SELECT * FROM task_requests WHERE id=$1 FOR UPDATE", [requestId])
    if (request.segment_no !== task.active_segment)
      throw new HttpError(409, "This request belongs to an earlier task segment")
    if (request.payload_version !== payloadVersion)
      throw new HttpError(409, "Request parameters changed")
    if (request.payload.purpose === "vault_secret") {
      if (
        decision === "approve" &&
        (provision?.purpose !== "vault_secret" ||
          !isDeepStrictEqual(response, provision.item))
      )
        throw new HttpError(400, "请通过认证网页的安全凭据表单提供或选择条目。")
      if (decision !== "approve" && !isDeepStrictEqual(response, {}))
        throw new HttpError(400, "凭据请求的拒绝或取消不接受文本答复。")
    } else if (request.payload.purpose === "payment") {
      if (decision === "approve" && provision?.purpose !== "payment")
        throw new HttpError(400, "请通过认证网页的支付选择表单确认方式或接管。")
      if (decision !== "approve" && !isDeepStrictEqual(response, {}))
        throw new HttpError(400, "支付请求的拒绝或取消不接受附加字段。")
    } else if (request.payload.purpose === "payment_submit") {
      if (!isDeepStrictEqual(response, {}))
        throw new HttpError(400, "付款提交仅接受精确决定，不接受文本或附加字段。")
      if (decision === "approve" && provision?.purpose !== "payment_submit")
        throw new HttpError(400, "请在认证网页核对本次付款按钮后批准提交。")
      if (decision === "approve" && !request.decision) {
        const grant = paymentSubmitGrantSchema.parse(request.payload)
        if (
          grant.agentId !== request.agent_id ||
          grant.segmentNo !== request.segment_no ||
          grant.submissionRequestId !== requestId
        )
          throw new HttpError(409, "付款提交批准范围与请求不符。")
        await assertPaymentSubmission(client, request.task_id, grant)
      }
    } else if (provision) throw new HttpError(400, "该请求不接受安全选择。")
    if (provision && provision.purpose !== request.payload.purpose)
      throw new HttpError(400, "安全选择类型与请求不符。")
    if (request.payload.purpose === "vault_fill") {
      if (!isDeepStrictEqual(response, {}))
        throw new HttpError(400, "填写授权仅接受明确决定，不接受秘密或附加字段。")
      if (decision === "approve" && !request.decision) {
        const grant = vaultGrantSchema.parse(request.payload)
        if (grant.agentId !== request.agent_id || grant.segmentNo !== request.segment_no)
          throw new HttpError(409, "授权范围与当前请求不符。")
        await assertVaultGrant(client, request.task_id, grant)
      }
    }
    if (
      actor === "calendar" &&
      (request.decision ||
        terminal.has(task.status) ||
        task.cancel_requested_at ||
        request.status === "cancelled")
    ) {
      if (!provision) await client.query("COMMIT")
      return { status: request.status }
    }
    if (request.decision) {
      if (request.decision !== decision || !isDeepStrictEqual(request.response, response))
        throw new HttpError(409, "Request already has a different decision")
      if (!provision) await client.query("COMMIT")
      return { status: request.status }
    }
    if (
      terminal.has(task.status) ||
      task.cancel_requested_at ||
      request.status === "cancelled"
    )
      throw new HttpError(409, "Request is no longer active")
    if (request.kind === "takeover") {
      if (decision !== "handback")
        throw new HttpError(400, "Takeover expects a handback decision")
      const workspace = await client.query(
        "SELECT agent_id FROM workstation_control WHERE agent_id=$1 AND mode='human' AND request_id=$2 FOR UPDATE",
        [request.agent_id, requestId]
      )
      if (!workspace.rowCount)
        throw new HttpError(409, "Human control is not ready for handback")
      await client.query(
        "UPDATE workstation_control SET desired_mode='agent',updated_at=now() WHERE agent_id=$1",
        [request.agent_id]
      )
    } else {
      const allowed =
        request.kind === "approval"
          ? ["approve", "decline", "cancel"]
          : request.kind === "budget" ||
              ["execution_error", "control_recovery"].includes(
                String(request.payload.purpose)
              ) ||
              ["vault_fill", "payment_submit"].includes(String(request.payload.tool))
            ? ["continue", "cancel"]
            : ["continue", "complete", "cancel"]
      if (!allowed.includes(decision))
        throw new HttpError(400, "Unsupported request decision")
      if (
        request.kind === "budget" &&
        request.payload.purpose === "limits" &&
        decision === "continue"
      ) {
        const changes = budgetChangesSchema.safeParse(response.budget)
        if (!changes.success) throw new HttpError(400, changes.error.message)
      }
      if (decision === "cancel") {
        await client.query(
          "UPDATE tasks SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id=$1",
          [request.task_id]
        )
        await client.query(
          "UPDATE workstation_control SET desired_mode='cancelled',updated_at=now() WHERE active_task_id=$1",
          [request.task_id]
        )
        await appendEventInTransaction(
          client,
          request.task_id,
          "cancel-requested",
          "cancel_requested",
          { message: "Owner cancelled while reviewing a request" }
        )
      }
      await durable.sendInTransaction(
        client,
        `${request.task_id}:${request.segment_no}`,
        { requestId, decision, response },
        requestId,
        `decision:${requestId}`
      )
    }
    await client.query(
      "UPDATE task_requests SET decision=$2,response=$3,status='decided' WHERE id=$1",
      [requestId, decision, JSON.stringify(response)]
    )
    await appendEventInTransaction(
      client,
      request.task_id,
      `decision:${requestId}`,
      "request_decided",
      { requestId, decision, actor }
    )
    if (!provision) await client.query("COMMIT")
    return { status: "decided" }
  } catch (error) {
    if (!provision) await client.query("ROLLBACK")
    throw error
  } finally {
    if (!provision) client.release()
  }
}
