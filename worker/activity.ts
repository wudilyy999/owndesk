import { pool } from "@/db"
import { TaskCancelled } from "@/lib/workstation"

const activity = new Map<string, Set<Promise<unknown>>>()
const aborters = new Map<string, Set<AbortController>>()

export async function trackActivity<T>(
  taskId: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const active = activity.get(taskId) ?? new Set<Promise<unknown>>()
  activity.set(taskId, active)
  const controller = new AbortController()
  const controls = aborters.get(taskId) ?? new Set<AbortController>()
  aborters.set(taskId, controls)
  controls.add(controller)
  const running = (async () => {
    const claim = await pool.query(
      "UPDATE tasks SET status=CASE WHEN status='queued' THEN 'running' ELSE status END WHERE id=$1 AND cancel_requested_at IS NULL AND status<>'cancelled' RETURNING id",
      [taskId]
    )
    if (!claim.rowCount) throw new TaskCancelled()
    return operation(controller.signal)
  })()
  active.add(running)
  try {
    return await running
  } finally {
    active.delete(running)
    if (!active.size) activity.delete(taskId)
    controls.delete(controller)
    if (!controls.size) aborters.delete(taskId)
  }
}

export function abortTaskActivity(taskId: string) {
  for (const controller of aborters.get(taskId) ?? [])
    controller.abort(new TaskCancelled())
}

export async function waitForHostActivity(taskId: string) {
  while (activity.has(taskId)) await Promise.allSettled([...activity.get(taskId)!])
}
