"use server"
import { pool } from "@/db"
import { startWatch, attachSource } from "@/lib/project-tracking"
import { googleDrafts, type LibraryDraft } from "@/lib/library-google"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireOwner } from "@/lib/auth"
import { saveEntry, changeEntry, sourceRef } from "@/lib/library"
import { HttpError } from "@/lib/errors"

export async function updateLibrary(form: FormData) {
  const owner = await requireOwner(await headers())
  const action = z
    .enum(["save", "delete", "complete", "reopen"])
    .parse(form.get("action"))
  const id = z.string().min(1).max(100).nullable().parse(form.get("id"))
  let location = "/library"
  try {
    if (action === "save") {
      let body = String(form.get("body") ?? "")
      let title = String(form.get("title") ?? "")
      const file = form.get("file")
      if (file instanceof File && file.size) {
        if (file.size > 32000 || !/\.(md|txt|srt|vtt)$/i.test(file.name))
          throw new HttpError(400, "请选择 32 KB 以内的 TXT、Markdown 或会议字幕文件")
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer()
          )
        } catch {
          throw new HttpError(400, "请使用 UTF-8 文本文件")
        }
        title = title.trim() || file.name
      }
      if (
        form.get("kind") === "note" &&
        (form.get("dueDate") || form.get("reminderAgent"))
      )
        throw new HttpError(400, "设置提醒时，请将条目类型选为待跟进")
      if (form.get("reminderAgent") && !form.get("dueDate"))
        throw new HttpError(400, "请选择提醒日期")
      const source = form.get("sourceId")
        ? sourceRef.parse({ kind: form.get("sourceKind"), id: form.get("sourceId") })
        : undefined
      const row = await saveEntry(
        owner.userId,
        {
          kind: form.get("kind"),
          title,
          body,
          source,
          dueDate: form.get("dueDate") || null,
          reminderAgent: form.get("reminderAgent") || null,
        },
        id ?? undefined
      )
      location = `/library?entry=${encodeURIComponent(row.id)}`
    } else {
      if (!id) throw new HttpError(400, "缺少条目")
      await changeEntry(owner.userId, id, action)
      location =
        "/library?view=" +
        (action === "complete" ? "done" : action === "reopen" ? "open" : "all")
    }
  } catch (e) {
    if (!(e instanceof z.ZodError) && !(e instanceof HttpError)) throw e
    redirect(
      "/library?error=" +
        encodeURIComponent(
          e instanceof HttpError
            ? e.message
            : "请输入标题（最多 180 字），正文不超过 8000 字。"
        )
    )
  }
  revalidatePath("/library")
  redirect(location)
}

export async function previewGoogle(
  _previous: { drafts: LibraryDraft[]; message: string },
  form: FormData
) {
  const owner = await requireOwner(await headers())
  try {
    const kind = z.enum(["mail", "calendar"]).parse(form.get("kind")),
      id = z.string().min(1).max(100).parse(form.get("connection")),
      query = z
        .string()
        .max(180)
        .parse(form.get("query") || "")
    const drafts = await googleDrafts(owner.userId, id, kind, query)
    return {
      drafts,
      message: drafts.length
        ? "只有你点保存的条目才会共享给助手。"
        : "没有找到匹配的资料。",
    }
  } catch (e) {
    if (e instanceof HttpError) return { drafts: [], message: e.message }
    if (e instanceof z.ZodError)
      return { drafts: [], message: "请求或服务返回的数据格式不匹配。" }
    throw e
  }
}

export async function projectAction(form: FormData) {
  const { userId } = await requireOwner(await headers())
  let entry = String(form.get("entry") || "")
  try {
    switch (form.get("action")) {
      case "watch":
        entry = await startWatch(userId, {
          title: form.get("title"),
          connection: form.get("connection"),
          thread: form.get("thread"),
          due: form.get("due") || null,
          agent: form.get("agent") || null,
        })
        break
      case "attach":
        await attachSource(userId, entry, {
          kind: form.get("sourceKind"),
          id: form.get("sourceId"),
        })
        break
      case "stop":
        await pool.query(
          "DELETE FROM library_mail_watches w USING library_entries l WHERE w.entry_id=l.id AND l.owner_id=$1 AND w.entry_id=$2",
          [userId, entry]
        )
        break
      default:
        throw new HttpError(400, "操作无效")
    }
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) throw e
    redirect(
      "/library?error=" +
        encodeURIComponent(
          e instanceof HttpError ? e.message : "请检查项目名称、会话和日期"
        )
    )
  }
  revalidatePath("/library")
  redirect("/library?entry=" + encodeURIComponent(entry))
}
