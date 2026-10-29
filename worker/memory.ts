// Note operations adapted from the pinned MIT upstream's memory tools. The event is an atomic
// business receipt, so a missing workflow checkpoint cannot repeat a mutation.
import { randomUUID } from "node:crypto"
import { pool } from "@/db"
import { appendEventInTransaction } from "@/lib/task-events"
import { TaskCancelled, SegmentSuperseded, WorkspacePaused } from "@/lib/workstation"
import type { ActionResult } from "./actions"

export async function executeMemoryTool(
  taskId: string,
  segmentNo: number,
  actionNo: number,
  name: "memory_write" | "memory_forget",
  input: Record<string, unknown>,
  epoch: number
): Promise<ActionResult> {
  const client = await pool.connect()
  const key = `memory:${segmentNo}:${actionNo}`
  try {
    await client.query("BEGIN")
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
    const previous = await client.query<{
      payload: { result: { ok: boolean; output: Record<string, unknown> } }
    }>("SELECT payload FROM task_events WHERE task_id=$1 AND key=$2", [taskId, key])
    if (previous.rowCount) {
      await client.query("COMMIT")
      return previous.rows[0].payload.result
    }
    if (task.active_segment !== segmentNo) throw new SegmentSuperseded()
    const {
      rows: [control],
    } = await client.query<{
      epoch: number
      mode: string
      desired_mode: string | null
      active_task_id: string
    }>(
      "SELECT epoch,mode,desired_mode,active_task_id FROM workstation_control WHERE agent_id=$1 FOR UPDATE",
      [task.agent_id]
    )
    if (
      control.mode !== "agent" ||
      control.desired_mode ||
      control.active_task_id !== taskId
    )
      throw new WorkspacePaused()
    if (control.epoch !== epoch) {
      await client.query("COMMIT")
      return {
        ok: false,
        stale: true,
        output: { error: "Control changed after the model decided. Observe again." },
      }
    }
    let result: { ok: boolean; output: Record<string, unknown> }
    if (name === "memory_write") {
      const id = randomUUID(),
        content = String(input.note)
      await client.query(
        "INSERT INTO memories(id,agent_id,content,created_at) VALUES($1,$2,$3,now())",
        [id, task.agent_id, content]
      )
      result = { ok: true, output: { id, saved: content } }
    } else {
      const removed = await client.query(
        "DELETE FROM memories WHERE id=$1 AND agent_id=$2 RETURNING id",
        [input.id, task.agent_id]
      )
      result = removed.rowCount
        ? { ok: true, output: { forgotten: input.id } }
        : { ok: false, output: { error: "No note with that id belongs to this agent." } }
    }
    await appendEventInTransaction(client, taskId, key, "memory_changed", {
      tool: name,
      result,
    })
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
