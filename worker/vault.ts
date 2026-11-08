import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import type { Task } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { decryptSecret } from "@/lib/secrets"
import { appendEventInTransaction } from "@/lib/task-events"
import { assertVaultGrant, vaultContext } from "@/lib/vault"
import {
  vaultGrantSchema,
  vaultInspectionSchema,
  vaultFieldValues,
  VAULT_FIELDS,
  type VaultFillInput,
  type VaultGrant,
  type VaultKind,
} from "@/lib/vault-schema"
import { paymentApprovalSchema, paymentInspectionSchema } from "@/lib/payment-schema"
import {
  assertAgentControl,
  controller,
  ControllerError,
  TaskCancelled,
} from "@/lib/workstation"
import { executeAction, type ActionResult, type DispatchAuthorization } from "./actions"
import { createTaskRequest } from "./requests"

async function releaseValues(
  task: Task,
  grant: VaultGrant,
  requestId: string,
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
    if (state.status !== "running")
      throw new HttpError(409, "Task is not ready for sensitive filling.")
    const approval = await client.query(
      "SELECT 1 FROM task_requests WHERE id=$1 AND task_id=$2 AND status='resolved' AND decision='approve' AND payload=$3::jsonb FOR UPDATE",
      [requestId, task.id, JSON.stringify(grant)]
    )
    if (!approval.rowCount)
      throw new HttpError(409, "This exact filling approval is no longer valid.")
    const key = [task.id, grant.segmentNo, grant.actionNo, attemptNo]
    const {
      rows: [attempt],
    } = await client.query<{ secret_released_at: Date | null }>(
      "SELECT secret_released_at FROM task_action_attempts WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4 FOR UPDATE",
      key
    )
    if (attempt.secret_released_at) {
      await client.query("COMMIT")
      return {
        unknown:
          "This approval already released secrets but has no confirmed receipt. Inspect the page; no secret was resent.",
      }
    }
    if (grant.payment) {
      let inspection
      try {
        inspection = paymentInspectionSchema.parse(
          await controller(task.agentId, "/payment-inspect", {
            pageId: grant.pageId,
            observationId: grant.observationId,
            epoch: grant.epoch,
            evidenceRefs: {
              merchant: grant.payment.evidence.merchant.ref,
              amount: grant.payment.evidence.amount.ref,
            },
          })
        )
      } catch (error) {
        if (
          error instanceof ControllerError &&
          [400, 404, 409].includes(error.status ?? 0)
        )
          throw new HttpError(409, "支付页面原文已变化，请重新观察并申请批准。")
        throw error
      }
      if (
        !isDeepStrictEqual(inspection, {
          origin: grant.origin,
          epoch: grant.epoch,
          bootId: grant.bootId,
          evidence: grant.payment.evidence,
        })
      )
        throw new HttpError(409, "支付页面原文已变化，未释放支付资料。")
    }
    await assertVaultGrant(client, task.id, grant)
    const {
      rows: [item],
    } = await client.query<{ secret: string }>(
      "SELECT secret FROM vault_items WHERE id=$1",
      [grant.itemId]
    )
    const values = vaultFieldValues(
      grant.kind,
      JSON.parse(decryptSecret(item.secret, vaultContext(grant.itemId, grant.kind))),
      grant.fields.map((f) => f.field)
    )
    await client.query(
      "UPDATE task_action_attempts SET secret_released_at=clock_timestamp() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4",
      key
    )
    await client.query(
      "UPDATE vault_items SET last_used_at=clock_timestamp(),consumed_at=CASE WHEN ephemeral THEN clock_timestamp() ELSE consumed_at END WHERE id=$1",
      [grant.itemId]
    )
    await appendEventInTransaction(
      client,
      task.id,
      `vault-release:${grant.segmentNo}:${grant.actionNo}`,
      "vault_released",
      {
        itemId: grant.itemId,
        requestId,
        fields: grant.fields.map((f) => f.field),
        origin: grant.origin,
      }
    )
    await client.query("COMMIT")
    return { values }
  } catch (error) {
    await client.query("ROLLBACK")
    if (error instanceof HttpError) return { rejected: error.message }
    throw error
  } finally {
    client.release()
  }
}

