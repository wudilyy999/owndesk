import { and, desc, eq, sql } from "drizzle-orm"
import { sharedQuery } from "./library-input"
import { z } from "zod"
import { db, pool } from "@/db"
import { libraryEntries as entries } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import { redactSecrets } from "@/lib/redact-secrets"

export const sourceType = z.enum(["chat", "task", "artifact", "upload"])
export const entryType = z.enum(["note", "followup"])
export const sourceRef = z.object({ kind: sourceType, id: z.string().min(1).max(100) })
export const entryInput = z.object({
  kind: entryType,
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().max(8000).default(""),
  source: sourceRef.optional(),
  dueDate: z.iso.date().nullish(),
  reminderAgent: z.string().min(1).max(100).nullish(),
})
type Source = z.infer<typeof sourceRef>
type SourceRow = Source & { title: string; body: string; at: Date; task: string | null }
// Search user-visible data in place. Do not index private settings, prompts, snapshots or tool logs.
const sources = `WITH sources AS (
 SELECT 'chat' AS kind,m.id,concat(CASE WHEN m.role='user' THEN '我 → ' ELSE '' END,a.name) AS title,m.content AS body,m.created_at AS at,NULL::text AS task
 FROM companion_messages m JOIN companions c ON c.agent_id=m.agent_id JOIN agents a ON a.id=c.agent_id
 WHERE c.owner_id=$1 AND m.kind='chat' AND m.superseded_at IS NULL AND (m.reveal_at IS NULL OR m.reveal_at<=now())
 UNION ALL SELECT 'task',t.id,t.goal,concat_ws(E'\n',t.result->>'summary', (SELECT string_agg(p->>'text',E'\n' ORDER BY n) FROM messages m CROSS JOIN jsonb_array_elements(m.parts) WITH ORDINALITY parts(p,n) WHERE m.thread_id=t.thread_id AND m.id=t.id||'-answer' AND p->>'type'='text')),t.created_at,t.id FROM tasks t WHERE t.owner_id=$1 AND t.config_snapshot->>'runtime' IS DISTINCT FROM 'fixture'
 UNION ALL SELECT 'artifact',a.id,a.name,t.goal,a.created_at,t.id FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=$1 AND t.config_snapshot->>'runtime' IS DISTINCT FROM 'fixture'
 UNION ALL SELECT 'upload',u.id,u.name,u.media_type,u.created_at,NULL FROM task_uploads u WHERE u.owner_id=$1)`
