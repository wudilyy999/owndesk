import { z } from "zod"
type Part = {
  mimeType?: string
  filename?: string
  body?: { data?: string }
  parts?: Part[]
}
const part: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(part).optional(),
  })
)
export const mail = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  internalDate: z
    .string()
    .regex(/^\d{1,14}$/)
    .optional(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().optional(),
  payload: z
    .object({
      mimeType: z.string().optional(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      body: z.object({ data: z.string().optional() }).optional(),
      parts: z.array(part).optional(),
    })
    .optional(),
})
export function mailText(message: z.infer<typeof mail>) {
  const parts: { plain: string[]; html: string[] } = { plain: [], html: [] }
  let remaining = 240000
  function visit(p: Part) {
    if (!remaining || p.filename || p.mimeType === "message/rfc822") return
    if (p.body?.data && ["text/html", "text/plain"].includes(p.mimeType || "")) {
      let value = Buffer.from(p.body.data.slice(0, 320000), "base64url").toString("utf8")
      if (p.mimeType === "text/html")
        value = value
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
      const target = p.mimeType === "text/plain" ? "plain" : "html"
      parts[target].push(value.slice(0, remaining))
      remaining -= Math.min(remaining, value.length)
    }
    for (const c of p.parts ?? []) visit(c)
  }
  if (message.payload) visit(message.payload)
  return (
    (parts.plain.length ? parts.plain : parts.html).join("\n").trim() ||
    message.snippet ||
    ""
  ).replaceAll("\0", "")
}
export const mailHeader = (m: z.infer<typeof mail>, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value
