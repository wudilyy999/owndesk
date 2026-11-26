import { randomUUID } from "node:crypto"
import { z } from "zod"
import { pool } from "@/db"
import { connectionRow, readWatchedThread } from "./connections"
import { HttpError } from "./errors"
import { mail, mailHeader, mailText } from "./mail-text"
import { readSource, sourceRef } from "./library"
const threadData = z.object({ id: z.string(), messages: z.array(mail).min(1) })
const gmailLink = (id: string) =>
  "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(id)
export async function startWatch(owner: string, raw: unknown) {
  const data = z
    .object({
      title: z.string().trim().min(1).max(180),
      connection: z.string().min(1).max(100),
      thread: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      due: z.iso.date().nullable(),
      agent: z.string().max(100).nullable(),
    })
    .parse(raw)
  if (data.agent && !data.due) throw new HttpError(400, "请选择到期日期")
  const since = new Date()
  const row = await connectionRow(owner, data.connection),
    thread = threadData.parse(
      await readWatchedThread(owner, row.id, row.revision, data.thread)
    )
  if (thread.id !== data.thread) throw new HttpError(409, "邮件会话已变化")
  const client = await pool.connect()
  const id = randomUUID()
  try {
    await client.query("BEGIN")
    const authorized = await client.query(
      "SELECT 1 FROM app_connections WHERE id=$1 AND owner_id=$2 AND revision=$3 AND enabled FOR UPDATE",
      [row.id, owner, row.revision]
    )
    if (!authorized.rowCount) throw new HttpError(409, "Google 连接已变化")
    const existing = await client.query(
      "SELECT entry_id FROM library_mail_watches WHERE connection_id=$1 AND thread_id=$2",
      [row.id, data.thread]
    )
    if (existing.rowCount) {
      await client.query("COMMIT")
      return String(existing.rows[0].entry_id)
    }
    if (
      data.agent &&
      !(
        await client.query("SELECT 1 FROM companions WHERE owner_id=$1 AND agent_id=$2", [
          owner,
          data.agent,
        ])
      ).rowCount
    )
      throw new HttpError(404, "助手不存在")
    await client.query(
      "INSERT INTO library_entries(id,owner_id,kind,title,body,due_date,reminder_agent) VALUES($1,$2,'followup',$3,'等待所选邮件会话的新回复',$4,$5)",
      [id, owner, data.title, data.due, data.agent]
    )
    await client.query(
      "INSERT INTO library_mail_watches(entry_id,connection_id,revision,thread_id,since) VALUES($1,$2,$3,$4,$5)",
      [id, row.id, row.revision, data.thread, since]
    )
    for (const m of thread.messages.filter(
      (m) => !m.labelIds.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l))
    ))
      await client.query(
        "INSERT INTO library_project_events(entry_id,origin,title,body,at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          id,
          gmailLink(m.id),
          mailHeader(m, "from") || "邮件",
          mailText(m),
          new Date(Number(m.internalDate) || Date.now()),
        ]
      )
    await client.query("COMMIT")
    return id
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}
export async function attachSource(owner: string, entry: string, raw: unknown) {
  const ref = sourceRef.parse(raw),
    source = await readSource(owner, ref)
  if (!source) throw new HttpError(404, "来源不存在")
  if (
    ["artifact", "upload"].includes(ref.kind) &&
    (!source.body.includes("\n") ||
      !source.body.slice(source.body.indexOf("\n") + 1).trim())
  )
    throw new HttpError(409, "文件正文尚未索引或文件没有可提取文字")
  const r = await pool.query(
    "INSERT INTO library_project_events(entry_id,origin,title,body,at) SELECT id,$3,$4,$5,$6 FROM library_entries WHERE owner_id=$1 AND id=$2 ON CONFLICT(entry_id,origin) DO UPDATE SET body=excluded.body RETURNING entry_id",
    [
      owner,
      entry,
      "/library?source=" + ref.kind + "&id=" + encodeURIComponent(ref.id),
      source.title,
      source.body.slice(0, 240000),
      source.at,
    ]
  )
  if (!r.rowCount) throw new HttpError(404, "项目不存在")
}
export async function projectEvents(owner: string, id: string) {
  return (
    await pool.query<{ origin: string; title: string; body: string; at: Date }>(
      "SELECT e.origin,e.title,e.body,e.at FROM library_project_events e JOIN library_entries l ON l.id=e.entry_id WHERE l.owner_id=$1 AND l.id=$2 ORDER BY e.at DESC,e.origin DESC",
      [owner, id]
    )
  ).rows
}
export async function pollWatches(now = new Date()) {
  const { rows } = await pool.query<{
    entry_id: string
    connection_id: string
    owner_id: string
    revision: number
    thread_id: string
    since: Date
  }>(
    `WITH picked AS (SELECT entry_id FROM library_mail_watches WHERE next_check<=$1 ORDER BY next_check,entry_id LIMIT 4 FOR UPDATE SKIP LOCKED) UPDATE library_mail_watches w SET last_checked=NULL,next_check=$1::timestamptz+interval '2 minutes' FROM picked p,library_entries l WHERE w.entry_id=p.entry_id AND l.id=p.entry_id RETURNING w.*,l.owner_id`,
    [now]
  )
  for (const w of rows) {
    let thread
    try {
      thread = threadData.parse(
        await readWatchedThread(w.owner_id, w.connection_id, w.revision, w.thread_id)
      )
      if (thread.id !== w.thread_id) throw new HttpError(409, "会话与授权不匹配")
    } catch (error) {
      await pool.query(
        "UPDATE library_mail_watches SET last_error=$2 WHERE entry_id=$1",
        [
          w.entry_id,
          error instanceof HttpError ? error.message : "无法读取邮件，稍后重试",
        ]
      )
      continue
    }
    const c = await pool.connect()
    try {
      await c.query("BEGIN")
      const valid = await c.query(
        "SELECT w.entry_id FROM library_mail_watches w JOIN app_connections a ON a.id=w.connection_id AND a.revision=w.revision AND a.enabled WHERE w.entry_id=$1 AND w.revision=$2 FOR UPDATE OF w,a",
        [w.entry_id, w.revision]
      )
      if (valid.rowCount) {
        for (const m of thread.messages
          .filter(
            (m) =>
              Number(m.internalDate) >= w.since.getTime() &&
              (!mailHeader(m, "auto-submitted") ||
                mailHeader(m, "auto-submitted")?.toLowerCase() === "no") &&
              mailHeader(m, "return-path")?.trim() !== "<>" &&
              !m.labelIds.some((l) => ["DRAFT", "TRASH", "SPAM", "SENT"].includes(l))
          )
          .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))) {
          const at = new Date(Number(m.internalDate))
          const r = await c.query(
            "INSERT INTO library_project_events(entry_id,origin,title,body,at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING entry_id",
            [
              w.entry_id,
              gmailLink(m.id),
              mailHeader(m, "from") || "收到回复",
              mailText(m),
              at,
            ]
          )
          if (r.rowCount)
            await c.query(
              `WITH closed AS (UPDATE library_entries SET done=true,body=CASE WHEN body='等待所选邮件会话的新回复' THEN '已收到所选会话的新回复' ELSE body END,updated_at=now() WHERE id=$1 AND NOT done RETURNING *) INSERT INTO companion_messages(id,agent_id,role,kind,content,metadata,channel,created_at) SELECT gen_random_uuid()::text,reminder_agent,'assistant','objective_update','已收到回复：'||title,jsonb_build_object('libraryEntryId',id),'web',now() FROM closed WHERE reminder_agent IS NOT NULL`,
              [w.entry_id]
            )
        }
        await c.query(
          "UPDATE library_mail_watches SET last_error=NULL,last_checked=now() WHERE entry_id=$1",
          [w.entry_id]
        )
      }
      await c.query("COMMIT")
    } catch (e) {
      await c.query("ROLLBACK")
      throw e
    } finally {
      c.release()
    }
  }
}
