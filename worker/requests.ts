import { pool } from "@/db"
import { appendEventInTransaction } from "@/lib/task-events"
import { TaskCancelled, SegmentSuperseded } from "@/lib/workstation"
import type { PoolClient } from "pg"

export async function createTaskRequest(
  taskId: string,
  segmentNo: number,
  requestId: string,
  kind: "budget" | "review" | "approval",
  payload: Record<string, unknown>,
  transaction?: PoolClient
) {
  const client = transaction ?? (await pool.connect())
  try {
    if (!transaction) await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{
      agent_id: string
      cancel_requested_at: Date | null
      active_segment: number
    }>(
      "SELECT agent_id,cancel_requested_at,active_segment FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId]
    )
    if (task.cancel_requested_at) throw new TaskCancelled()
    if (task.active_segment !== segmentNo) throw new SegmentSuperseded()
    await client.query(
      `INSERT INTO task_requests(id,task_id,agent_id,segment_no,kind,payload,payload_version,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'pending',now()) ON CONFLICT(id) DO NOTHING`,
      [requestId, taskId, task.agent_id, segmentNo, kind, JSON.stringify(payload)]
    )
    await client.query("UPDATE tasks SET status=$2,updated_at=now() WHERE id=$1", [
      taskId,
      kind === "approval" ? "waiting_user" : "needs_review",
    ])
    await appendEventInTransaction(
      client,
      taskId,
      `request:${requestId}`,
      "request_created",
      { requestId, kind, ...payload }
    )
    if (!transaction) await client.query("COMMIT")
    return requestId
  } catch (error) {
    if (!transaction) await client.query("ROLLBACK")
    throw error
  } finally {
    if (!transaction) client.release()
  }
}
