// Request/selection intent adapted from the pinned MIT upstream lib/vault-requests.ts (MIT).
import { z } from "zod"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { respondToRequest } from "@/lib/task-control"
import { saveVaultItem } from "@/lib/vault"
import { vaultMutationSchema, type VaultKind } from "@/lib/vault-schema"

export const provisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("provide"),
    payloadVersion: z.number().int().min(1),
    save: z.boolean(),
    item: vaultMutationSchema,
  }),
  z.strictObject({
    action: z.literal("select"),
    payloadVersion: z.number().int().min(1),
    itemId: z.string().min(1).max(200),
    revision: z.number().int().min(1),
  }),
])
export async function provisionVaultRequest(
  ownerId: string,
  requestId: string,
  input: z.infer<typeof provisionSchema>
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
    if (!candidate) throw new HttpError(404, "请求不存在。")
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
      payload_version: number
      payload: { purpose: string; secretKind: VaultKind; origin: string }
      status: string
      decision: string | null
      response: { itemId: string; revision: number } | null
    }>("SELECT * FROM task_requests WHERE id=$1 FOR UPDATE", [requestId])
    if (request.kind !== "approval" || request.payload.purpose !== "vault_secret")
      throw new HttpError(400, "该请求不接受凭据。")
    if (request.payload_version !== input.payloadVersion)
      throw new HttpError(409, "请求版本已变化。")
    const requestedId = input.action === "provide" ? input.item.id : input.itemId
    if (
      request.decision &&
      (request.decision !== "approve" || request.response?.itemId !== requestedId)
    )
      throw new HttpError(409, "请求已经有不同的决定。")
    if (
      !request.decision &&
      (request.status !== "pending" ||
        task.cancel_requested_at ||
        ["completed", "failed", "cancelled"].includes(task.status))
    )
      throw new HttpError(409, "请求已失效。")
    if (request.decision) {
      const exists = await client.query("SELECT 1 FROM vault_items WHERE id=$1", [
        requestedId,
      ])
      if (!exists.rowCount) throw new HttpError(409, "已提供条目不再存在，请刷新任务。")
    }
    let chosen: { id: string; revision: number }
    if (input.action === "provide") {
      if (
        input.item.kind !== request.payload.secretKind ||
        input.item.origin !== request.payload.origin
      )
        throw new HttpError(409, "条目类型或目标站点与请求不符。")
      chosen = await saveVaultItem(
        input.item,
        { taskId: candidate.task_id, ephemeral: !input.save },
        client
      )
    } else {
      const {
        rows: [item],
      } = await client.query<{
        id: string
        kind: VaultKind
        revision: number
        origin: string | null
        scope_task_id: string | null
        expires_at: Date | null
        consumed_at: Date | null
        unexpired: boolean
      }>(
        "SELECT id,kind,revision,origin,scope_task_id,expires_at,consumed_at,(expires_at IS NULL OR expires_at>now()) AS unexpired FROM vault_items WHERE id=$1 FOR UPDATE",
        [input.itemId]
      )
      if (
        !item ||
        item.kind !== request.payload.secretKind ||
        item.origin !== request.payload.origin ||
        item.revision !== input.revision ||
        item.consumed_at ||
        !item.unexpired ||
        (item.scope_task_id && item.scope_task_id !== candidate.task_id)
      )
        throw new HttpError(409, "条目已变化、过期或不适用于这个任务和站点。")
      chosen = item
    }
    const response = { itemId: chosen.id, revision: chosen.revision }
    const result = await respondToRequest(
      ownerId,
      requestId,
      "approve",
      input.payloadVersion,
      response,
      "owner",
      { client, purpose: "vault_secret", item: response }
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