export async function searchSources(
  owner: string,
  query: string,
  kind?: Source["kind"],
  limit = 40,
  offset = 0
) {
  const q = query.trim().slice(0, 180)
  if (!q) return []
  return (
    await pool.query<SourceRow>(
      `${sources} SELECT kind,id,left(title,180) AS title,substring(body from greatest(1,strpos(lower(body),lower($2))-60) for 320) AS body,at,task FROM sources WHERE ($3::text IS NULL OR kind=$3) AND (strpos(lower(title),lower($2))>0 OR strpos(lower(body),lower($2))>0) ORDER BY (strpos(lower(title),lower($2))>0) DESC,at DESC,kind,id LIMIT $4 OFFSET $5`,
      [owner, q, kind ?? null, limit, offset]
    )
  ).rows
}
export async function readSource(owner: string, ref: Source) {
  return (
    (
      await pool.query<SourceRow>(
        `${sources} SELECT * FROM sources WHERE kind=$2 AND id=$3`,
        [owner, ref.kind, ref.id]
      )
    ).rows[0] ?? null
  )
}
export function listEntries(
  owner: string,
  query = "",
  kind?: z.infer<typeof entryType>,
  done?: boolean,
  limit = 60,
  offset = 0
) {
  return db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.ownerId, owner),
        kind && eq(entries.kind, kind),
        done === undefined ? undefined : eq(entries.done, done),
        query
          ? sql`strpos(lower(${entries.title} || ' ' || ${entries.body}),lower(${query}))>0`
          : undefined
      )
    )
    .orderBy(desc(entries.updatedAt), desc(entries.id))
    .limit(limit)
    .offset(offset)
}
export async function saveEntry(owner: string, raw: unknown, id?: string) {
  const data = entryInput.parse(raw)
  if (data.source && !(await readSource(owner, data.source)))
    throw new HttpError(404, "来源已不可用")
  const dueDate = data.kind === "followup" ? (data.dueDate ?? null) : null,
    reminderAgent = dueDate ? (data.reminderAgent ?? null) : null
  if (
    reminderAgent &&
    !(
      await pool.query("SELECT 1 FROM companions WHERE owner_id=$1 AND agent_id=$2", [
        owner,
        reminderAgent,
      ])
    ).rowCount
  )
    throw new HttpError(400, "请选择自己的聊天助手")
  if (id) {
    const rows = await db
      .update(entries)
      .set({
        title: data.title,
        body: data.body,
        dueDate,
        reminderAgent,
        remindedAt: sql`CASE WHEN ${entries.dueDate} IS DISTINCT FROM ${dueDate}::date OR ${entries.reminderAgent} IS DISTINCT FROM ${reminderAgent}::text THEN NULL ELSE ${entries.remindedAt} END`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(entries.ownerId, owner), eq(entries.id, id), eq(entries.kind, data.kind))
      )
      .returning({ id: entries.id })
    if (!rows.length) throw new HttpError(404, "条目不存在")
    return rows[0]
  }
  return (
    await db
      .insert(entries)
      .values({
        ownerId: owner,
        dueDate,
        reminderAgent,
        kind: data.kind,
        title: data.title,
        body: data.body,
        sourceKind: data.source?.kind,
        sourceId: data.source?.id,
      })
      .returning({ id: entries.id })
  )[0]
}
export async function changeEntry(
  owner: string,
  id: string,
  action: "delete" | "complete" | "reopen"
) {
  const where = and(eq(entries.ownerId, owner), eq(entries.id, id))
  const rows =
    action === "delete"
      ? await db.delete(entries).where(where).returning({ id: entries.id })
      : await db
          .update(entries)
          .set({ done: action === "complete", updatedAt: new Date() })
          .where(and(where, eq(entries.kind, "followup")))
          .returning({ id: entries.id })
  if (!rows.length) throw new HttpError(404, "条目不存在")
}

export async function recallLibrary(owner: string, raw: unknown) {
  const { query, openFollowups } = sharedQuery.parse(raw)
  return (
    await listEntries(
      owner,
      query,
      openFollowups ? "followup" : undefined,
      openFollowups ? false : undefined,
      8
    )
  ).map((r) => ({
    title: redactSecrets(r.title),
    excerpt: redactSecrets(r.body).slice(0, 540),
    kind: r.kind,
    done: r.done,
    dueDate: r.dueDate,
    url: `/library?entry=${encodeURIComponent(r.id)}`,
  }))
}

// Mark and deliver in the same statement. Retries and concurrent workers do not duplicate a reminder.
export async function deliverLibraryReminders(now = new Date()) {
  const { rowCount } = await pool.query(
    `WITH picked AS (
 SELECT l.id FROM library_entries l JOIN companions c ON c.agent_id=l.reminder_agent AND c.owner_id=l.owner_id
 JOIN owners o ON o.user_id=l.owner_id WHERE l.kind='followup' AND NOT l.done AND l.reminded_at IS NULL AND l.due_date<=($1::timestamptz AT TIME ZONE o.time_zone)::date
 ORDER BY l.due_date,l.id LIMIT 30 FOR UPDATE OF l SKIP LOCKED), marked AS (
 UPDATE library_entries l SET reminded_at=$1 FROM picked WHERE l.id=picked.id RETURNING l.*)
 INSERT INTO companion_messages(id,agent_id,role,kind,content,metadata,channel,created_at)
 SELECT gen_random_uuid()::text,reminder_agent,'assistant','objective_update','到日期了，记得跟进：'||title,jsonb_build_object('libraryEntryId',id),'web',$1 FROM marked`,
    [now]
  )
  return rowCount ?? 0
}
