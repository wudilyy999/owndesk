import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import type { Task } from "@/db/schema"
import { googleTools } from "@/lib/google-connection"
import { connectionCallSchema } from "@/lib/connection-schema"
import {
  callConnection,
  connectionRow,
  validateConnectionArguments,
} from "@/lib/connections"
import { appendEventInTransaction } from "@/lib/task-events"
import { assertAgentControl, TaskCancelled, SegmentSuperseded } from "@/lib/workstation"
import { createTaskRequest } from "./requests"
import { finishAction, requestReview, type ActionResult } from "./actions"

export async function executeConnectionTool(
  task: Task,
  segmentNo: number,
  actionNo: number,
  raw: unknown,
  epoch: number,
  ownerMessageSeq?: number
): Promise<ActionResult & { requestId?: string }> {
  const input = connectionCallSchema.parse(raw),
    reference = task.configSnapshot.connections?.find(
      (item) => item.id === input.connectionId
    ),
    tool = reference?.tools.find((item) => item.name === input.tool)
  if (!reference || !tool)
    return {
      ok: false,
      output: { error: "This connection/tool is not enabled for this task" },
    }
  validateConnectionArguments(tool, input.args)
  const key = [task.id, segmentNo, actionNo],
    requestId = `${task.id}-s${segmentNo}-a${actionNo}-connection`
  const previous = (
    await pool.query<{
      status: string
      input: unknown
      receipt: ActionResult
      dispatch_started_at: Date | null
    }>(
      `SELECT a.status,a.input,a.receipt,b.dispatch_started_at FROM task_actions a JOIN task_action_attempts b USING(task_id,segment_no,action_no) WHERE a.task_id=$1 AND a.segment_no=$2 AND a.action_no=$3 ORDER BY b.attempt_no DESC LIMIT 1`,
      key
    )
  ).rows[0]
  if (previous) {
    if (!isDeepStrictEqual(previous.input, input))
      throw new Error("Connection action ID reused with different input")
    if (["succeeded", "failed"].includes(previous.status)) return previous.receipt
    if (previous.dispatch_started_at || previous.status === "unknown")
      return requestReview(
        task.id,
        segmentNo,
        actionNo,
        task.agentId,
        "connection_call",
        "Connection response was interrupted. Inspect the service before continuing; this call will not be resent."
      )
  }
  const current = await connectionRow(task.ownerId, reference.id)
  if (!current.enabled || current.revision !== reference.revision)
    return {
      ok: false,
      output: { error: "Connection changed; start a new task after checking Settings" },
    }
  // Recompute from the built-in adapter, not cached or server-supplied flags.
  // This also fences tasks snapshotted before MCP annotation hardening.
  const readOnly =
    current.kind === "google" &&
    googleTools.some((known) => known.name === input.tool && known.readOnly)
  if (!readOnly) {
    const request = (
      await pool.query<{ status: string; decision: string; payload: { input: unknown } }>(
        "SELECT status,decision,payload FROM task_requests WHERE id=$1 AND task_id=$2",
        [requestId, task.id]
      )
    ).rows[0]
    if (!request) {
      await createTaskRequest(task.id, segmentNo, requestId, "approval", {
        purpose: "connection_call",
        question: `允许 ${reference.name} 执行 ${input.tool}？`,
        input,
        connectionRevision: reference.revision,
      })
      return { ok: true, requestId, output: { waitingForOwner: true } }
    }
    if (!isDeepStrictEqual(request.payload.input, input))
      throw new Error("Connection approval input changed")
    if (request.status !== "resolved")
      return { ok: true, requestId, output: { waitingForOwner: true } }
    if (request.decision !== "approve")
      return { ok: false, output: { error: "Owner declined this connection call" } }
  }
  const control = await assertAgentControl(task.id, task.agentId, segmentNo)
  // A connection approval binds exact arguments/revision, independently of GUI observations.
  if (!readOnly) epoch = control.epoch
  if (control.epoch !== epoch)
    return {
      ok: false,
      stale: true,
      output: { error: "Control changed before the connection call" },
    }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [state],
    } = await client.query<{ cancel_requested_at: Date | null; active_segment: number }>(
      "SELECT cancel_requested_at,active_segment FROM tasks WHERE id=$1 FOR UPDATE",
      [task.id]
    )
    if (state.cancel_requested_at) throw new TaskCancelled()
    if (state.active_segment !== segmentNo) throw new SegmentSuperseded()
    if (
      ownerMessageSeq !== undefined &&
      (
        await client.query(
          "SELECT 1 FROM task_events WHERE task_id=$1 AND type='owner_supplement' AND seq>$2 LIMIT 1",
          [task.id, ownerMessageSeq]
        )
      ).rowCount
    ) {
      await client.query("COMMIT")
      return {
        ok: false,
        stale: true,
        output: { error: "Read new owner instructions before calling the connection" },
      }
    }
    const active = await client.query(
      "SELECT id FROM app_connections WHERE id=$1 AND enabled=true AND revision=$2 FOR SHARE",
      [reference.id, reference.revision]
    )
    if (!active.rowCount) {
      await client.query("COMMIT")
      return {
        ok: false,
        stale: true,
        output: { error: "Connection changed before dispatch" },
      }
    }
    const dispatchId = `${task.id}-s${segmentNo}-a${actionNo}`
    if (!previous) {
      await client.query(
        "INSERT INTO task_actions(task_id,segment_no,action_no,dispatch_id,epoch,boot_id,kind,input,effect_class,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'connection_call',$7,$8,'intent',now())",
        [
          ...key,
          dispatchId,
          epoch,
          control.bootId,
          JSON.stringify(input),
          readOnly ? "read" : "ambiguous",
        ]
      )
      await client.query(
        "INSERT INTO task_action_attempts(task_id,segment_no,action_no,attempt_no,dispatch_id,epoch,boot_id,status,created_at) VALUES($1,$2,$3,1,$4,$5,$6,'intent',now())",
        [...key, dispatchId, epoch, control.bootId]
      )
    }
    await client.query(
      "UPDATE task_action_attempts SET dispatch_started_at=now() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=1",
      key
    )
    await appendEventInTransaction(
      client,
      task.id,
      `action:${segmentNo}:${actionNo}`,
      "tool_started",
      {
        segmentNo,
        actionNo,
        tool: "connection_call",
        connection: reference.name,
        name: input.tool,
      }
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  let output: Record<string, unknown>
  try {
    output = (await callConnection(
      task.ownerId,
      reference.id,
      reference.revision,
      input.tool,
      input.args
    )) as Record<string, unknown>
    if (!readOnly && output.isError)
      return requestReview(
        task.id,
        segmentNo,
        actionNo,
        task.agentId,
        "connection_call",
        "Connection reported an error after dispatch; inspect the service result before continuing."
      )
  } catch (error) {
    if (!readOnly)
      return requestReview(
        task.id,
        segmentNo,
        actionNo,
        task.agentId,
        "connection_call",
        "Connection response was interrupted or rejected. Inspect the service result before continuing; this call will not be resent."
      )
    return finishAction(key, task.agentId, 1, {
      ok: false,
      output: {
        error: `Connection read failed (${error instanceof Error ? error.name : "Error"}); check the connection in Settings.`,
      },
    })
  }
  return finishAction(key, task.agentId, 1, { ok: output.isError !== true, output })
}
