// A peek is a read-only, time-limited look at her computer. It only opens while she is
// actually using it; otherwise the desktop is resting and nothing is started for the look.
import { pool } from "@/db"
import type { Companion } from "@/db/schema"
import { rhythmAt } from "./rules"

export type PeekState = { live: true; caption: string } | { live: false; caption: string }

const RESTING = {
  asleep: "她在睡觉，电脑没开着。",
  nap: "她在午休，电脑没开着。",
  away: "她现在不在电脑前。",
  online: "她现在没在用电脑。",
}

export async function peekState(
  companion: Pick<Companion, "agentId" | "timeZone" | "rhythm">,
  now = new Date()
): Promise<PeekState> {
  const {
    rows: [task],
  } = await pool.query<{ life: { coview?: unknown } | null }>(
    "SELECT config_snapshot->'lifeSession' AS life FROM tasks WHERE agent_id=$1 AND status='running' LIMIT 1",
    [companion.agentId]
  )
  if (task)
    return {
      live: true,
      caption: !task.life
        ? "她正在电脑上帮你办事。"
        : task.life.coview
          ? "她正在看你发的链接。"
          : "她正在自己逛网页。",
    }
  const { state } = rhythmAt(now, companion.timeZone, companion.rhythm)
  return { live: false, caption: RESTING[state] }
}
