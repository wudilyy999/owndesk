import { mail as email, mailText } from "./mail-text"
import { z } from "zod"
import { callConnection, connectionRow } from "@/lib/connections"
import { HttpError } from "@/lib/errors"
export type LibraryDraft = {
  title: string
  body: string
  origin: string
  thread?: string
  connection?: string
}
const calendar = z.object({
  items: z
    .array(
      z.object({
        summary: z.string().optional(),
        description: z.string().optional(),
        htmlLink: z.string().optional(),
        start: z
          .object({ date: z.string().optional(), dateTime: z.string().optional() })
          .optional(),
      })
    )
    .default([]),
})
export async function googleDrafts(
  owner: string,
  id: string,
  kind: "mail" | "calendar",
  query: string
): Promise<LibraryDraft[]> {
  const row = await connectionRow(owner, id)
  if (row.kind !== "google" || !row.enabled)
    throw new HttpError(409, "请先启用 Google 连接")
  const read = (tool: string, args: Record<string, unknown>) =>
    callConnection(owner, id, row.revision, tool, args)
  if (kind === "calendar") {
    const start = new Date(),
      end = new Date(start.getTime() + 7 * 86400000)
    const result = calendar.parse(
      await read("calendar_list", {
        calendarId: "primary",
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
      })
    )
    return result.items.slice(0, 10).map((e) => ({
      title: (e.summary || "日程").slice(0, 180),
      body: [e.start?.dateTime || e.start?.date, e.description?.replace(/<[^>]*>/g, " ")]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000),
      origin:
        e.htmlLink?.startsWith("https://www.google.com/calendar/") ||
        e.htmlLink?.startsWith("https://calendar.google.com/")
          ? e.htmlLink
          : "",
    }))
  }
  const listing = z
    .object({ messages: z.array(z.object({ id: z.string() })).default([]) })
    .parse(await read("email_list", { query: query || "newer_than:7d", maxResults: 5 }))
  return Promise.all(
    listing.messages.slice(0, 5).map(async (m) => {
      const e = email.parse(await read("email_read", { id: m.id }))
      const header = (key: string) =>
        e.payload?.headers?.find((h) => h.name.toLowerCase() === key)?.value
      return {
        title: (header("subject") || "未命名邮件").slice(0, 180),
        body: [header("from"), header("date"), mailText(e)]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000),
        thread: e.threadId,
        connection: id,
        origin:
          "https://mail.google.com/mail/u/0/#all/" +
          encodeURIComponent(e.threadId || e.id),
      }
    })
  )
}
