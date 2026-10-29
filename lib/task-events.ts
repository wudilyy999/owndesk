import type { PoolClient } from "pg"
import { pool } from "@/db"

export async function appendEventInTransaction(
  client: PoolClient,
  taskId: string,
  key: string,
  type: string,
  payload: Record<string, unknown>
) {
  await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId])
  const existing = await client.query<{ seq: number }>(
    "SELECT seq FROM task_events WHERE task_id=$1 AND key=$2",
    [taskId, key]
  )
  if (existing.rowCount) return existing.rows[0].seq
  const {
    rows: [task],
  } = await client.query<{ next_event_seq: number }>(
    "UPDATE tasks SET next_event_seq=next_event_seq+1, updated_at=now() WHERE id=$1 RETURNING next_event_seq",
    [taskId]
  )
  await client.query(
    "INSERT INTO task_events(task_id, seq, key, type, payload, created_at) VALUES($1,$2,$3,$4,$5,now())",
    [taskId, task.next_event_seq, key, type, JSON.stringify(payload)]
  )
  await client.query("SELECT pg_notify('task_events', $1)", [taskId])
  return task.next_event_seq
}

export async function appendEvent(
  taskId: string,
  key: string,
  type: string,
  payload: Record<string, unknown>
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const seq = await appendEventInTransaction(client, taskId, key, type, payload)
    await client.query("COMMIT")
    return seq
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
