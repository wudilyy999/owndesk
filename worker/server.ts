import { DBOS } from "@dbos-inc/dbos-sdk"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { workstationControl } from "@/db/schema"
import { env } from "@/lib/env"
import {
  APPLICATION_NAME,
  APPLICATION_VERSION,
  closeDurableClient,
  TASK_QUEUE,
} from "@/lib/durable"
import {
  controller,
  ensureWorkstation,
  quiesceWorkstation,
  workspaceRow,
  withWorkspaceOperation,
  stopInstallationWorkstations,
  sweepIdleWorkstations,
} from "@/lib/workstation"
import { processControlRequests, waitForControlRequests } from "./control"
import { attachDesktopGateway } from "./desktop-gateway"
import { runTelegram } from "@/lib/telegram/bridge"
import { resumeMonthlyBudgets } from "./budgets"
import { startRoutineSchedule } from "./routines"
import { sweepVault } from "@/lib/vault"
import { assertWorkstationNetwork } from "./network"

export async function startWorker() {
  await assertWorkstationNetwork()
  const lease = await pool.connect()
  let failing = false
  async function failStop(error: unknown) {
    if (failing) return
    failing = true
    console.error(
      "Worker control or database lease failed; stopping installation workstations",
      error
    )
    try {
      await stopInstallationWorkstations()
    } catch (stopError) {
      console.error(
        "Emergency workstation stop failed; operator intervention required",
        stopError
      )
    }
    process.exit(1)
  }
  lease.on("error", (error) => {
    void failStop(error)
  })
  const {
    rows: [lock],
  } = await lease.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(71261197) AS acquired"
  )
  if (!lock.acquired)
    throw new Error("Another worker owns this database; only one worker is supported")
  await pool.query(
    "UPDATE task_model_attempts SET status='unknown',error='Worker stopped during model request' WHERE status='pending'"
  )

  // Fence surviving workstation processes before DBOS replays any task.
  for (const workspace of await db.select().from(workstationControl)) {
    if (!workspace.activeTaskId || workspace.mode === "quarantined") continue
    const shell = await pool.query(
      "SELECT 1 FROM task_actions WHERE task_id=$1 AND kind='shell' AND boot_id=$2 LIMIT 1",
      [workspace.activeTaskId, workspace.bootId]
    )
    if (!shell.rowCount) await ensureWorkstation(workspace.agentId)
    await withWorkspaceOperation(workspace.agentId, async () => {
      const row = await workspaceRow(workspace.agentId)
      const epoch = row.epoch + 1
      await db
        .update(workstationControl)
        .set({ mode: "quiescing", epoch, updatedAt: new Date() })
        .where(eq(workstationControl.agentId, row.agentId))
      const quiet = await quiesceWorkstation(row.agentId, epoch, true, !!shell.rowCount)
      const mode = row.mode === "human" && !row.desiredMode ? "human" : "idle"
      await controller(row.agentId, "/control", { epoch: epoch + 1, mode })
      await db
        .update(workstationControl)
        .set({
          mode,
          epoch: epoch + 1,
          bootId: quiet.bootId,
          activeActionId: null,
          updatedAt: new Date(),
        })
        .where(eq(workstationControl.agentId, row.agentId))
    })
  }

  DBOS.setConfig({
    name: APPLICATION_NAME,
    systemDatabaseUrl: env.DATABASE_URL,
    applicationVersion: APPLICATION_VERSION,
    executorID: "primary",
    logLevel: "info",
    useListenNotify: true,
  })
  await DBOS.launch()
  await DBOS.registerQueue(TASK_QUEUE, {
    partitionConcurrency: 1,
    workerConcurrency: 4,
    minPollingIntervalMs: 200,
  })
  await startRoutineSchedule()
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end()
      return
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ready: true, version: APPLICATION_VERSION }))
  })
  const closeGateway = attachDesktopGateway(server)
  const listenHost =
    env.WORKER_HOST === "127.0.0.1" && !env.WORKSTATION_NETWORK ? "::" : env.WORKER_HOST
  server.listen(env.WORKER_PORT, listenHost, () =>
    console.log(`Worker ready on ${listenHost}:${env.WORKER_PORT}`)
  )
  const abort = new AbortController()
  const controls = (async () => {
    let lastBudgetCheck = 0
    while (!abort.signal.aborted) {
      await processControlRequests()
      if (Date.now() - lastBudgetCheck >= 5000) {
        await resumeMonthlyBudgets()
        await sweepVault()
        lastBudgetCheck = Date.now()
      }
      await delay(250, undefined, { signal: abort.signal })
    }
  })().catch(async (error) => {
    if (!abort.signal.aborted) await failStop(error)
  })
  const telegram = runTelegram(abort.signal).catch(async (error) => {
    if (!abort.signal.aborted) await failStop(error)
  })
  const idleWorkstations = (async () => {
    while (!abort.signal.aborted) {
      const stopped = await sweepIdleWorkstations()
      if (stopped.length) console.log("Idle workstations stopped", stopped)
      await delay(30000, undefined, { signal: abort.signal })
    }
  })().catch(async (error) => {
    if (abort.signal.aborted && (error as NodeJS.ErrnoException).code === "ABORT_ERR")
      return
    await failStop(error)
  })

  async function shutdown() {
    server.close()
    abort.abort()
    await closeGateway()
    await controls
    await telegram
    await idleWorkstations
    await stopInstallationWorkstations()
    await waitForControlRequests()
    await DBOS.shutdown({ workflowCompletionTimeoutMS: 1000 })
    await closeDurableClient()
    lease.release()
    await pool.end()
    process.exit(0)
  }
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)
}
