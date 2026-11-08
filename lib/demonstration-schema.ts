import { z } from "zod"
export const demonstrationEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pointer"),
    button: z.number().int().min(0).max(4),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]) }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "F2",
    ]),
    ctrl: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  }),
  z.object({ kind: z.literal("protected_input") }),
  z.object({ kind: z.literal("checkpoint"), note: z.string().trim().min(1).max(500) }),
])
export type DemonstrationEvent = z.infer<typeof demonstrationEventSchema>
export type RecordedDemonstrationEvent = DemonstrationEvent & {
  seq: number
  application: string | null
}
export function demonstrationDraft(name: string, events: RecordedDemonstrationEvent[]) {
  return {
    name,
    description: `用户示范：${name}`.slice(0, 500),
    body:
      `适用场景：${name}\n\n使用前确认当前应用和所需文件。按下面的观察与动作重新定位控件；按新的任务要求填写输入。\n\n` +
      events
        .map(
          (event, index) =>
            `${index + 1}. ${event.application ? `在 ${event.application} 中，` : ""}${event.kind === "checkpoint" ? event.note : event.kind === "pointer" ? "点击目标控件（请补充控件名称与操作目的）。" : event.kind === "scroll" ? `向${event.direction === "up" ? "上" : "下"}滚动并观察目标。` : event.kind === "key" ? `按 ${[event.ctrl ? "Ctrl" : null, event.alt ? "Alt" : null, event.shift ? "Shift" : null, event.key].filter(Boolean).join("+")}，核对界面结果。` : "此处涉及输入或受保护步骤；执行时询问所需值，私有输入由用户完成。"}`
        )
        .join("\n") +
      "\n\n验收：补充可直接核对的文件、内容或界面结果。遇到不同界面先重新观察；不明确的外部效果先核对再继续。",
  }
}
