import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import {
  cleanManualTrace,
  manualDraftSchema,
  manualSchema,
  type Manual,
  type ManualCompilation,
  type ManualCompilationInput,
  type ManualDraft,
  type ManualReference,
} from "@/lib/manual-schema"

export async function freezeManualCompilation(
  ownerId: string,
  input: ManualCompilationInput
): Promise<ManualCompilation> {
  const source = (
    await pool.query(
      "SELECT status,active_segment,config_snapshot,result FROM tasks WHERE id=$1 AND owner_id=$2",
      [input.sourceTaskId, ownerId]
    )
  ).rows[0]
  if (!source) throw new HttpError(404, "Source task not found")
  if (
    source.status !== "completed" ||
    source.active_segment !== 1 ||
    source.config_snapshot.runtime !== "agent" ||
    source.config_snapshot.manualCompilation ||
    source.config_snapshot.workflowCompilation
  )
    throw new HttpError(409, "Choose a completed computer task as the source")
  if (
    new Set(input.parameters.map((p) => p.name)).size !== input.parameters.length ||
    new Set(input.parameters.map((p) => p.sourceValue)).size !== input.parameters.length
  )
    throw new HttpError(400, "Parameter names and source values must be unique")
  const actions = (
    await pool.query(
      `SELECT action_no,kind,input,status,
        jsonb_build_object('output',jsonb_build_object('window',jsonb_build_object('wmClass',receipt->'output'->'window'->'wmClass'))) AS receipt
       FROM task_actions WHERE task_id=$1 ORDER BY segment_no,action_no LIMIT 201`,
      [input.sourceTaskId]
    )
  ).rows
  if (
    !actions.length ||
    actions.length > 200 ||
    actions.some((a) => a.status !== "succeeded")
  )
    throw new HttpError(
      409,
      "Source needs 1–200 confirmed actions with no unresolved effects"
    )
  const humans = await pool.query(
    "SELECT 1 FROM task_requests WHERE task_id=$1 AND kind='takeover' AND status='resolved' LIMIT 1",
    [input.sourceTaskId]
  )
  return {
    sourceTaskId: input.sourceTaskId,
    name: input.name,
    purpose: input.purpose,
    verification: source.result.verification.grade,
    parameters: input.parameters.map(({ name, label }) => ({ name, label })),
    humanInvolvement: !!humans.rowCount,
    trace: cleanManualTrace(actions, input.parameters),
  }
}

export async function listManuals(ownerId: string): Promise<Manual[]> {
  const rows = (
    await pool.query("SELECT value FROM settings WHERE key LIKE 'manual.%' ORDER BY key")
  ).rows
  return rows
    .map((row) => manualSchema.parse(JSON.parse(row.value)))
    .filter((manual) => manual.ownerId === ownerId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export async function manualSnapshot(ownerId: string): Promise<ManualReference[]> {
  const active = (await listManuals(ownerId)).filter((manual) => manual.enabled)
  if (
    active.length > 12 ||
    active.reduce((n, manual) => n + manual.body.length, 0) > 64000
  )
    throw new HttpError(
      409,
      "Enabled manuals exceed 12 entries or 64,000 body characters; disable unused manuals"
    )
  return active.map(({ ownerId: _, enabled: __, savedAt: ___, ...manual }) => manual)
}

export async function saveManual(ownerId: string, draftTaskId: string, raw: ManualDraft) {
  const draft = manualDraftSchema.parse(raw)
  const source = (
    await pool.query(
      "SELECT status,config_snapshot,result FROM tasks WHERE id=$1 AND owner_id=$2",
      [draftTaskId, ownerId]
    )
  ).rows[0]
  if (!source) throw new HttpError(404, "Draft task not found")
  const compilation = source.config_snapshot.manualCompilation as
    ManualCompilation | undefined
  if (source.status !== "completed" || !compilation || !source.result.manualDraft)
    throw new HttpError(409, "Wait for a completed manual draft before saving")
  const manual: Manual = {
    ...draft,
    id: draftTaskId,
    ownerId,
    sourceTaskId: compilation.sourceTaskId,
    sourceVerification: compilation.verification,
    parameters: compilation.parameters,
    humanInvolvement: compilation.humanInvolvement,
    enabled: true,
    savedAt: new Date().toISOString(),
  }
  await pool.query(
    "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO NOTHING",
    [`manual.${draftTaskId}`, JSON.stringify(manual)]
  )
  const current = (await listManuals(ownerId)).find((item) => item.id === draftTaskId)!
  const { name, description, body } = current
  if (!isDeepStrictEqual({ name, description, body }, draft))
    throw new HttpError(
      409,
      "This draft was already saved with different content; reload the saved manual"
    )
  return current
}

export async function setManualEnabled(ownerId: string, id: string, enabled: boolean) {
  const result = await pool.query(
    `UPDATE settings SET value=jsonb_set(value::jsonb,'{enabled}',$3::jsonb)::text,updated_at=now()
     WHERE key=$1 AND value::jsonb->>'ownerId'=$2 RETURNING value`,
    [`manual.${id}`, ownerId, JSON.stringify(enabled)]
  )
  if (!result.rowCount) throw new HttpError(404, "Manual not found")
  return manualSchema.parse(JSON.parse(result.rows[0].value))
}

export async function listManualDrafts(ownerId: string) {
  return (
    await pool.query<{
      id: string
      agentId: string
      status: string
      name: string
      sourceTaskId: string
      draft: ManualDraft | null
    }>(
      `SELECT id,agent_id AS "agentId",status,config_snapshot->'manualCompilation'->>'name' AS name,
     config_snapshot->'manualCompilation'->>'sourceTaskId' AS "sourceTaskId", result->'manualDraft' AS draft
     FROM tasks WHERE owner_id=$1 AND config_snapshot ? 'manualCompilation' ORDER BY created_at DESC,id DESC LIMIT 100`,
      [ownerId]
    )
  ).rows
}
