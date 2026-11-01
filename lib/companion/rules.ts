// Pure scheduling rules for a companion's life sessions and shares (no database access).
import type { Companion } from "@/db/schema"

const SLOT_GRACE_MINUTES = 120
const SHARE_SPACING_MS = 2 * 3600_000
const SHARE_EXPIRY_MS = 24 * 3600_000

function localClock(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

// Slots of today whose time has passed within the grace window. A slot missed by longer
// (worker down) is dropped instead of starting a stale session.
export function dueLifeSlots(now: Date, timeZone: string, times: string[]) {
  const { date, minutes } = localClock(now, timeZone)
  return times
    .filter((slot) => {
      const late = minutes - toMinutes(slot)
      return late >= 0 && late <= SLOT_GRACE_MINUTES
    })
    .map((slot) => ({ date, slot }))
}

// Quiet hours may wrap midnight (23:00 → 08:00)
export function inQuietHours(now: Date, timeZone: string, start: string, end: string) {
  const { minutes } = localClock(now, timeZone)
  const from = toMinutes(start)
  const to = toMinutes(end)
  if (from === to) return false
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

export type ShareDecision = { send: true } | { send: false; skip?: string }

export function decideShare(input: {
  now: Date
  companion: Pick<
    Companion,
    "sharesPaused" | "maxSharesPerDay" | "quietStart" | "quietEnd" | "timeZone"
  >
  createdAt: Date
  sentToday: number
  lastSentAt: Date | null
}): ShareDecision {
  const { now, companion } = input
  if (now.getTime() - input.createdAt.getTime() > SHARE_EXPIRY_MS)
    return { send: false, skip: "expired" }
  if (companion.sharesPaused) return { send: false }
  if (input.sentToday >= companion.maxSharesPerDay) return { send: false }
  if (inQuietHours(now, companion.timeZone, companion.quietStart, companion.quietEnd))
    return { send: false }
  if (input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < SHARE_SPACING_MS)
    return { send: false }
  return { send: true }
}

export function lifeBudgetForSession(input: {
  sessionMaxSteps: number
  dailyBudgetMicros: number
  spentTodayMicros: number
}) {
  const remaining = input.dailyBudgetMicros - input.spentTodayMicros
  return remaining > 0
    ? { maxSteps: input.sessionMaxSteps, maxCostMicros: remaining }
    : null
}
