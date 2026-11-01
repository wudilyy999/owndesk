import { deliverShares, startLifeSessions } from "./life"
import { syncErrands } from "./errands"

// Called by the worker's 30-second dispatcher
export async function companionTick(now = new Date()) {
  await syncErrands()
  const { started, skipped } = await startLifeSessions(now)
  for (const task of started) console.info(`life session started: ${task}`)
  for (const skip of skipped) console.info(`life session skipped: ${skip.reason}`)
  await deliverShares(now)
}
