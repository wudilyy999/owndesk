import { DBOS } from "@dbos-inc/dbos-sdk"
import { pool } from "@/db"
import { TASK_WORKFLOW } from "@/lib/durable"
import { appendEventInTransaction } from "@/lib/task-events"
import { runAgent } from "./runtime"
import { runFixture } from "./fixture"

export const taskSegment = DBOS.registerWorkflow(
  async (taskId: string, segmentNo: number) => {
    try {
      const runtime = await DBOS.runStep(
        async () => {
          const {
            rows: [task],
          } = await pool.query<{ config_snapshot: { runtime: string } }>(
            "SELECT config_snapshot FROM tasks WHERE id=$1",
            [taskId]
          )
          return task.config_snapshot.runtime
        },
        { name: "select-task-runtime" }
      )
      return runtime === "fixture"
        ? await runFixture(taskId, segmentNo)
        : await runAgent(taskId, segmentNo)
    } catch (error) {
      const cancellation = await DBOS.runStep(
        async () => {
          const {
            rows: [task],
          } = await pool.query<{
            cancel_requested_at: Date | null
            status: string
            active_segment: number
          }>("SELECT cancel_requested_at,status,active_segment FROM tasks WHERE id=$1", [
            taskId,
          ])
          return {
            requested: !!task.cancel_requested_at,
            confirmed: task.status === "cancelled",
            superseded: task.active_segment !== segmentNo,
          }
        },
        { name: "check-cancellation-before-failure" }
      )
      if (cancellation.confirmed) return { cancelled: true }
      if (cancellation.superseded) return { delegated: true }
      if (cancellation.requested) {
        // The control worker cancels this workflow only after real operations have stopped.
        await DBOS.recv("cancellation-confirmed", { timeoutSeconds: 86400 })
        return { cancelled: true }
      }
      await DBOS.runStep(
        async () => {
          const client = await pool.connect()
          try {
            await client.query("BEGIN")
            const message = error instanceof Error ? error.message : String(error)
            await client.query(
              "UPDATE tasks SET status='failed', error=$2, updated_at=now() WHERE id=$1",
              [taskId, message]
            )
            await appendEventInTransaction(
              client,
              taskId,
              `failed:${segmentNo}`,
              "failed",
              { error: message }
            )
            await client.query("COMMIT")
          } catch (recordError) {
            await client.query("ROLLBACK")
            throw recordError
          } finally {
            client.release()
          }
        },
        { name: "record-task-failure" }
      )
      throw error
    }
  },
  { name: TASK_WORKFLOW }
)
