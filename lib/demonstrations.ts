import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { pool } from "@/db"
import { docker } from "@/lib/docker"
import { HttpError } from "@/lib/errors"
import { workspaceRow, workstationName, withWorkspaceOperation } from "@/lib/workstation"
import {
  MAX_DEMONSTRATION_EVENTS,
  demonstrationEventSchema,
  demonstrationDraft,
  type RecordedDemonstrationEvent,
} from "./demonstration-schema"
import { manualDraftSchema, manualSchema, type ManualDraft } from "./manual-schema"

export async function listDemonstrations(ownerId: string, agentId?: string) {
  return (
    await pool.query(
      'SELECT id,agent_id AS "agentId",name,status,events,draft,epoch FROM demonstrations WHERE owner_id=$1 AND ($2::text IS NULL OR agent_id=$2) ORDER BY created_at DESC LIMIT 50',
      [ownerId, agentId ?? null]
    )
  ).rows
}
export async function startDemonstration(ownerId: string, agentId: string, name: string) {
  name = z.string().trim().min(1).max(100).parse(name)
  return withWorkspaceOperation(agentId, async () => {
    const control = await workspaceRow(agentId)
    if (
      control.desiredMode ||
      !(control.mode === "human" || (control.mode === "idle" && !control.activeTaskId))
    )
      throw new HttpError(409, "请先接管桌面再开始示范")
    if (
      (
        await pool.query(
          "SELECT 1 FROM demonstrations WHERE agent_id=$1 AND status='recording'",
          [agentId]
        )
      ).rowCount
    )
      throw new HttpError(409, "已有示范正在录制")
    const id = randomUUID()
    await pool.query(
      "INSERT INTO demonstrations(id,owner_id,agent_id,name,epoch,status,events,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'recording','[]',now(),now())",
      [id, ownerId, agentId, name, control.epoch]
    )
    return { id, epoch: control.epoch }
  })
}
export async function recordDemonstration(ownerId: string, id: string, raw: unknown) {
  const input = z
    .object({
      seq: z.number().int().positive().max(MAX_DEMONSTRATION_EVENTS),
      event: demonstrationEventSchema,
    })
    .parse(raw)
  const row = (
    await pool.query("SELECT * FROM demonstrations WHERE id=$1 AND owner_id=$2", [
      id,
      ownerId,
    ])
  ).rows[0]
  if (!row) throw new HttpError(404, "Demonstration not found")
  return withWorkspaceOperation(row.agent_id, async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const current = (
        await client.query<{ status: string; events: RecordedDemonstrationEvent[] }>(
          "SELECT status,events FROM demonstrations WHERE id=$1 FOR UPDATE",
          [id]
        )
      ).rows[0]
      const previous = current.events.find((event) => event.seq === input.seq)
      if (previous) {
        const { seq, application, ...event } = previous
        void seq
        void application
        if (!isDeepStrictEqual(event, input.event))
          throw new HttpError(409, "Sequence already used")
        await client.query("COMMIT")
        return previous
      }
      if (current.status !== "recording" || input.seq !== current.events.length + 1)
        throw new HttpError(409, "Recording stopped or events arrived out of order")
      const control = await workspaceRow(row.agent_id)
      if (
        control.epoch !== row.epoch ||
        control.desiredMode ||
        !(control.mode === "human" || (control.mode === "idle" && !control.activeTaskId))
      )
        throw new HttpError(409, "桌面控制权已经改变，请结束本次示范")
      let application: string | null = null
      if (!["protected_input", "checkpoint"].includes(input.event.kind)) {
        const active = await docker(
          ["exec", workstationName(row.agent_id), "xprop", "-root", "_NET_ACTIVE_WINDOW"],
          { timeoutMs: 5000, maxOutputBytes: 2000 }
        )
        const window = /# (0x[0-9a-f]+)/i.exec(active.stdout.toString())?.[1]
        if (window && window !== "0x0") {
          const observed = await docker(
            ["exec", workstationName(row.agent_id), "xprop", "-id", window, "WM_CLASS"],
            { timeoutMs: 5000, maxOutputBytes: 2000 }
          )
          application = observed.stdout
            .toString()
            .split("=")
            .slice(1)
            .join("=")
            .trim()
            .slice(0, 160)
        }
      }
      if (input.event.kind === "checkpoint")
        application = current.events.at(-1)?.application ?? null
      const event = { ...input.event, seq: input.seq, application }
      await client.query(
        "UPDATE demonstrations SET events=events||$2::jsonb,updated_at=now() WHERE id=$1",
        [id, JSON.stringify([event])]
      )
      await client.query("COMMIT")
      return event
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
}
export async function finishDemonstration(ownerId: string, id: string) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const row = (
      await client.query<{
        name: string
        status: string
        events: RecordedDemonstrationEvent[]
        draft: ManualDraft
      }>(
        "SELECT name,status,events,draft FROM demonstrations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, ownerId]
      )
    ).rows[0]
    if (!row) throw new HttpError(404, "Demonstration not found")
    if (row.status !== "recording") {
      await client.query("COMMIT")
      return row.draft
    }
    if (!row.events.length) throw new HttpError(400, "请先录制操作或添加步骤说明")
    const draft = demonstrationDraft(row.name, row.events)
    await client.query(
      "UPDATE demonstrations SET status='draft',draft=$2,updated_at=now() WHERE id=$1",
      [id, JSON.stringify(draft)]
    )
    await client.query("COMMIT")
    return draft
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
export async function saveDemonstrationManual(ownerId: string, id: string, raw: unknown) {
  const draft = manualDraftSchema.parse(raw),
    client = await pool.connect()
  try {
    await client.query("BEGIN")
    const row = (
      await client.query(
        "SELECT status FROM demonstrations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, ownerId]
      )
    ).rows[0]
    if (!row || row.status === "recording")
      throw new HttpError(409, "先结束示范并审阅手册")
    const manual = manualSchema.parse({
      ...draft,
      id,
      ownerId,
      sourceTaskId: id,
      sourceKind: "demonstration",
      sourceVerification: "human_demonstrated",
      parameters: [],
      humanInvolvement: true,
      enabled: true,
      savedAt: new Date().toISOString(),
    })
    await client.query(
      "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [`manual.${id}`, JSON.stringify(manual)]
    )
    await client.query(
      "UPDATE demonstrations SET status='saved',draft=$2,updated_at=now() WHERE id=$1",
      [id, JSON.stringify(draft)]
    )
    await client.query("COMMIT")
    return manual
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function cancelDemonstration(ownerId: string, id: string) {
  const result = await pool.query(
    "UPDATE demonstrations SET status='cancelled',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='recording' RETURNING id",
    [id, ownerId]
  )
  if (!result.rowCount) throw new HttpError(409, "Recording is already closed")
  return { cancelled: true }
}
