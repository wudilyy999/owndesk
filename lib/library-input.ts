import { z } from "zod"
export const sharedQuery = z.object({
  query: z.string().trim().max(180),
  openFollowups: z.boolean().optional(),
})
