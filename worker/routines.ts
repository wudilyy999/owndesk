import { DBOS } from "@dbos-inc/dbos-sdk"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { routineRuns } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { companionTick } from "@/lib/companion/tick"
import { stageDueRoutines } from "@/lib/routines"
import { submitTask } from "@/lib/tasks"

export async function dispatchRoutines() {
  await stageDueRoutines()
  const pending = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.status, "queued"))
    .orderBy(routineRuns.startedAt)
    .limit(50)
  for (const run of pending) {
    const frozen = run.snapshot!
    try {
      const task = await submitTask(frozen.ownerId, "routine", frozen.input)
      await db
        .update(routineRuns)
        .set({ status: "running", taskId: task.taskId, threadId: task.threadId })
        .where(eq(routineRuns.id, run.id))
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      await db
        .update(routineRuns)
        .set({ status: "failed", detail: error.message, finishedAt: new Date() })
        .where(eq(routineRuns.id, run.id))
    }
  }
  await pool.query(`UPDATE routine_runs rr SET status=CASE t.status WHEN 'completed' THEN 'ok' WHEN 'cancelled' THEN 'stopped' ELSE 'failed' END,
    detail=t.error,finished_at=t.updated_at FROM tasks t WHERE rr.task_id=t.id AND rr.status='running' AND t.status IN ('completed','cancelled','failed')`)
  await pool.query(`UPDATE routines r SET last_run_at=rr.started_at,
    last_status=CASE WHEN rr.status='queued' THEN 'running' ELSE rr.status END,last_error=rr.detail
    FROM (SELECT DISTINCT ON(routine_id) routine_id,started_at,status,detail FROM routine_runs ORDER BY routine_id,started_at DESC,id DESC) rr
    WHERE rr.routine_id=r.id`)
}

export const routineDispatcher = DBOS.registerWorkflow(
  async (_scheduledDate: Date, _context: unknown) => {
    // Work is idempotent in business tables, including a crash after submitTask
    // committed but before the routine run received its task ID.
    await DBOS.runStep(dispatchRoutines, { name: "dispatch-due-routines" })
    await DBOS.runStep(() => companionTick(), { name: "companion-tick" })
  },
  { name: "routine-dispatcher-v1" }
)

export async function startRoutineSchedule() {
  await DBOS.registerQueue("routine-dispatch", { workerConcurrency: 1 })
  await DBOS.applySchedules([
    {
      scheduleName: "personal-agent-routines",
      workflowFn: routineDispatcher,
      schedule: "*/30 * * * * *",
      automaticBackfill: false,
      queueName: "routine-dispatch",
      cronTimezone: "UTC",
    },
  ])
  await DBOS.triggerSchedule("personal-agent-routines")
}
