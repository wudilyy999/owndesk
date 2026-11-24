// Shared calendar inputs for routines and long-running objectives.
import { Input } from "@/components/ui/input"
import { WEEKDAYS } from "@/lib/schedule"
import type { ObjectiveSchedule, RoutineSchedule } from "@/db/schema"
const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm"
export function ScheduleFields({
  draft,
  set,
}: {
  draft: ObjectiveSchedule
  set: <K extends keyof ObjectiveSchedule>(key: K, value: ObjectiveSchedule[K]) => void
}) {
  return (
    <>
      <label className="space-y-2 text-sm">
        计划类型
        <select
          aria-label="计划类型"
          className={selectClass}
          value={draft.schedule.kind}
          onChange={(e) => {
            const kind = e.target.value as RoutineSchedule["kind"]
            set(
              "schedule",
              kind === "once"
                ? { kind, at: "" }
                : kind === "hourly"
                  ? { kind, every: 6 }
                  : kind === "weekly"
                    ? { kind, day: 1, time: "09:00" }
                    : { kind, time: "09:00" }
            )
          }}
        >
          <option value="daily">每天</option>
          <option value="weekdays">工作日</option>
          <option value="weekly">每周</option>
          <option value="hourly">每隔几小时</option>
          <option value="once">一次性</option>
        </select>
      </label>
      <label className="space-y-2 text-sm">
        IANA 时区
        <Input
          required
          value={draft.timeZone}
          onChange={(e) => set("timeZone", e.target.value)}
          placeholder="Asia/Taipei"
        />
      </label>
      {draft.schedule.kind === "once" ? (
        <label className="space-y-2 text-sm">
          当地日期与时间
          <input
            required
            type="datetime-local"
            className={selectClass}
            value={draft.schedule.at}
            onChange={(e) =>
              set("schedule", { kind: "once", at: e.target.value.slice(0, 16) })
            }
          />
        </label>
      ) : draft.schedule.kind === "hourly" ? (
        <label className="space-y-2 text-sm">
          间隔小时
          <Input
            required
            type="number"
            min={1}
            max={24}
            value={draft.schedule.every}
            onChange={(e) =>
              set("schedule", { kind: "hourly", every: Number(e.target.value) })
            }
          />
        </label>
      ) : (
        <label className="space-y-2 text-sm">
          当地时间
          <input
            required
            type="time"
            className={selectClass}
            value={draft.schedule.time}
            onChange={(e) =>
              set("schedule", {
                ...draft.schedule,
                time: e.target.value,
              } as RoutineSchedule)
            }
          />
        </label>
      )}
      {draft.schedule.kind === "weekly" && (
        <label className="space-y-2 text-sm">
          星期
          <select
            aria-label="星期"
            className={selectClass}
            value={draft.schedule.day}
            onChange={(e) =>
              set("schedule", {
                ...draft.schedule,
                day: Number(e.target.value),
              } as RoutineSchedule)
            }
          >
            {WEEKDAYS.map((name, day) => (
              <option key={day} value={day}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="space-y-2 text-sm">
        漏跑策略
        <select
          aria-label="漏跑策略"
          className={selectClass}
          value={draft.missedRunPolicy}
          onChange={(e) =>
            set("missedRunPolicy", e.target.value as ObjectiveSchedule["missedRunPolicy"])
          }
        >
          <option value="latest">只补最近一次</option>
          <option value="skip">跳过延迟超过 60 秒的触发</option>
        </select>
      </label>
    </>
  )
}
