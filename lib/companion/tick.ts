import { startCoviews, syncCoviews } from "./coview"
import { deliverShares, startLifeSessions, stopStalledSessions } from "./life"
import { stopStalledErrands, syncErrands } from "./errands"
import { purgeImages } from "./images"
import { organizeTick } from "./consolidate"
import { pushTick } from "./push"

// Called by the worker's 30-second dispatcher
export async function companionTick(now = new Date()) {
  await syncErrands()
  await stopStalledSessions()
  await stopStalledErrands(now)
  await syncCoviews(now)
  for (const task of await startCoviews(now))
    console.info(`co-view session started: ${task}`)
  const { started, skipped } = await startLifeSessions(now)
  for (const task of started) console.info(`life session started: ${task}`)
  for (const skip of skipped) console.info(`life session skipped: ${skip.reason}`)
  await deliverShares(now)
  await purgeImages(now)
  try {
    for (const result of await pushTick(now))
      console.info(
        `web push ${result.agentId}: ${result.sent} sent to ${result.devices} devices, ${result.skipped} skipped`
      )
  } catch (error) {
    // A push service outage must not stop her other background work
    console.error("web push tick failed", (error as Error).message)
  }
  for (const { agentId, result } of await organizeTick(now))
    console.info(
      `memory tidy-up ${agentId}: ${result.changes} changes in ${result.pages} pages`
    )
}
