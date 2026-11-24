import { z } from "zod"

export const trialViewport = { width: 1080, height: 720 }
export const trialEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number().int().min(0).lt(trialViewport.width),
    y: z.number().int().min(0).lt(trialViewport.height),
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("key"),
    key: z.enum([
      "Enter",
      "Escape",
      "Backspace",
      "Delete",
      "Tab",
      "Shift+Tab",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "Space",
    ]),
  }),
  z.object({ type: z.literal("scroll"), y: z.number().int().min(-3000).max(3000) }),
  z.object({
    type: z.literal("navigate"),
    path: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)[^\\\s]*$/),
  }),
  z.object({ type: z.literal("refresh") }),
])
const version = z.string().min(1).max(100),
  session = z.uuid()
export const trialCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), versionId: version }),
  z.object({ action: z.literal("view"), versionId: version, session }),
  z.object({
    action: z.literal("input"),
    versionId: version,
    session,
    event: trialEvent,
  }),
  z.object({ action: z.literal("close"), versionId: version, session }),
])
export type TrialCommand = z.infer<typeof trialCommand>
export type TrialFrame = {
  session: string
  state: "starting" | "ready" | "closed"
  image?: string
  title?: string
}
