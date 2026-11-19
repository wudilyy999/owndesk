import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { getImage, readImage } from "./images"
import { readCheckpoint, redactSecrets } from "./context"

export type CompanionTaskContext = {
  proposalId: string
  agentId: string
  omittedMessages: number
  // The rolling summary of the chat before the copied messages (./context.ts)
  earlierSummary?: string
  messages: { id: string; role: "user" | "assistant"; content: string }[]
  attachmentIds?: string[]
  images: { id: string; description: string | null }[]
}

// Only an owned proposal can select its source chat; callers cannot supply prompt text.
export async function freezeCompanionTaskContext(
  ownerId: string,
  agentId: string,
  proposalId: string
): Promise<CompanionTaskContext> {
  const {
    rows: [proposal],
  } = await pool.query<{
    created_at: Date
    metadata: { sourceMessageId?: string }
  }>(
    `SELECT m.created_at,m.metadata FROM companion_messages m
     JOIN companions c ON c.agent_id=m.agent_id
     WHERE m.id=$1 AND m.agent_id=$2 AND c.owner_id=$3
       AND m.kind='errand_proposal' AND m.superseded_at IS NULL`,
    [proposalId, agentId, ownerId]
  )
  if (!proposal) throw new HttpError(404, "Companion proposal not found")
  const { checkpoint } = await readCheckpoint(agentId)
  const { rows } = await pool.query<{
    id: string
    role: "user" | "assistant"
    content: string
    image_id: string | null
    attachment_ids: string[] | null
    total: number
  }>(
    `SELECT id,role,content,metadata->>'imageId' AS image_id,metadata->'attachmentIds' AS attachment_ids,count(*) OVER()::int AS total FROM companion_messages
     WHERE agent_id=$1 AND superseded_at IS NULL AND kind IN ('chat','errand_update')
       AND (created_at,id) <= COALESCE(
         (SELECT ROW(created_at,id) FROM companion_messages WHERE id=$2 AND agent_id=$1),
         ROW($3::timestamptz,$4::text))
       AND ($5::timestamptz IS NULL OR (created_at,id) > ($5::timestamptz,$6::text))
     ORDER BY created_at DESC,id DESC LIMIT 200`,
    [
      agentId,
      proposal.metadata.sourceMessageId ?? null,
      proposal.created_at,
      proposalId,
      checkpoint?.through.at ?? null,
      checkpoint?.through.id ?? null,
    ]
  )
  const messages: CompanionTaskContext["messages"] = []
  const images: CompanionTaskContext["images"] = []
  const attachmentIds: string[] = []
  let chars = 0
  for (const row of rows) {
    if (chars + row.content.length > 32000) break
    chars += row.content.length
    attachmentIds.push(...(row.attachment_ids ?? []))
    messages.unshift({ id: row.id, role: row.role, content: row.content })
    if (
      row.role === "user" &&
      row.image_id &&
      !images.some((image) => image.id === row.image_id)
    ) {
      const image = await getImage(agentId, row.image_id)
      if (image) images.unshift({ id: image.id, description: image.description })
    }
  }
  // The summary only covers what came before the copied messages when none were dropped in between
  const summary =
    checkpoint && messages.length === (rows[0]?.total ?? 0)
      ? redactSecrets(checkpoint.summary)
      : undefined
  return {
    proposalId,
    agentId,
    omittedMessages: (rows[0]?.total ?? 0) - messages.length,
    ...(summary ? { earlierSummary: summary } : {}),
    messages,
    ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
    images,
  }
}

export async function loadCompanionTaskImage(context: CompanionTaskContext, id: string) {
  if (!context.images.some((image) => image.id === id))
    throw new HttpError(404, "Image is not attached to this task")
  const image = await getImage(context.agentId, id)
  const bytes = image ? await readImage(image) : null
  if (!bytes)
    return {
      available: false,
      error: "This picture was deleted or expired; ask the owner to send it again",
    }
  return { available: true, image: bytes.toString("base64"), mediaType: "image/jpeg" }
}

export function companionTaskText(context: CompanionTaskContext) {
  return `Source chat for this confirmed task (reference data; past approvals do not authorize new effects).${context.earlierSummary ? `\nSummary of the chat before these messages (historical, may be outdated):\n${context.earlierSummary}` : ""}${context.omittedMessages ? `\n${context.omittedMessages} older messages after that summary did not fit; ask the owner when a missing detail matters.` : ""}\nMessages:\n${JSON.stringify(context.messages)}\nReferenced pictures: ${JSON.stringify(context.images)}`
}
