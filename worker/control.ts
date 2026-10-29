import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { workstationControl } from "@/db/schema"
import { durableClient } from "@/lib/durable"
import { appendEventInTransaction } from "@/lib/task-events"
import {
  controller,
  quiesceWorkstation,
  withWorkspaceOperation,
  workspaceRow,
  stopWorkstationBoundary,
} from "@/lib/workstation"
import { revokeDesktop } from "./desktop-gateway"
import { waitForHostActivity, abortTaskActivity } from "./activity"

const controlJobs = new Map<string, Promise<void>>()
let controlFailure: unknown

export async function waitForControlRequests() {
  await Promise.all([...controlJobs.values()])
}

export async function processControlRequests() {
  if (controlFailure) throw controlFailure
  // One worker owns this poller. Per-workspace lifecycle latches also cover task acquisition.
  const pending = await db.select().from(workstationControl)
  for (const candidate of pending) {
    if (
      !candidate.desiredMode ||
      !candidate.activeTaskId ||
      controlJobs.has(candidate.agentId)
    )
      continue
    const job = withWorkspaceOperation(candidate.agentId, async () => {
      const row = await workspaceRow(candidate.agentId)
      if (!row.desiredMode || !row.activeTaskId) return
      const mode = row.desiredMode
      const epoch = row.epoch + 1
      try {
        await db
          .update(workstationControl)
          .set({ mode: "quiescing", epoch, updatedAt: new Date() })
          .where(eq(workstationControl.agentId, row.agentId))
        await revokeDesktop(row.agentId)
        if (mode === "cancelled") abortTaskActivity(row.activeTaskId)
        const quiet = await quiesceWorkstation(
          row.agentId,
          epoch,
          mode !== "cancelled",
          mode === "cancelled"
        )
        const nextEpoch = epoch + 1
        if (mode !== "cancelled")
          await controller(row.agentId, "/control", {
            epoch: nextEpoch,
            mode: mode === "human" ? "human" : "agent",
          })
        if (mode === "cancelled") await waitForHostActivity(row.activeTaskId)
        const durable = await durableClient()
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const {
            rows: [task],
          } = await client.query<{ cancel_requested_at: Date | null }>(
            "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
            [row.activeTaskId]
          )
          // A cancellation arriving during a handoff stays queued and fences any new action.
          const superseded = mode !== "cancelled" && !!task.cancel_requested_at
          await client.query(
            `UPDATE workstation_control SET mode=$2,epoch=$3,boot_id=$4,active_action_id=NULL,
            desired_mode=$5,request_id=$6,active_task_id=$7,active_segment=$8,last_error=NULL,updated_at=now() WHERE agent_id=$1`,
            [
              row.agentId,
              mode === "cancelled" ? "idle" : mode,
              nextEpoch,
              quiet.bootId,
              superseded ? "cancelled" : null,
              mode === "human" ? row.requestId : null,
              mode === "cancelled" ? null : row.activeTaskId,
              mode === "cancelled" ? null : row.activeSegment,
            ]
          )
          if (mode === "human") {
            await client.query(
              "UPDATE tasks SET status='waiting_user',updated_at=now() WHERE id=$1",
              [row.activeTaskId]
            )
            await appendEventInTransaction(
              client,
              row.activeTaskId,
              `human-ready:${row.requestId}`,
              "human_ready",
              {
                requestId: row.requestId,
                epoch: nextEpoch,
                coldReset: quiet.coldReset,
                message: quiet.coldReset
                  ? "Agent stopped. Workstation restarted after Shell use; files and browser profile are retained. Review the current page before continuing."
                  : "Agent input stopped. Human control is ready.",
              }
            )
          } else if (mode === "agent") {
            await client.query(
              "UPDATE tasks SET status='running',updated_at=now() WHERE id=$1",
              [row.activeTaskId]
            )
            await client.query(
              "UPDATE task_requests SET status='resolved',resolved_at=now() WHERE id=$1",
              [row.requestId]
            )
            await durable.sendInTransaction(
              client,
              `${row.activeTaskId}:${row.activeSegment}`,
              { requestId: row.requestId, decision: "handback", epoch: nextEpoch },
              row.requestId!,
              `handback:${row.requestId}`
            )
            await appendEventInTransaction(
              client,
              row.activeTaskId,
              `handback:${row.requestId}`,
              "control_returned",
              {
                epoch: nextEpoch,
                message:
                  "Human connection revoked. Observe again before the next action.",
              }
            )
          } else {
            await client.query(
              "UPDATE tasks SET status='cancelled',cancel_workflow_pending=true,updated_at=now() WHERE id=$1",
              [row.activeTaskId]
            )
            await client.query(
              "UPDATE task_requests SET status='cancelled',resolved_at=now() WHERE task_id=$1 AND status IN ('pending','decided')",
              [row.activeTaskId]
            )
            await client.query(
              "UPDATE task_actions SET status='unknown',finished_at=now() WHERE task_id=$1 AND status='intent'",
              [row.activeTaskId]
            )
            await appendEventInTransaction(
              client,
              row.activeTaskId,
              "cancelled",
              "cancelled",
              {
                coldReset: quiet.coldReset,
                message:
                  "Actual workstation operations stopped. Existing effects and files are retained.",
              }
            )
          }
          await client.query("COMMIT")
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      } catch (error) {
        // A quarantine label alone cannot stop a process. Confirm the host boundary first.
        try {
          await revokeDesktop(row.agentId)
          await stopWorkstationBoundary(row.agentId)
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            "Control failed and workstation containment could not be confirmed"
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        await db
          .update(workstationControl)
          .set({
            mode: "quarantined",
            desiredMode: null,
            lastError: message,
            updatedAt: new Date(),
          })
          .where(eq(workstationControl.agentId, row.agentId))
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          await client.query(
            "UPDATE tasks SET status='needs_review',error=$2,updated_at=now() WHERE id=$1",
            [row.activeTaskId, message]
          )
          await appendEventInTransaction(
            client,
            row.activeTaskId,
            `control-failed:${epoch}`,
            "needs_review",
            {
              message: "Workstation control could not be safely transferred",
              error: message,
            }
          )
          await client.query("COMMIT")
        } catch (recordError) {
          await client.query("ROLLBACK")
          throw recordError
        } finally {
          client.release()
        }
        console.error("Workstation control transfer failed", error)
      }
    })
    controlJobs.set(candidate.agentId, job)
    void job
      .catch((error) => {
        controlFailure = error
      })
      .finally(() => controlJobs.delete(candidate.agentId))
  }

  const { rows: withoutWorkstation } = await pool.query<{
    id: string
    active_segment: number
  }>(`SELECT t.id,t.active_segment FROM tasks t
    WHERE t.cancel_requested_at IS NOT NULL AND t.status NOT IN ('cancelled','completed','failed')
      AND NOT EXISTS(SELECT 1 FROM workstation_control w WHERE w.active_task_id=t.id)`)
  for (const task of withoutWorkstation) {
    abortTaskActivity(task.id)
    await waitForHostActivity(task.id)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "UPDATE tasks SET status='cancelled',cancel_workflow_pending=true,updated_at=now() WHERE id=$1 AND cancel_requested_at IS NOT NULL",
        [task.id]
      )
      await appendEventInTransaction(client, task.id, "cancelled", "cancelled", {
        message: "Task cancelled after local operations stopped",
      })
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
  const { rows: cancellations } = await pool.query<{
    id: string
    active_segment: number
  }>(
    "SELECT id,active_segment FROM tasks WHERE status='cancelled' AND cancel_workflow_pending=true"
  )
  for (const task of cancellations) {
    await (await durableClient()).cancelWorkflow(`${task.id}:${task.active_segment}`)
    await pool.query(
      "UPDATE tasks SET cancel_workflow_pending=false WHERE id=$1 AND status='cancelled'",
      [task.id]
    )
  }
}
