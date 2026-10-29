import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import type { Task } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { assertCredentialScope } from "@/lib/vault"
import { vaultOriginSchema } from "@/lib/vault-schema"
import {
  assertAgentControl,
  controller,
  ControllerError,
  TaskCancelled,
} from "@/lib/workstation"
import {
  paymentApprovalSchema,
  paymentInspectionSchema,
  normalizePaymentText,
  type PaymentInput,
} from "@/lib/payment-schema"
import { createTaskRequest } from "./requests"

export async function createPaymentRequest(
  task: Task,
  segmentNo: number,
  actionNo: number,
  input: PaymentInput,
  epoch: number
) {
  const requestId = `${task.id}-s${segmentNo}-a${actionNo}-payment`
  const {
    rows: [existing],
  } = await pool.query<{ payload: unknown }>(
    "SELECT payload FROM task_requests WHERE id=$1 AND task_id=$2",
    [requestId, task.id]
  )
  if (existing) {
    const saved = paymentApprovalSchema.parse(existing.payload)
    if (
      !isDeepStrictEqual(input, {
        merchant: saved.merchant,
        amount: saved.amount,
        purpose: saved.reason,
        pageId: saved.pageId,
        observationId: saved.observationId,
        evidenceRefs: {
          merchant: saved.evidence.merchant.ref,
          amount: saved.evidence.amount.ref,
        },
      }) ||
      saved.agentId !== task.agentId ||
      saved.segmentNo !== segmentNo ||
      saved.actionNo !== actionNo
    )
      throw new Error("Payment action ID reused with different parameters")
    return {
      ok: true,
      requestId,
      output: { waitingForOwner: true, paymentRequestId: requestId },
    }
  }
  const workspace = await assertAgentControl(task.id, task.agentId)
  if (workspace.epoch !== epoch)
    return {
      ok: false,
      stale: true,
      output: { error: "Control changed; observe and request new payment approval." },
    }
  let inspection
  try {
    inspection = paymentInspectionSchema.parse(
      await controller(task.agentId, "/payment-inspect", {
        pageId: input.pageId,
        observationId: input.observationId,
        evidenceRefs: input.evidenceRefs,
        epoch,
      })
    )
  } catch (error) {
    if (error instanceof ControllerError && [400, 404, 409].includes(error.status ?? 0))
      return {
        ok: false,
        stale: true,
        output: {
          error:
            "Payment evidence changed or is unsupported. Observe current text references before requesting approval.",
        },
      }
    throw error
  }
  if (
    inspection.epoch !== epoch ||
    inspection.bootId !== workspace.bootId ||
    !vaultOriginSchema.safeParse(inspection.origin).success
  )
    return {
      ok: false,
      stale: true,
      output: { error: "Payment site or workspace is not a supported current origin." },
    }
  if (
    inspection.evidence.merchant.ref !== input.evidenceRefs.merchant ||
    inspection.evidence.amount.ref !== input.evidenceRefs.amount
  )
    throw new Error("Workstation changed the payment evidence references")
  if (
    normalizePaymentText(input.merchant) !== inspection.evidence.merchant.text ||
    normalizePaymentText(input.amount) !== inspection.evidence.amount.text
  )
    return {
      ok: false,
      output: {
        error:
          "Merchant/amount do not match the selected visible page text. No payment approval was created.",
      },
    }
  const methods = await pool.query(
    `SELECT id,revision,kind,label,hint FROM vault_items WHERE kind IN ('card','upi') AND origin=$1
    AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (scope_task_id IS NULL OR scope_task_id=$2) ORDER BY updated_at DESC,id`,
    [inspection.origin, task.id]
  )
  const expires = (
    await pool.query<{ expires: Date }>("SELECT now()+interval '5 minutes' AS expires")
  ).rows[0].expires
  const approval = paymentApprovalSchema.parse({
    ...inspection,
    purpose: "payment",
    merchant: input.merchant,
    amount: input.amount,
    reason: input.purpose,
    pageId: input.pageId,
    observationId: input.observationId,
    agentId: task.agentId,
    segmentNo,
    actionNo,
    expiresAt: expires.toISOString(),
    methods: methods.rows,
  })
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
    await assertCredentialScope(client, task.id, approval)
    await createTaskRequest(task.id, segmentNo, requestId, "approval", approval, client)
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
    output: {
      waitingForOwner: true,
      paymentRequestId: requestId,
      origin: approval.origin,
      merchant: approval.merchant,
      amount: approval.amount,
    },
  }
}