export async function executeVaultFill(
  task: Task,
  segmentNo: number,
  actionNo: number,
  input: VaultFillInput,
  epoch: number,
  ownerMessageSeq?: number
): Promise<ActionResult & { requestId?: string }> {
  const requestId = `${task.id}-s${segmentNo}-a${actionNo}-vault`
  const {
    rows: [request],
  } = await pool.query<{
    payload: Record<string, unknown>
    status: string
    decision: string | null
  }>("SELECT payload,status,decision FROM task_requests WHERE id=$1 AND task_id=$2", [
    requestId,
    task.id,
  ])
  if (request) {
    const grant = vaultGrantSchema.parse(request.payload)
    const original = {
      itemId: grant.itemId,
      revision: grant.revision,
      pageId: grant.pageId,
      observationId: grant.observationId,
      fields: grant.fields.map(({ field, ref }) => ({ field, ref })),
      ...(grant.payment ? { paymentRequestId: grant.payment.requestId } : {}),
    }
    if (
      !isDeepStrictEqual(input, original) ||
      grant.agentId !== task.agentId ||
      grant.segmentNo !== segmentNo ||
      grant.actionNo !== actionNo
    )
      throw new Error("Filling action ID reused with different authorization parameters")
    if (request.status === "pending" || request.status === "decided")
      return { ok: true, requestId, output: { waitingForOwner: true } }
    if (request.status !== "resolved" || request.decision !== "approve")
      return {
        ok: false,
        output: { error: "Owner did not authorize this filling action." },
      }
    return executeAction(
      task.id,
      segmentNo,
      actionNo,
      "vault_fill",
      grant,
      epoch,
      (attempt) => releaseValues(task, grant, requestId, attempt),
      ownerMessageSeq
    )
  }
  const workspace = await assertAgentControl(task.id, task.agentId)
  if (workspace.epoch !== epoch)
    return {
      ok: false,
      stale: true,
      output: { error: "Control changed; observe and request a fresh filling action." },
    }
  const {
    rows: [item],
  } = await pool.query<{
    kind: VaultKind
    origin: string
    revision: number
    label: string
    hint: string
    expires: Date
  }>(
    `SELECT kind,origin,revision,label,hint,LEAST(COALESCE(expires_at,'infinity'::timestamptz),now()+interval '5 minutes') AS expires
    FROM vault_items WHERE id=$1 AND revision=$2 AND origin IS NOT NULL
    AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND (scope_task_id IS NULL OR scope_task_id=$3)`,
    [input.itemId, input.revision, task.id]
  )
  if (!item)
    return {
      ok: false,
      output: {
        error: "Use a current, unconsumed item for this task and its exact origin.",
      },
    }
  const paymentKind = item.kind === "card" || item.kind === "upi"
  if (paymentKind !== !!input.paymentRequestId)
    return {
      ok: false,
      output: {
        error: paymentKind
          ? "Payment approval required: card/UPI fields need an owner-selected paymentRequestId."
          : "Payment bindings are only for card/UPI items.",
      },
    }
  let payment, paymentExpires
  if (input.paymentRequestId) {
    const {
      rows: [request],
    } = await pool.query<{ payload: unknown }>(
      "SELECT payload FROM task_requests WHERE id=$1 AND task_id=$2 AND payload->>'purpose'='payment'",
      [input.paymentRequestId, task.id]
    )
    if (!request)
      return {
        ok: false,
        output: { error: "Payment approval does not belong to this task." },
      }
    const approval = paymentApprovalSchema.parse(request.payload)
    payment = {
      requestId: input.paymentRequestId,
      merchant: approval.merchant,
      amount: approval.amount,
      evidence: approval.evidence,
    }
    paymentExpires = new Date(approval.expiresAt)
  }
  if (input.fields.some((binding) => !VAULT_FIELDS[item.kind].includes(binding.field)))
    return {
      ok: false,
      output: { error: "The item does not contain the requested fields." },
    }
  let inspection
  try {
    inspection = vaultInspectionSchema.parse(
      await controller(task.agentId, "/vault-inspect", {
        ...input,
        epoch,
        ...(payment ? { payment } : {}),
      })
    )
  } catch (error) {
    if (error instanceof ControllerError && [400, 404, 409].includes(error.status ?? 0))
      return {
        ok: false,
        stale: true,
        output: {
          error:
            error.status === 404
              ? "This workstation needs the vault-capable image. Drain tasks and recreate the container with the configured image."
              : "The target fields changed. Observe again before requesting approval.",
        },
      }
    throw error
  }
  if (
    inspection.origin !== item.origin ||
    inspection.epoch !== epoch ||
    inspection.bootId !== workspace.bootId
  )
    return {
      ok: false,
      stale: true,
      output: {
        error:
          "The observed page does not match the item's exact origin or current workspace.",
      },
    }
  if (
    !isDeepStrictEqual(
      inspection.fields.map(({ field, ref }) => ({ field, ref })),
      input.fields
    )
  )
    throw new Error("Workstation changed the requested field mapping")
  const grant = vaultGrantSchema.parse({
    ...inspection,
    purpose: "vault_fill",
    itemId: input.itemId,
    revision: input.revision,
    kind: item.kind,
    label: item.label,
    hint: item.hint,
    agentId: task.agentId,
    segmentNo,
    actionNo,
    pageId: input.pageId,
    observationId: input.observationId,
    expiresAt: new Date(
      Math.min(item.expires.getTime(), paymentExpires?.getTime() ?? Infinity)
    ).toISOString(),
    ...(payment ? { payment } : {}),
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
    await assertVaultGrant(client, task.id, grant)
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
    output: {
      waitingForOwner: true,
      origin: grant.origin,
      fields: input.fields.map((f) => f.field),
    },
  }
}
