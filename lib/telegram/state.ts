import { randomBytes, randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { pool } from "@/db"
import { getSetting } from "@/lib/config"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import { HttpError } from "@/lib/errors"
import { assertDelegationRoster } from "@/lib/agent/roster"

export type Connection = {
  owner_id: string
  generation: string
  bot_id: string | null
  bot_username: string | null
  cursor: number
  pair_code: string | null
  pair_expires_at: Date | null
  user_id: string | null
  chat_id: string | null
  owner_name: string | null
  paired_at: Date | null
  agent_id: string | null
  delegate_agent_ids: string[]
  thread_id: string | null
  task_id: string | null
  last_poll_at: Date | null
  last_error: string | null
}
// Pair code generation follows the pinned upstream's unambiguous alphabet.
export function createPairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return [...randomBytes(12)].map((byte) => alphabet[byte % alphabet.length]).join("")
}
export async function ensureTelegramConnection(ownerId?: string) {
  await pool.query(
    `INSERT INTO telegram_connection(id,owner_id,generation)
    SELECT 1,user_id,$1 FROM owners WHERE ($2::text IS NULL OR user_id=$2) ON CONFLICT DO NOTHING`,
    [randomUUID(), ownerId ?? null]
  )
  const {
    rows: [row],
  } = await pool.query<Connection>("SELECT * FROM telegram_connection WHERE id=1")
  if (ownerId && row?.owner_id !== ownerId)
    throw new HttpError(403, "Owner access required")
  return row
}
export async function lockTelegram(client: PoolClient, generation?: string) {
  const {
    rows: [row],
  } = await client.query<Connection>(
    "SELECT * FROM telegram_connection WHERE id=1 FOR UPDATE"
  )
  return row && (!generation || generation === row.generation) ? row : null
}
export async function telegramStatus(ownerId: string) {
  const row = await ensureTelegramConnection(ownerId)
  const token = await getSetting("telegram.botToken")
  const notices = await pool.query(
    `SELECT id,key,status,attempts,uncertain_attempts,last_error,created_at
    FROM telegram_outbox WHERE generation=$1 AND status IN ('unknown','failed') ORDER BY created_at DESC LIMIT 20`,
    [row.generation]
  )
  return {
    generation: row.generation,
    configured: !!token,
    bot: row.bot_id ? { id: row.bot_id, username: row.bot_username } : null,
    paired: row.user_id ? { id: row.user_id, name: row.owner_name } : null,
    pairCode:
      !row.user_id && row.pair_code && row.pair_expires_at! > new Date()
        ? decryptSecret(row.pair_code)
        : null,
    pairExpiresAt: row.pair_expires_at,
    agentId: row.agent_id,
    delegateAgentIds: row.delegate_agent_ids,
    threadId: row.thread_id,
    lastPollAt: row.last_poll_at,
    error: row.last_error,
    notices: notices.rows,
  }
}
export type TelegramStatus = Awaited<ReturnType<typeof telegramStatus>>

export async function changeTelegram(
  ownerId: string,
  input:
    | { action: "token"; token: string | null }
    | { action: "rotate" | "unpair" }
    | { action: "agent"; agentId: string }
    | {
        action: "roster"
        generation: string
        agentId: string
        delegateAgentIds: string[]
      }
    | { action: "retry"; id: string; acknowledgeDuplicate: true }
) {
  await ensureTelegramConnection(ownerId)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const row = (await lockTelegram(client))!
    if (input.action === "agent") {
      const agent = await client.query("SELECT id FROM agents WHERE id=$1", [
        input.agentId,
      ])
      if (!agent.rowCount) throw new HttpError(404, "Agent not found")
      await client.query(
        "UPDATE telegram_connection SET agent_id=$1,delegate_agent_ids='[]'::jsonb,thread_id=NULL,task_id=NULL WHERE id=1",
        [input.agentId]
      )
    } else if (input.action === "roster") {
      if (row.generation !== input.generation || row.agent_id !== input.agentId)
        throw new HttpError(
          409,
          "Telegram pairing or selected agent changed; refresh before saving delegation permissions"
        )
      const source = await client.query(
        "SELECT id FROM agents WHERE id=$1 AND model IS DISTINCT FROM 'fixture/durable-report'",
        [row.agent_id]
      )
      if (!source.rowCount)
        throw new HttpError(
          400,
          "Choose a real Telegram agent before enabling delegation"
        )
      await assertDelegationRoster(input.delegateAgentIds)
      await client.query(
        "UPDATE telegram_connection SET delegate_agent_ids=$1 WHERE id=1",
        [JSON.stringify(input.delegateAgentIds)]
      )
    } else if (input.action === "retry") {
      const retried = await client.query(
        "UPDATE telegram_outbox SET status='pending' WHERE id=$1 AND generation=$2 AND status IN ('unknown','failed') RETURNING id",
        [input.id, row.generation]
      )
      if (!retried.rowCount)
        throw new HttpError(409, "Notification is no longer available for retry")
    } else {
      // Hold the connection lock while changing settings, so update processing linearizes before revocation.
      if (input.action === "token") {
        if (input.token)
          await client.query(
            `INSERT INTO settings(key,value,updated_at) VALUES('telegram.botToken',$1,now())
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
            [encryptSecret(input.token)]
          )
        else await client.query("DELETE FROM settings WHERE key='telegram.botToken'")
      }
      await client.query(
        `UPDATE telegram_connection SET generation=$1,user_id=NULL,chat_id=NULL,owner_name=NULL,paired_at=NULL,
        thread_id=NULL,task_id=NULL,delegate_agent_ids='[]'::jsonb,pair_code=$2,pair_expires_at=now()+interval '10 minutes',last_error=NULL,
        bot_id=CASE WHEN $3 THEN NULL ELSE bot_id END,bot_username=CASE WHEN $3 THEN NULL ELSE bot_username END,
        cursor=CASE WHEN $3 THEN 0 ELSE cursor END,last_poll_at=NULL WHERE id=1`,
        [randomUUID(), encryptSecret(createPairCode()), input.action === "token"]
      )
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  return telegramStatus(ownerId)
}
