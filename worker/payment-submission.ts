import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import type { Task } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { appendEventInTransaction } from "@/lib/task-events"
import { assertPaymentSubmission, paymentPreparation } from "@/lib/payment-submission"
import {
  paymentSubmitGrantSchema,
  paymentSubmitInspectionSchema,
  type PaymentSubmitInput,
  type PaymentSubmitGrant,
  type PaymentResultInput,
} from "@/lib/payment-schema"
import {
  assertAgentControl,
  controller,
  ControllerError,
  TaskCancelled,
} from "@/lib/workstation"
import { executeAction, type DispatchAuthorization } from "./actions"
import { createTaskRequest } from "./requests"

async function authorizeSubmission(
  task: Task,
  grant: PaymentSubmitGrant,
  attemptNo: number
): Promise<DispatchAuthorization> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [state],
    } = await client.query<{ status: string; cancel_requested_at: Date | null }>(
      "SELECT status,cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [task.id]
    )
    if (state.cancel_requested_at || state.status === "cancelled")
      throw new TaskCancelled()
    if (state.status !== "running") throw new HttpError(409, "任务尚未就绪，未提交付款。")
    const approval = await client.query(
      "SELECT 1 FROM task_requests WHERE id=$1 AND task_id=$2 AND status='resolved' AND decision='approve' AND payload=$3::jsonb FOR UPDATE",
      [grant.submissionRequestId, task.id, JSON.stringify(grant)]
    )
    if (!approval.rowCount) throw new HttpError(409, "本次付款提交尚未获得精确批准。")
    const key = [task.id, grant.segmentNo, grant.actionNo, attemptNo]
    const {
      rows: [attempt],
    } = await client.query<{ dispatch_started_at: Date | null }>(
      "SELECT dispatch_started_at FROM task_action_attempts WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4 FOR UPDATE",
      key
    )
    if (attempt.dispatch_started_at) {
      await client.query("COMMIT")
      return {
        unknown: "付款派发权已使用，回执未确认。请核对当前账单；系统没有再次点击。",
      }
    }
    const inspection = paymentSubmitInspectionSchema.parse(
      await controller(task.agentId, "/payment-submit-inspect", {
        pageId: grant.pageId,
        observationId: grant.observationId,
        ref: grant.ref,
        epoch: grant.epoch,
        evidenceRefs: {
          merchant: grant.evidence.merchant.ref,
          amount: grant.evidence.amount.ref,
        },
      })
    )
    if (
      !isDeepStrictEqual(inspection, {
        origin: grant.origin,
        epoch: grant.epoch,
        bootId: grant.bootId,
        evidence: grant.evidence,
        target: grant.target,
      })
    )
      throw new HttpError(409, "付款页面或提交按钮已变化，未派发。")
    await assertPaymentSubmission(client, task.id, grant)
    await client.query(
      "UPDATE task_action_attempts SET dispatch_started_at=clock_timestamp() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4",
      key
    )
    await appendEventInTransaction(
      client,
      task.id,
      `payment-dispatch:${grant.segmentNo}:${grant.actionNo}`,
      "payment_dispatch_authorized",
      {
        submissionRequestId: grant.submissionRequestId,
        paymentRequestId: grant.paymentRequestId,
        origin: grant.origin,
        merchant: grant.merchant,
        amount: grant.amount,
      }
    )
    await client.query("COMMIT")
    return { authorized: true }
  } catch (error) {
    await client.query("ROLLBACK")
    if (error instanceof HttpError) return { rejected: error.message }
    if (error instanceof ControllerError && [400, 404, 409].includes(error.status ?? 0))
      return { rejected: "付款页面或提交按钮已变化，未派发。" }
    throw error
  } finally {
    client.release()
  }
}

