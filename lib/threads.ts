import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import type { TaskSupplement } from "@/lib/task-supplements"
import type { ConversationTurn, ThreadInteraction } from "./thread-context"

export type ThreadSummary = {
  id: string
  agentId: string
  title: string
  latestTaskId: string
  status: string
  turnCount: number
  activeAt: string
}
export type ThreadTurn = ConversationTurn & {
  supplements: TaskSupplement[]
  threadTurn: number
  createdAt: string
  reply: string | null
  artifacts: { id: string; name: string; size: number; verification: { grade: string } }[]
  tools: { kind: string; status: string }[]
}
export type ThreadPage = {
  id: string
  agentId: string
  title: string
  turns: ThreadTurn[]
  hasEarlier: boolean
}

export async function listThreads(ownerId: string) {
  return (
    await pool.query<ThreadSummary>(
      `
    SELECT th.id,th.agent_id AS "agentId",COALESCE(th.title,'新对话') AS title,
      latest.id AS "latestTaskId",latest.status,latest.thread_turn AS "turnCount",
      GREATEST(th.active_at,latest.updated_at,latest.created_at) AS "activeAt"
    FROM threads th JOIN LATERAL (
      SELECT id,status,thread_turn,updated_at,created_at FROM tasks WHERE thread_id=th.id AND owner_id=$1 ORDER BY thread_turn DESC LIMIT 1
    ) latest ON true ORDER BY GREATEST(th.active_at,latest.updated_at,latest.created_at) DESC,th.id DESC LIMIT 50`,
      [ownerId]
    )
  ).rows
}

export async function getThread(
  ownerId: string,
  threadId: string,
  before?: number
): Promise<ThreadPage> {
  const {
    rows: [thread],
  } = await pool.query<{ id: string; agentId: string; title: string }>(
    `
    SELECT th.id,th.agent_id AS "agentId",COALESCE(th.title,'新对话') AS title FROM threads th
    WHERE th.id=$1 AND EXISTS(SELECT 1 FROM tasks WHERE thread_id=th.id AND owner_id=$2)`,
    [threadId, ownerId]
  )
  if (!thread) throw new HttpError(404, "Conversation not found")
  const turns = (
    await pool.query<ThreadTurn>(
      `
    SELECT t.id,t.goal,t.status,t.result,t.error,t.thread_turn AS "threadTurn",t.created_at AS "createdAt",
      (SELECT string_agg(part->>'text',E'\n' ORDER BY ord) FROM messages m,
        jsonb_array_elements(m.parts) WITH ORDINALITY AS p(part,ord)
        WHERE m.id=t.id||'-answer' AND m.thread_id=t.thread_id AND part->>'type'='text') AS reply
    FROM tasks t WHERE t.thread_id=$1 AND t.owner_id=$2 AND ($3::integer IS NULL OR t.thread_turn<$3)
    ORDER BY t.thread_turn DESC LIMIT 21`,
      [threadId, ownerId, before ?? null]
    )
  ).rows
  const hasEarlier = turns.length > 20
  if (hasEarlier) turns.pop()
  turns.reverse()
  if (turns.length) {
    const ids = turns.map((turn) => turn.id)
    const [artifacts, tools, interactions, supplements] = await Promise.all([
      pool.query<{ taskId: string } & ThreadTurn["artifacts"][number]>(
        'SELECT task_id AS "taskId",id,name,size,verification FROM artifacts WHERE task_id=ANY($1::text[]) ORDER BY created_at,id',
        [ids]
      ),
      pool.query<{ taskId: string } & ThreadTurn["tools"][number]>(
        'SELECT task_id AS "taskId",kind,status FROM task_actions WHERE task_id=ANY($1::text[]) ORDER BY segment_no,action_no',
        [ids]
      ),
      pool.query<{ taskId: string } & ThreadInteraction>(
        `SELECT task_id AS "taskId",kind,decision,
        COALESCE(payload->>'question',payload->>'reason',payload->>'message',payload->>'summary','') AS question,
        COALESCE(response->>'answer',response->>'note','') AS answer FROM task_requests
        WHERE task_id=ANY($1::text[]) AND status='resolved' ORDER BY resolved_at,id`,
        [ids]
      ),
      pool.query<{ taskId: string } & TaskSupplement>(
        `SELECT task_id AS "taskId",seq,payload->>'text' AS text FROM task_events WHERE task_id=ANY($1::text[]) AND type='owner_supplement' ORDER BY seq`,
        [ids]
      ),
    ])
    for (const turn of turns) {
      turn.supplements = supplements.rows.filter((note) => note.taskId === turn.id)
      turn.artifacts = artifacts.rows.filter((file) => file.taskId === turn.id)
      turn.tools = tools.rows.filter((tool) => tool.taskId === turn.id)
      turn.interactions = interactions.rows.filter(
        (interaction) => interaction.taskId === turn.id
      )
    }
  }
  return { ...thread, turns, hasEarlier }
}

export async function renameThread(ownerId: string, threadId: string, title: string) {
  const result = await pool.query(
    `UPDATE threads SET title=$3 WHERE id=$1
    AND EXISTS(SELECT 1 FROM tasks WHERE thread_id=threads.id AND owner_id=$2) RETURNING id,title`,
    [threadId, ownerId, title]
  )
  if (!result.rowCount) throw new HttpError(404, "Conversation not found")
  return result.rows[0] as { id: string; title: string }
}
