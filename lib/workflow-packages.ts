import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import { HttpError } from "@/lib/errors"
import { getWorkflowVersion } from "@/lib/workflows"
import {
  prepareWorkflowPackage,
  validateWorkflowPackage,
  workflowImportSchema,
  workflowPlanFromPackage,
  type WorkflowPackage,
} from "@/lib/workflow-package"

export async function exportWorkflowPackage(ownerId: string, versionId: string) {
  const version = await getWorkflowVersion(ownerId, versionId)
  if (version.status !== "ready" || !version.plan || !version.validatedEnvironment)
    throw new HttpError(
      409,
      "Only an independently verified ready version can be exported"
    )
  return prepareWorkflowPackage(version.plan, version.validatedEnvironment, randomUUID())
}

export async function importWorkflowPackage(ownerId: string, raw: unknown) {
  const input = workflowImportSchema.parse(raw)
  const pack = validateWorkflowPackage(input.package)
  const versionId = randomUUID()
  const inserted = await pool.query(
    `INSERT INTO workflow_versions(id,workflow_id,revision,owner_id,name,status,environment,plan,imported_package,import_request_id,created_at,updated_at)
     VALUES($1,$2,1,$3,$4,'draft',$5,$6,$7,$8,now(),now())
     ON CONFLICT(owner_id,import_request_id) DO NOTHING RETURNING id`,
    [
      versionId,
      randomUUID(),
      ownerId,
      pack.name,
      JSON.stringify(pack.environment),
      JSON.stringify(workflowPlanFromPackage(pack)),
      JSON.stringify(pack),
      input.clientRequestId,
    ]
  )
  if (inserted.rowCount) return { versionId, reused: false }
  const previous = (
    await pool.query<{ id: string; imported_package: WorkflowPackage }>(
      "SELECT id,imported_package FROM workflow_versions WHERE owner_id=$1 AND import_request_id=$2",
      [ownerId, input.clientRequestId]
    )
  ).rows[0]
  if (!isDeepStrictEqual(previous.imported_package, pack))
    throw new HttpError(
      409,
      "The import request key already belongs to different package content"
    )
  return { versionId: previous.id, reused: true }
}