export async function executePaymentSubmit(
  task: Task,
  segmentNo: number,
  actionNo: number,
  input: PaymentSubmitInput,
  epoch: number,
  ownerMessageSeq?: number
) {
  const requestId = `${task.id}-s${segmentNo}-a${actionNo}-submit`
  const {
    rows: [request],
  } = await pool.query<{ payload: unknown; status: string; decision: string | null }>(
    "SELECT payload,status,decision FROM task_requests WHERE id=$1 AND task_id=$2",
    [requestId, task.id]
  )
  if (request) {
    const grant = paymentSubmitGrantSchema.parse(request.payload)
    if (
      !isDeepStrictEqual(input, {
        paymentRequestId: grant.paymentRequestId,
        pageId: grant.pageId,
        observationId: grant.observationId,
        ref: grant.ref,
        evidenceRefs: {
          merchant: grant.evidence.merchant.ref,
          amount: grant.evidence.amount.ref,
        },
      }) ||
      grant.agentId !== task.agentId ||
      grant.segmentNo !== segmentNo ||
      grant.actionNo !== actionNo ||
      grant.submissionRequestId !== requestId
    )
      throw new Error("Payment submission action ID reused with different parameters")
    if (["pending", "decided"].includes(request.status))
      return {
        ok: true,
        requestId,
        output: { waitingForOwner: true, submissionRequestId: requestId },
      }
    if (request.status !== "resolved" || request.decision !== "approve")
      return {
        ok: false,
        output: { error: "Owner did not authorize this payment submission." },
      }
    return executeAction(
      task.id,
      segmentNo,
      actionNo,
      "payment_submit",
      grant,
      epoch,
      (attempt) => authorizeSubmission(task, grant, attempt),
      ownerMessageSeq
    )
  }
  const workspace = await assertAgentControl(task.id, task.agentId)
  if (workspace.epoch !== epoch)
    return {
      ok: false,
      stale: true,
      output: { error: "Control changed; observe before requesting submission." },
    }
  let inspection
  try {
    inspection = paymentSubmitInspectionSchema.parse(
      await controller(task.agentId, "/payment-submit-inspect", { ...input, epoch })
    )
  } catch (error) {
    if (error instanceof ControllerError && [400, 404, 409].includes(error.status ?? 0))
      return {
        ok: false,
        stale: true,
        output: {
          error: "Payment text/button is stale or unsupported; observe or take over.",
        },
      }
    throw error
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [state],
    } = await client.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [task.id]
    )
    if (state.cancel_requested_at) throw new TaskCancelled()
    const { approval, method } = await paymentPreparation(
      client,
      task.id,
      segmentNo,
      input.paymentRequestId
    )
    const {
      rows: [time],
    } = await client.query<{ expires: Date }>(
      "SELECT clock_timestamp()+interval '5 minutes' AS expires"
    )
    const grant = paymentSubmitGrantSchema.parse({
      ...inspection,
      purpose: "payment_submit",
      submissionRequestId: requestId,
      paymentRequestId: input.paymentRequestId,
      pageId: input.pageId,
      observationId: input.observationId,
      ref: input.ref,
      agentId: task.agentId,
      segmentNo,
      actionNo,
      merchant: approval.merchant,
      amount: approval.amount,
      method,
      expiresAt: time.expires.toISOString(),
    })
    await assertPaymentSubmission(client, task.id, grant)
    await createTaskRequest(task.id, segmentNo, requestId, "approval", grant, client)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    if (error instanceof HttpError)
      return { ok: false, stale: true, output: { error: error.message } }
    throw error
  } finally {
    client.release()
  }
  return {
    ok: true,
    requestId,
    output: { waitingForOwner: true, submissionRequestId: requestId },
  }
}

export async function executePaymentResult(
  task: Task,
  segmentNo: number,
  actionNo: number,
  input: PaymentResultInput,
  epoch: number,
  ownerMessageSeq?: number
) {
  const {
    rows: [request],
  } = await pool.query<{ payload: unknown }>(
    `SELECT r.payload FROM task_requests r JOIN task_action_attempts a ON a.task_id=r.task_id
    AND a.segment_no=r.segment_no AND a.action_no=(r.payload->>'actionNo')::int
    JOIN task_actions t ON t.task_id=a.task_id AND t.segment_no=a.segment_no AND t.action_no=a.action_no
    WHERE r.id=$1 AND r.task_id=$2 AND r.payload->>'purpose'='payment_submit'
    AND r.status='resolved' AND r.decision='approve' AND a.dispatch_started_at IS NOT NULL
    AND NOT(t.status='failed' AND COALESCE((t.receipt->'output'->>'rejectedBeforeEffect')::boolean,false)) LIMIT 1`,
    [input.submissionRequestId, task.id]
  )
  if (!request)
    return {
      ok: false,
      output: {
        error:
          "No authorized dispatched submission for this task; inspect before claiming payment.",
      },
    }
  const grant = paymentSubmitGrantSchema.parse(request.payload)
  return executeAction(
    task.id,
    segmentNo,
    actionNo,
    "payment_result",
    {
      ...input,
      origin: grant.origin,
      merchant: grant.evidence.merchant.text,
      amount: grant.evidence.amount.text,
    },
    epoch,
    undefined,
    ownerMessageSeq
  )
}
