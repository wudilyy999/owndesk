// Adapted from the pinned MIT upstream lib/schedule.ts (MIT): schedule labels and weekday choices.
import type { RoutineSchedule } from "@/db/schema"

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

export function describeSchedule(schedule: RoutineSchedule) {
  switch (schedule.kind) {
    case "daily":
      return `每天 ${schedule.time}`
    case "weekdays":
      return `工作日 ${schedule.time}`
    case "weekly":
      return `每${WEEKDAYS[schedule.day]} ${schedule.time}`
    case "hourly":
      return `每 ${schedule.every} 小时`
    case "once":
      return `一次性 ${schedule.at.replace("T", " ")}`
  }
}
