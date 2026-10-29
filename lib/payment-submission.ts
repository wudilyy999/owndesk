import { isDeepStrictEqual } from "node:util"
import type { PoolClient } from "pg"
import { HttpError } from "@/lib/errors"
import { assertCredentialScope } from "@/lib/vault"
import { vaultGrantSchema } from "@/lib/vault-schema"
import {
  normalizePaymentText,
  paymentApprovalSchema,
  type PaymentSubmitGrant,
} from "@/lib/payment-schema"

// Callers hold the Task row lock. A known fill survives temporary-item cleanup;
// its saved receipt, not another secret read, proves preparation completed.
export async function paymentPreparation(
  client: PoolClient,
  taskId: string,
  segmentNo: number,
  paymentRequestId: string
) {
  const {
    rows: [request],
  } = await client.query<{
    payload: unknown
    response: { itemId: string; revision: number }
  }>(
    "SELECT payload,response FROM task_requests WHERE id=$1 AND task_id=$2 AND segment_no=$3 AND payload->>'purpose'='payment' AND status='resolved' AND decision='approve' FOR UPDATE",
    [paymentRequestId, taskId, segmentNo]
  )
  if (!request) throw new HttpError(409, "需要本任务已经批准的支付资料选择。")
  const approval = paymentApprovalSchema.parse(request.payload)
  const method = approval.methods.find(
    (m) => m.id === request.response.itemId && m.revision === request.response.revision
  )
  const {
    rows: [fill],
  } = await client.query<{ input: unknown }>(
    `SELECT input FROM task_actions WHERE task_id=$1 AND segment_no=$2 AND kind='vault_fill'
    AND input->'payment'->>'requestId'=$3 AND status='succeeded'
    AND receipt->>'ok'='true' AND receipt->'output'->>'stage'='done'`,
    [taskId, segmentNo, paymentRequestId]
  )
  if (!method || !fill)
    throw new HttpError(409, "支付资料填写尚无已知完整回执，请先核对。")
  const grant = vaultGrantSchema.parse(fill.input)
  if (
    grant.itemId !== method.id ||
    grant.revision !== method.revision ||
    grant.epoch !== approval.epoch ||
    grant.bootId !== approval.bootId ||
    grant.origin !== approval.origin ||
    grant.agentId !== approval.agentId
  )
    throw new HttpError(409, "支付准备与原批准现场不符。")
  return { approval, method }
}

export async function assertPaymentSubmission(
  client: PoolClient,
  taskId: string,
  grant: PaymentSubmitGrant
) {
  const { approval, method } = await paymentPreparation(
    client,
    taskId,
    grant.segmentNo,
    grant.paymentRequestId
  )
  if (
    grant.agentId !== approval.agentId ||
    grant.pageId !== approval.pageId ||
    grant.origin !== approval.origin ||
    grant.epoch !== approval.epoch ||
    grant.bootId !== approval.bootId ||
    !isDeepStrictEqual(grant.method, method) ||
    grant.merchant !== approval.merchant ||
    grant.amount !== approval.amount ||
    grant.evidence.merchant.text !== normalizePaymentText(approval.merchant) ||
    grant.evidence.amount.text !== normalizePaymentText(approval.amount)
  )
    throw new HttpError(409, "付款提交与原支付准备、商户或金额不符。")
  const used = await client.query(
    `SELECT 1 FROM task_actions WHERE task_id=$1 AND kind='payment_submit'
    AND input->>'paymentRequestId'=$2 AND (segment_no,action_no)<>($3,$4)
    AND NOT (status='failed' AND COALESCE((receipt->'output'->>'rejectedBeforeEffect')::boolean,false)) LIMIT 1`,
    [taskId, grant.paymentRequestId, grant.segmentNo, grant.actionNo]
  )
  if (used.rowCount)
    throw new HttpError(409, "这次支付已经提交或结果未知，请核对，不能再次自动提交。")
  await assertCredentialScope(client, taskId, grant)
}
