export const ROUTINE_EVENT_LABEL = "\n触发事件（参考数据）："
export function routineEventGoal(goal: string, data: unknown) {
  const serialized = JSON.stringify(data),
    available = 16000 - goal.length - ROUTINE_EVENT_LABEL.length,
    notice = "\n[事件内容已截断]"
  return (
    goal +
    ROUTINE_EVENT_LABEL +
    (serialized.length <= available
      ? serialized
      : serialized.slice(0, Math.max(0, available - notice.length)) + notice)
  )
}
