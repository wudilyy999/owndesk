// Only promote explicit, unquoted fields. Keep the original statement and its source.
// Newest referenced statement wins; free-form prose stays on the timeline.
export function projectFacts(events: { body: string; origin: string; at: Date }[]) {
  const facts = new Map<
    string,
    { field: string; value: string; origin: string; at: Date }
  >()
  for (const event of events) {
    for (const line of event.body.split(/\r?\n/)) {
      if (
        /^\s*(?:On .+ wrote:|在.+写道[：:]|[-]+\s*(?:Original Message|Forwarded message)|发件人[：:])/i.test(
          line
        )
      )
        break
      const match =
        /^\s*(?:[-*]\s*)?(?:最新|当前|新的?)?(报价|付款期限|交付日期|联系人|项目状态|截止日期)\s*(?:[:：]|(?:现已|已经|现)?(?:调整为|更新为|改为|确定为|为|是))\s*(.{1,160})$/u.exec(
          line
        )
      if (match && !facts.has(match[1]))
        facts.set(match[1], {
          field: match[1],
          value: match[2].trim(),
          origin: event.origin,
          at: event.at,
        })
    }
  }
  return [...facts.values()]
}
