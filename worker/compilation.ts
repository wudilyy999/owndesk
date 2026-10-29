import { pool } from "@/db"
import type { Task } from "@/db/schema"
import { docker } from "@/lib/docker"
import {
  validateWorkflowCandidate,
  type WorkflowEnvironment,
  type WorkflowPlan,
} from "@/lib/workflow-schema"

// Only the worker inspects Docker. The web process freezes host-owned source metadata.
export async function captureCompilationEnvironment(
  task: Task
): Promise<WorkflowEnvironment> {
  const compilation = task.configSnapshot.workflowCompilation!
  const existing = (
    await pool.query<{ environment: WorkflowEnvironment | null }>(
      "SELECT environment FROM workflow_versions WHERE compilation_task_id=$1",
      [task.id]
    )
  ).rows[0].environment
  if (existing) return existing
  const [container] = JSON.parse(
    (
      await docker(["inspect", compilation.sourceContainerName], {
        maxOutputBytes: 100000,
      })
    ).stdout.toString()
  )
  const first = (
    await pool.query<{ created_at: Date }>(
      "SELECT created_at FROM task_actions WHERE task_id=$1 AND segment_no=$2 ORDER BY action_no LIMIT 1",
      [compilation.sourceTaskId, compilation.sourceSegment]
    )
  ).rows[0]
  if (new Date(container.Created).getTime() > first.created_at.getTime())
    throw new Error(
      "The retained source workstation was recreated; its original image cannot be established"
    )
  const protocol = Number(container.Config.Labels["personal-agent.protocol"])
  if (protocol !== 6) throw new Error("Compilation currently supports guest protocol 6")
  const locale = (container.Config.Env as string[])
    .find((value) => value.startsWith("LANG="))
    ?.slice(5)
  if (!locale)
    throw new Error("The retained source workstation does not declare its locale")
  const environment: WorkflowEnvironment = {
    workstationImageId: container.Image,
    guestProtocol: protocol,
    locale,
    application: "Thunar",
  }
  await pool.query(
    "UPDATE workflow_versions SET environment=$2,updated_at=now() WHERE compilation_task_id=$1",
    [task.id, JSON.stringify(environment)]
  )
  return environment
}

export async function buildWorkflowPlan(task: Task, raw: unknown): Promise<WorkflowPlan> {
  const compilation = task.configSnapshot.workflowCompilation!
  const candidate = validateWorkflowCandidate(raw, compilation)
  const environment = (
    await pool.query<{ environment: WorkflowEnvironment }>(
      "SELECT environment FROM workflow_versions WHERE compilation_task_id=$1",
      [task.id]
    )
  ).rows[0].environment
  return {
    ...candidate,
    schemaVersion: 1,
    parameters: compilation.parameters,
    completion: compilation.contract,
    environment,
    sourceTaskId: compilation.sourceTaskId,
    sourceSegment: compilation.sourceSegment,
    sourceActionNumbers: compilation.sourceActionNumbers,
  }
}
