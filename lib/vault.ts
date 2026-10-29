// Async vault storage adapted from the pinned MIT upstream lib/vault.ts (MIT); deployment-owned key.
import { isDeepStrictEqual } from "node:util"
import type { PoolClient } from "pg"
import { pool } from "@/db"
import { env } from "@/lib/env"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import { HttpError } from "@/lib/errors"
import { paymentApprovalSchema } from "@/lib/payment-schema"
import {
  vaultHint,
  vaultInputSchemas,
  type VaultItemView,
  type VaultMutation,
  type VaultKind,
  type VaultGrant,
} from "./vault-schema"

const columns = `id,kind,label,hint,origin,revision,ephemeral,expires_at AS "expiresAt",
  consumed_at AS "consumedAt",last_used_at AS "lastUsedAt",created_at AS "createdAt"`
export function vaultContext(id: string, kind: VaultKind) {
  return `vault-v2:${env.INSTALL_ID}:${id}:${kind}`
}
type VaultRow = Omit<
  VaultItemView,
  "expiresAt" | "consumedAt" | "lastUsedAt" | "createdAt"
> & {
  expiresAt: Date | null
  consumedAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
}
function view(row: VaultRow): VaultItemView {
  return {
    ...row,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
export async function listVault() {
  const { rows } = await pool.query<VaultRow>(
    `SELECT ${columns} FROM vault_items WHERE NOT ephemeral AND kind <> 'code' ORDER BY updated_at DESC,id`
  )
  return rows.map(view)
}
export async function saveVaultItem(
  input: VaultMutation,
  options: { revision?: number; taskId?: string; ephemeral?: boolean } = {},
  transaction?: PoolClient
) {
  const parsed = vaultInputSchemas[input.kind].safeParse(input.fields)
  if (!parsed.success) throw new HttpError(400, "请核对条目字段和格式。卡片不保存 CVV。")
  const fields = parsed.data as Record<string, string>
  if (input.kind === "code" && !options.taskId)
    throw new HttpError(400, "验证码仅能从任务安全表单提供。")
  const label =
    input.label ||
    (input.kind === "login"
      ? input.origin
      : input.kind === "identity"
        ? "身份资料"
        : input.kind === "code"
          ? "验证码"
          : "支付资料")
  const hint = vaultHint(input.kind, fields)
  const ephemeral = input.kind === "code" || !!options.ephemeral
  if (ephemeral && !options.taskId) throw new HttpError(400, "临时条目必须属于一个任务。")
  const client = transaction ?? (await pool.connect())
  try {
    if (!transaction) await client.query("BEGIN")
    if (options.revision !== undefined) {
      const {
        rows: [old],
      } = await client.query<{ kind: VaultKind; revision: number; ephemeral: boolean }>(
        "SELECT kind,revision,ephemeral FROM vault_items WHERE id=$1 FOR UPDATE",
        [input.id]
      )
      if (!old) throw new HttpError(404, "条目不存在。")
      if (old.kind !== input.kind || old.revision !== options.revision || old.ephemeral)
        throw new HttpError(409, "条目已变化，请刷新后重试。")
      await client.query(
        `UPDATE vault_items SET origin=$2,label=$3,hint=$4,secret=$5,revision=revision+1,updated_at=now() WHERE id=$1`,
        [
          input.id,
          input.origin,
          label,
          hint,
          encryptSecret(JSON.stringify(fields), vaultContext(input.id, input.kind)),
        ]
      )
    } else {
      await client.query(
        `INSERT INTO vault_items(id,kind,label,hint,origin,secret,ephemeral,scope_task_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7 THEN now()+interval '10 minutes' ELSE NULL END,now(),now()) ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.kind,
          label,
          hint,
          input.origin,
          encryptSecret(JSON.stringify(fields), vaultContext(input.id, input.kind)),
          ephemeral,
          ephemeral ? (options.taskId ?? null) : null,
        ]
      )
      const {
        rows: [old],
      } = await client.query<{
        kind: VaultKind
        origin: string
        label: string
        secret: string
        ephemeral: boolean
        scope_task_id: string | null
        revision: number
      }>(
        "SELECT kind,origin,label,secret,ephemeral,scope_task_id,revision FROM vault_items WHERE id=$1 FOR UPDATE",
        [input.id]
      )
      if (
        old.kind !== input.kind ||
        old.origin !== input.origin ||
        old.label !== label ||
        old.ephemeral !== ephemeral ||
        old.scope_task_id !== (ephemeral ? (options.taskId ?? null) : null) ||
        old.revision !== 1 ||
        !isDeepStrictEqual(
          JSON.parse(decryptSecret(old.secret, vaultContext(input.id, input.kind))),
          fields
        )
      )
        throw new HttpError(409, "该提交编号已经用于其他条目内容。")
    }
    const {
      rows: [row],
    } = await client.query<VaultRow>(`SELECT ${columns} FROM vault_items WHERE id=$1`, [
      input.id,
    ])
    if (!transaction) await client.query("COMMIT")
    return view(row)
  } catch (error) {
    if (!transaction) await client.query("ROLLBACK")
    throw error
  } finally {
    if (!transaction) client.release()
  }
}
export async function deleteVaultItem(id: string, revision: number) {
  const result = await pool.query("DELETE FROM vault_items WHERE id=$1 AND revision=$2", [
    id,
    revision,
  ])
  if (!result.rowCount) throw new HttpError(409, "条目已删除或发生变化，请刷新。")
}

// Adapted from the pinned MIT upstream sweepVault: task-scoped secrets have an explicit expiry.
export async function sweepVault() {
  const result = await pool.query(`DELETE FROM vault_items v WHERE v.ephemeral AND
    (v.expires_at<=now() OR v.consumed_at IS NOT NULL OR EXISTS(
      SELECT 1 FROM tasks t WHERE t.id=v.scope_task_id AND t.status IN ('completed','failed','cancelled')))`)
  return result.rowCount
}

// Callers hold the Task lock before the request/item locks. No plaintext is read here.
export async function assertVaultGrant(
  client: PoolClient,
  taskId: string,
  grant: VaultGrant
) {
  const item = await client.query(
    `SELECT id FROM vault_items WHERE id=$1 AND revision=$2 AND kind=$3 AND origin=$4
    AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
    AND (scope_task_id IS NULL OR scope_task_id=$5) FOR UPDATE`,
    [grant.itemId, grant.revision, grant.kind, grant.origin, taskId]
  )
  if (!item.rowCount)
    throw new HttpError(409, "凭据或授权已变化/过期，请拒绝本次请求后重新申请。")
  await assertCredentialScope(client, taskId, grant)
  if (grant.payment) {
    const {
      rows: [request],
    } = await client.query<{
      payload: unknown
      response: { itemId?: string; revision?: number }
    }>(
      "SELECT payload,response FROM task_requests WHERE id=$1 AND task_id=$2 AND kind='approval' AND payload->>'purpose'='payment' AND status='resolved' AND decision='approve' FOR UPDATE",
      [grant.payment.requestId, taskId]
    )
    if (!request) throw new HttpError(409, "支付选择尚未批准或已失效。")
    const payment = paymentApprovalSchema.parse(request.payload)
    if (
      request.response.itemId !== grant.itemId ||
      request.response.revision !== grant.revision ||
      payment.agentId !== grant.agentId ||
      payment.segmentNo !== grant.segmentNo ||
      payment.origin !== grant.origin ||
      payment.pageId !== grant.pageId ||
      payment.observationId !== grant.observationId ||
      payment.epoch !== grant.epoch ||
      payment.bootId !== grant.bootId ||
      !isDeepStrictEqual(grant.payment, {
        requestId: grant.payment.requestId,
        merchant: payment.merchant,
        amount: payment.amount,
        evidence: payment.evidence,
      })
    )
      throw new HttpError(409, "支付选择、站点或现场与填写请求不符，请重新申请。")
    await assertCredentialScope(client, taskId, payment)
    const consumed = await client.query(
      `SELECT 1 FROM task_actions a JOIN task_action_attempts x USING(task_id,segment_no,action_no)
       WHERE a.task_id=$1 AND a.kind='vault_fill' AND a.input->'payment'->>'requestId'=$2 AND x.secret_released_at IS NOT NULL LIMIT 1`,
      [taskId, grant.payment.requestId]
    )
    if (consumed.rowCount)
      throw new HttpError(409, "本次支付选择已经释放过资料，不能用于另一动作。")
  }
}

export async function assertCredentialScope(
  client: PoolClient,
  taskId: string,
  grant: Pick<VaultGrant, "agentId" | "segmentNo" | "epoch" | "bootId" | "expiresAt">
) {
  const workspace = await client.query(
    `SELECT 1 FROM workstation_control WHERE agent_id=$1 AND active_task_id=$2
    AND active_segment=$3 AND epoch=$4 AND boot_id=$5 AND mode='agent' AND desired_mode IS NULL AND $6::timestamptz>clock_timestamp()`,
    [grant.agentId, taskId, grant.segmentNo, grant.epoch, grant.bootId, grant.expiresAt]
  )
  if (!workspace.rowCount)
    throw new HttpError(409, "工作站控制现场已变化或授权过期，请重新观察并申请。")
}
