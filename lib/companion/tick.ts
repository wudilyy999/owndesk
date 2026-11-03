import { startCoviews, syncCoviews } from "./coview"
import { deliverShares, startLifeSessions, stopStalledSessions } from "./life"
import { syncErrands } from "./errands"
import { purgeImages } from "./images"

// Called by the worker's 30-second dispatcher
export async function companionTick(now = new Date()) {
  await syncErrands()
  await stopStalledSessions()
  await syncCoviews(now)
  for (const task of await startCoviews(now))
    console.info(`co-view session started: ${task}`)
  const { started, skipped } = await startLifeSessions(now)
  for (const task of started) console.info(`life session started: ${task}`)
  for (const skip of skipped) console.info(`life session skipped: ${skip.reason}`)
  await deliverShares(now)
  await purgeImages(now)
}
