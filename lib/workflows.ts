import { isDeepStrictEqual } from "node:util"
import { pool } from "@/db"
import type { CompletionContract } from "@/db/schema"
import { HttpError } from "@/lib/errors"
import type { PoolClient } from "pg"
import type { WorkflowPackage } from "@/lib/workflow-package"
import {
  bindWorkflowContract,
  bindWorkflowArtifact,
  validateWorkflowParameters,
  type WorkflowExecutionInput,
  type WorkflowExecution,
} from "@/lib/workflow-schema"
import {
  cleanWorkflowTrace,
  parameterizeWorkflowText,
  type WorkflowCompilation,
  type WorkflowCompilationInput,
  type WorkflowEnvironment,
  type WorkflowPlan,
} from "@/lib/workflow-schema"

export async function freezeWorkflowCompilation(
  ownerId: string,
  input: WorkflowCompilationInput,
  contract: CompletionContract
): Promise<WorkflowCompilation> {
  const source = (
    await pool.query(
      `SELECT t.id,t.agent_id,t.active_segment,t.status,t.completion_contract,t.result,w.container_name
     FROM tasks t LEFT JOIN workstation_control w ON w.agent_id=t.agent_id
     WHERE t.id=$1 AND t.owner_id=$2`,
      [input.sourceTaskId, ownerId]
    )
  ).rows[0]
  if (!source) throw new HttpError(404, "Source task not found")
  if (
    source.status !== "completed" ||
    source.active_segment !== 1 ||
    source.result?.verification?.grade !== "program_checked" ||
    source.result?.directoryTree?.checkerId !== "directory-tree-v1" ||
    !source.completion_contract.directoryTree ||
    source.completion_contract.artifact ||
    !source.container_name
  )
    throw new HttpError(
      409,
      "Compilation currently requires a single-segment host-checked directory task with its retained workstation"
    )
  if (!isDeepStrictEqual(contract, source.completion_contract))
    throw new HttpError(
      400,
      "Confirm the unchanged source completion contract before compilation"
    )
  const names = input.parameters.map((p) => p.name),
    samples = input.parameters.map((p) => p.sourceValue)
  if (new Set(names).size !== names.length || new Set(samples).size !== samples.length)
    throw new HttpError(400, "Workflow parameter names and source values must be unique")
  const tree = source.completion_contract.directoryTree as NonNullable<
    CompletionContract["directoryTree"]
  >
  if (
    samples.some((value, index) =>
      samples.some((other, j) => index !== j && value.includes(other))
    )
  )
    throw new HttpError(400, "Use nonoverlapping source values for workflow parameters")
  const segments = [tree.root.slice(12), ...tree.directories, ...tree.absent].flatMap(
    (value) => value.split("/")
  )
  if (samples.some((value) => !segments.includes(value)))
    throw new HttpError(
      400,
      "Declare source directory names from the checked contract as parameters"
    )
  const actions = (
    await pool.query(
      `SELECT action_no,kind,input,status,jsonb_build_object('output',jsonb_build_object('window',receipt->'output'->'window')) AS receipt
     FROM task_actions WHERE task_id=$1 AND segment_no=1 ORDER BY action_no LIMIT 201`,
      [source.id]
    )
  ).rows
  if (
    !actions.length ||
    actions.length > 200 ||
    actions.some((action) => action.status !== "succeeded")
  )
    throw new HttpError(
      409,
      "Compilation needs a bounded source trace with confirmed action receipts"
    )
  const humans = (
    await pool.query<{ action_no: number | null }>(
      "SELECT action_no FROM task_requests WHERE task_id=$1 AND kind='takeover' AND status='resolved' ORDER BY created_at",
      [source.id]
    )
  ).rows
  const bind = (value: string) => parameterizeWorkflowText(value, input.parameters)
  return {
    ...input,
    sourceSegment: 1,
    sourceActionNumbers: actions.map((action) => action.action_no),
    sourceContainerName: source.container_name,
    contract: {
      root: bind(tree.root),
      directories: tree.directories.map(bind),
      absent: tree.absent.map(bind),
    },
    trace: cleanWorkflowTrace(
      actions,
      input.parameters,
      tree,
      humans.map((request) => request.action_no)
    ),
  }
}

