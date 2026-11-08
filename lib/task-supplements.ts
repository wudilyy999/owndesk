import { z } from "zod"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { appendEventInTransaction } from "@/lib/task-events"

export const taskSupplementSchema = z.strictObject({
  text: z.string().trim().min(1).max(16000),
  clientRequestId: z.uuid(),
})
export type TaskSupplement = { seq: number; text: string }

export async function appendTaskSupplement(
  ownerId: string,
  taskId: string,
  raw: unknown
) {
  const input = taskSupplementSchema.parse(raw)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{
      status: string
      cancel_requested_at: Date | null
      config_snapshot: Record<string, unknown>
    }>(
      "SELECT status,cancel_requested_at,config_snapshot FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [taskId, ownerId]
    )
    if (!task) throw new HttpError(404, "Task not found")
    const key = `owner-supplement:${input.clientRequestId}`
    const {
      rows: [previous],
    } = await client.query<{ seq: number; payload: { text: string } }>(
      "SELECT seq,payload FROM task_events WHERE task_id=$1 AND key=$2",
      [taskId, key]
    )
    if (previous) {
      if (previous.payload.text !== input.text)
        throw new HttpError(409, "Request key already used with different instructions")
      await client.query("COMMIT")
      return { seq: previous.seq, reused: true }
    }
    if (
      ["completed", "failed", "cancelled"].includes(task.status) ||
      task.cancel_requested_at
    )
      throw new HttpError(409, "This task has ended; send a new conversation turn")
    if (
      task.config_snapshot.runtime !== "agent" ||
      task.config_snapshot.workflowExecution ||
      task.config_snapshot.workflowCompilation ||
      task.config_snapshot.manualCompilation ||
      task.config_snapshot.lifeSession
    )
      throw new HttpError(409, "Send supplements to an ordinary computer task")
    const seq = await appendEventInTransaction(client, taskId, key, "owner_supplement", {
      text: input.text,
      message: input.text,
    })
    await client.query("COMMIT")
    return { seq, reused: false }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function taskSupplements(
  taskId: string,
  after = 0
): Promise<TaskSupplement[]> {
  return (
    await pool.query<TaskSupplement>(
      "SELECT seq,payload->>'text' AS text FROM task_events WHERE task_id=$1 AND type='owner_supplement' AND seq>$2 ORDER BY seq",
      [taskId, after]
    )
  ).rows
}

export async function hasTaskSupplement(taskId: string, after: number) {
  return (
    (
      await pool.query(
        "SELECT 1 FROM task_events WHERE task_id=$1 AND type='owner_supplement' AND seq>$2 LIMIT 1",
        [taskId, after]
      )
    ).rowCount !== 0
  )
}
