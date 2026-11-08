import { z } from "zod"
import { HttpError } from "@/lib/errors"
import type { ConnectionTool } from "./connection-schema"
const line = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => !/[\r\n]/.test(value))
const event = z.object({
  summary: z.string().min(1).max(1000),
  description: z.string().max(16000).optional(),
  start: z.object({
    dateTime: z.iso.datetime({ offset: true }),
    timeZone: z.string().optional(),
  }),
  end: z.object({
    dateTime: z.iso.datetime({ offset: true }),
    timeZone: z.string().optional(),
  }),
  attendees: z
    .array(z.object({ email: z.email() }))
    .max(50)
    .optional(),
})
const schemas = {
  email_list: z.object({
    query: z.string().max(1000).optional(),
    pageToken: z.string().optional(),
    maxResults: z.number().int().min(1).max(50).default(20),
  }),
  email_read: z.object({ id: z.string().min(1).max(200) }),
  email_send: z.object({
    to: z.array(z.email()).min(1).max(50),
    subject: line,
    body: z.string().min(1).max(40000),
  }),
  calendar_list: z.object({
    calendarId: z.string().default("primary"),
    timeMin: z.iso.datetime({ offset: true }).optional(),
    timeMax: z.iso.datetime({ offset: true }).optional(),
    pageToken: z.string().optional(),
  }),
  calendar_create: z.object({ calendarId: z.string().default("primary"), event }),
  calendar_update: z.object({
    calendarId: z.string().default("primary"),
    eventId: z.string().min(1),
    event,
  }),
  calendar_delete: z.object({
    calendarId: z.string().default("primary"),
    eventId: z.string().min(1),
  }),
}
const descriptions = {
  email_list: "Search Gmail messages; returns IDs and nextPageToken.",
  email_read: "Read a Gmail message by ID.",
  email_send:
    "Send an email to exact recipients with the given subject and body. Requires owner approval.",
  calendar_list: "List calendar events within dates, with pagination.",
  calendar_create:
    "Create an event and optionally invite attendees. Requires owner approval.",
  calendar_update: "Replace the named event details. Requires owner approval.",
  calendar_delete: "Delete an event. Requires owner approval.",
}
export const googleTools: ConnectionTool[] = Object.entries(schemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: z.toJSONSchema(schema),
    readOnly: ["email_list", "email_read", "calendar_list"].includes(name),
  })
)
export async function callGoogle(
  token: string,
  tool: string,
  raw: Record<string, unknown>
) {
  if (!Object.hasOwn(schemas, tool)) throw new HttpError(400, "Unknown Google tool")
  const args = schemas[tool as keyof typeof schemas].parse(raw) as Record<string, any>
  let url: URL,
    method = "GET",
    body: unknown
  if (tool === "email_list") {
    url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages")
    if (args.query) url.searchParams.set("q", args.query)
    url.searchParams.set("maxResults", String(args.maxResults))
    if (args.pageToken) url.searchParams.set("pageToken", args.pageToken)
  } else if (tool === "email_read") {
    url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.id)}`
    )
    url.searchParams.set("format", "full")
  } else if (tool === "email_send") {
    url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
    method = "POST"
    body = {
      raw: Buffer.from(
        `To: ${args.to.join(", ")}\r\nSubject: =?UTF-8?B?${Buffer.from(args.subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(args.body).toString("base64")}`
      ).toString("base64url"),
    }
  } else {
    url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendarId)}/events${args.eventId ? "/" + encodeURIComponent(args.eventId) : ""}`
    )
    if (tool === "calendar_list") {
      url.searchParams.set("maxResults", "50")
      for (const key of ["timeMin", "timeMax", "pageToken"])
        if (args[key]) url.searchParams.set(key, args[key])
    } else {
      method =
        tool === "calendar_create"
          ? "POST"
          : tool === "calendar_update"
            ? "PUT"
            : "DELETE"
      body = args.event
      url.searchParams.set("sendUpdates", "all")
    }
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new HttpError(502, `Google returned ${response.status}`)
  return response.status === 204 ? { deleted: true } : response.json()
}