export type WorkflowVersion = {
  id: string
  workflowId: string
  revision: number
  name: string
  sourceTaskId: string | null
  compilationTaskId: string | null
  compilationStatus: string | null
  importedPackage: WorkflowPackage | null
  status: "draft" | "verifying" | "ready" | "retired" | "rejected"
  environment: WorkflowEnvironment | null
  validatedEnvironment: WorkflowEnvironment | null
  plan: WorkflowPlan | null
  createdAt: string
}
export async function listWorkflowVersions(ownerId: string) {
  return (
    await pool.query<WorkflowVersion>(
      `SELECT id,workflow_id AS "workflowId",revision,name,source_task_id AS "sourceTaskId",
     compilation_task_id AS "compilationTaskId",(SELECT status FROM tasks WHERE id=compilation_task_id) AS "compilationStatus",status,environment,validated_environment AS "validatedEnvironment",plan,created_at AS "createdAt"
     ,imported_package AS "importedPackage" FROM workflow_versions WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [ownerId]
    )
  ).rows
}
export async function getWorkflowVersion(ownerId: string, id: string) {
  const version = (
    await pool.query<WorkflowVersion>(
      `SELECT id,workflow_id AS "workflowId",revision,name,source_task_id AS "sourceTaskId",
     compilation_task_id AS "compilationTaskId",(SELECT status FROM tasks WHERE id=compilation_task_id) AS "compilationStatus",status,environment,validated_environment AS "validatedEnvironment",plan,created_at AS "createdAt"
     ,imported_package AS "importedPackage" FROM workflow_versions WHERE id=$1 AND owner_id=$2`,
      [id, ownerId]
    )
  ).rows[0]
  if (!version) throw new HttpError(404, "Workflow version not found")
  return version
}

export async function requireReadyWorkflow(ownerId: string, id: string) {
  const version = await getWorkflowVersion(ownerId, id)
  if (version.status !== "ready" || !version.plan)
    throw new HttpError(
      409,
      "This workflow candidate has not passed independent execution checks"
    )
  return version
}

export async function freezeWorkflowExecution(
  client: PoolClient,
  ownerId: string,
  input: WorkflowExecutionInput
): Promise<{ execution: WorkflowExecution; completionContract: CompletionContract }> {
  const version = (
    await client.query<{
      plan: WorkflowPlan | null
      status: string
      validated_environment: WorkflowEnvironment | null
      imported_package: WorkflowPackage | null
    }>(
      "SELECT plan,status,validated_environment,imported_package FROM workflow_versions WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [input.versionId, ownerId]
    )
  ).rows[0]
  if (!version) throw new HttpError(404, "Workflow version not found")
  if (
    !version.plan ||
    (input.purpose === "verify"
      ? version.status !== "verifying" &&
        !(
          version.status === "draft" &&
          (version.plan.repairOrigin || version.imported_package)
        )
      : version.status !== "ready" || !version.validated_environment)
  )
    throw new HttpError(
      409,
      input.purpose === "verify"
        ? "Only compiled candidates can be independently verified"
        : "This workflow candidate has not passed independent execution checks"
    )
  const parameters = validateWorkflowParameters(version.plan, input.parameters)
  const artifact = version.plan.artifact
    ? bindWorkflowArtifact(version.plan, parameters)
    : undefined
  const tree = bindWorkflowContract(version.plan.completion, parameters)
  if (tree.directories.some((value) => tree.absent.includes(value)))
    throw new HttpError(400, "Required and absent directory names must differ")
  if (version.status === "draft")
    await client.query(
      "UPDATE workflow_versions SET status='verifying',updated_at=now() WHERE id=$1",
      [input.versionId]
    )
  return {
    execution: {
      ...input,
      parameters,
      plan: version.plan,
      validatedEnvironment: version.validated_environment,
    },
    completionContract: {
      ...(artifact ? { artifact } : { directoryTree: tree }),
      requireHumanReview: false,
    },
  }
}
