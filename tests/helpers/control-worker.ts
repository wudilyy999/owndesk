import { DBOS } from "@dbos-inc/dbos-sdk"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { tasks } from "@/db/schema"
import { TASK_WORKFLOW } from "@/lib/durable"
import { acquireWorkspace, releaseWorkspace, TaskCancelled } from "@/lib/workstation"
import { executeAction } from "@/worker/actions"
import { startWorker } from "@/worker/server"

// Deterministic orchestration uses the production lease, controller, actions and control loop.
// Only the model's decisions are replaced; no production fault-injection switches are needed.
DBOS.registerWorkflow(
  async (taskId: string) => {
    const task = await DBOS.runStep(
      async () => {
        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
        return {
          id: row.id,
          agentId: row.agentId,
          activeSegment: row.activeSegment,
          goal: row.goal,
        }
      },
      { name: "test-load-task" }
    )
    try {
      await DBOS.runStep(
        async () => {
          const workspace = await acquireWorkspace(task)
          return { epoch: workspace.epoch } // Credentials never enter DBOS step records.
        },
        { name: "test-acquire" }
      )
      if (task.goal === "background" || task.goal === "active-shell") {
        const command =
          task.goal === "background"
            ? `setsid bash -c 'while true; do date +%s%N >> /home/agent/control-heartbeat; sleep 0.1; done' </dev/null >/dev/null 2>&1 & echo started`
            : `while true; do date +%s%N >> /home/agent/control-heartbeat; sleep 0.1; done`
        await DBOS.runStep(
          () => executeAction(taskId, 1, 1, "shell", { command, timeout: 600 }),
          { name: "test-shell" }
        )
      }
      if (task.goal === "download" || task.goal === "unknown-submit") {
        await pool.query("UPDATE tasks SET result=$2 WHERE id=$1", [
          taskId,
          JSON.stringify({ fixtureReady: true }),
        ])
        await DBOS.recv("fixture-go", { timeoutSeconds: 120 })
        if (task.goal === "download") {
          const opened = await DBOS.runStep(
            () =>
              executeAction(taskId, 1, 1, "browser_open", {
                url: "http://127.0.0.1:8082/",
              }),
            { name: "test-open" }
          )
          const observed = await DBOS.runStep(
            () =>
              executeAction(taskId, 1, 2, "browser_observe", {
                pageId: opened.output.pageId,
              }),
            { name: "test-observe" }
          )
          const elements = observed.output.elements as { ref: string; name: string }[]
          const result = await DBOS.runStep(
            () =>
              executeAction(taskId, 1, 3, "browser_download", {
                pageId: opened.output.pageId,
                observationId: observed.output.observationId,
                ref: elements.find((e) => e.name === "Download")!.ref,
              }),
            { name: "test-effect" }
          )
          if (!result.ok) throw new Error(JSON.stringify(result))
          await DBOS.runStep(
            async () => {
              await releaseWorkspace(taskId, task.agentId)
              await pool.query(
                "UPDATE tasks SET status='completed',result=$2 WHERE id=$1",
                [taskId, JSON.stringify(result.output)]
              )
            },
            { name: "test-complete" }
          )
          return
        }
        const result = await DBOS.runStep(
          () =>
            executeAction(taskId, 1, 3, "shell", {
              command: "curl --max-time 600 -X POST http://127.0.0.1:8082/submit",
              timeout: 650,
            }),
          { name: "test-effect" }
        )
        if (!result.needsReview)
          throw new Error("An interrupted submit must wait for review")
      }
      await pool.query(
        "UPDATE tasks SET result=COALESCE(result,'{}'::jsonb)||'{\"fixtureReady\":true}'::jsonb WHERE id=$1",
        [taskId]
      )
      await DBOS.recv("fixture-end", { timeoutSeconds: 86400 })
    } catch (error) {
      if (error instanceof TaskCancelled) {
        await DBOS.recv("cancellation-confirmed", { timeoutSeconds: 86400 })
        return
      }
      throw error
    }
  },
  { name: TASK_WORKFLOW }
)

await startWorker()
