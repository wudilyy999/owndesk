import { createHash } from "node:crypto"
import { pool } from "@/db"
import type { ModelMessage } from "ai"

type Withdrawn = { content: string; at: string; sourceIds: string[] }
const hidden = "[removed memory]"
// Compute a projection of the original history; undo and edits never rewrite audit records.
export function memoryFilter(rows: Withdrawn[]) {
  const ids = new Set(rows.flatMap((r) => r.sourceIds))
  const literals = new Set<string>()
  for (const { content } of rows) {
    const fact = content.trim()
    if (!fact) continue
    literals.add(fact)
    // A bare value may be repeated in later chat, without the label used by the note.
    for (const m of fact.matchAll(
      /[“「『"`]([^”」』"`\n]+)[”」』"`]|(?:[：:=]|(?:暗号|名字|姓名|昵称|代号|地址|电话|号码|偏好|颜色)(?:为|叫|是)|(?:叫做|名叫|对方叫)|\b(?:is|was|called)\s+)([^，。；！？,;.?!\n]+)/gi
    )) {
      const v = (m[1] ?? m[2]).trim()
      if (v.length >= 2) literals.add(v)
    }
  }
  const terms = [...literals].sort((a, b) => b.length - a.length)
  const text = (s: string) => {
    for (const term of terms) s = s.replaceAll(term, hidden)
    return s
  }
  // SDK routing and call IDs are structural. Mask content and tool payloads without breaking
  // call/result pairs, deleting an audit event, or rewriting image data.
  function data(value: unknown): unknown {
    if (typeof value === "string") return text(value)
    if (Array.isArray(value)) return value.map(data)
    if (
      !value ||
      typeof value !== "object" ||
      ArrayBuffer.isView(value) ||
      value instanceof URL
    )
      return value
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, data(v)]))
  }
  function messages(input: ModelMessage[]): ModelMessage[] {
    if (!terms.length) return input
    return input.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? text(m.content)
          : m.content.map((p) => {
              if (p.type === "text" || p.type === "reasoning")
                return { ...p, text: text(p.text) }
              if (p.type === "tool-call") return { ...p, input: data(p.input) }
              if (
                p.type === "tool-result" &&
                ["text", "json", "error-text", "error-json"].includes(p.output.type) &&
                "value" in p.output
              )
                return { ...p, output: { ...p.output, value: data(p.output.value) } }
              if (p.type === "tool-result" && p.output.type === "content")
                return {
                  ...p,
                  output: {
                    ...p.output,
                    value: p.output.value.map((v) =>
                      v.type === "text" ? { ...v, text: text(v.text) } : v
                    ),
                  },
                }
              return p
            }),
    })) as ModelMessage[]
  }
  return {
    text,
    messages,
    ids,
    revision: rows.length
      ? createHash("sha512").update(JSON.stringify(rows)).digest("hex")
      : "",
  }
}
export async function withdrawnMemory(agentId: string) {
  const { rows } = await pool.query<Withdrawn>(
    `WITH withdrawn AS (
    SELECT memory_id, before->>'content' AS content, created_at AS at FROM memory_changes
    WHERE agent_id=$1 AND undone_at IS NULL AND before->>'status'='active'
      AND (actor='user' OR origin<>'organize') AND (op='update' OR (op='delete' AND
        (actor='user' OR group_id IS NULL OR NOT EXISTS (SELECT 1 FROM memory_changes u WHERE u.agent_id=$1 AND u.group_id=memory_changes.group_id AND u.op='update'))))
    UNION ALL SELECT memory_id,after->>'content',undone_at FROM memory_changes WHERE agent_id=$1 AND undone_at IS NOT NULL AND op IN ('add','update')
  ) SELECT w.content, w.at::text AS at,ARRAY(SELECT DISTINCT c.message_id FROM memory_changes c WHERE c.agent_id=$1 AND c.memory_id=w.memory_id AND c.message_id IS NOT NULL AND c.after->>'content'=w.content ORDER BY c.message_id) AS "sourceIds"
    FROM withdrawn w WHERE w.content IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.agent_id=$1 AND m.status='active' AND m.content=w.content) ORDER BY w.at DESC,w.memory_id,w.content`,
    [agentId]
  )
  return memoryFilter(rows)
}
