// life_log / life_share: a companion's daily-life session records what it did and queues
// messages for the person. Same atomic receipt pattern as worker/memory.ts.
import { randomUUID } from "node:crypto"
import { pool } from "@/db"
import { appendEventInTransaction } from "@/lib/task-events"
import { TaskCancelled, SegmentSuperseded, WorkspacePaused } from "@/lib/workstation"
import type { ActionResult } from "./actions"

// Links the model writes down must resolve; a made-up URL is rejected so it cannot be shared.
// Bot-blocking statuses (401/403/429/999) still prove the page exists.
export async function linkResolves(url: string, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; owndesk-life-check)" },
    })
    return response.status < 400 || [401, 403, 429, 999].includes(response.status)
  } catch {
    return false
  }
}

// The only paths a life session may read or write
export const LIFE_DIR = "/home/agent/Life"
export function lifePathAllowed(path: string) {
  const absolute = path.startsWith("/") ? path : `/home/agent/${path}`
  const parts: string[] = []
  for (const part of absolute.split("/"))
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  const normal = `/${parts.join("/")}`
  return normal === LIFE_DIR || normal.startsWith(`${LIFE_DIR}/`)
}

export async function executeLifeTool(
  taskId: string,
  segmentNo: number,
  actionNo: number,
  name: "life_log" | "life_share",
  input: Record<string, unknown>,
  epoch: number
): Promise<ActionResult> {
  const key = `life:${segmentNo}:${actionNo}`
  if (
    name === "life_log" &&
    typeof input.url === "string" &&
    !(await linkResolves(input.url))
  )
    return {
      ok: false,
      output: {
        error: "That link does not open. Log the real address of the page you read.",
      },
    }
  const client = await pool.connect()
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
    if (name === "life_log") {
      const id = randomUUID()
      await client.query(
        "INSERT INTO life_activities(id,agent_id,task_id,kind,title,summary,url,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())",
        [
          id,
          task.agent_id,
          taskId,
          input.kind,
          input.title,
          input.summary,
          input.url ?? null,
        ]
      )
      result = { ok: true, output: { activityId: id } }
    } else {
      const activity = await client.query(
        "SELECT 1 FROM life_activities WHERE id=$1 AND agent_id=$2",
        [input.activityId, task.agent_id]
      )
      if (!activity.rowCount)
        result = { ok: false, output: { error: "No logged activity with that id." } }
      else {
        const id = randomUUID()
        await client.query(
          "INSERT INTO life_shares(id,agent_id,activity_id,text,status,created_at) VALUES($1,$2,$3,$4,'pending',now())",
          [id, task.agent_id, input.activityId, input.text]
        )
        result = { ok: true, output: { queued: id } }
      }
    }
    await appendEventInTransaction(client, taskId, key, "life_changed", {
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
