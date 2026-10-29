import { isDeepStrictEqual } from "node:util"
import type { PoolClient } from "pg"
import { pool } from "@/db"
import type { Task } from "@/db/schema"
import {
  bindWorkflowText,
  type WorkflowCheckpoint,
  type WorkflowEnvironment,
  workflowRepairPlan,
} from "@/lib/workflow-schema"
import { docker, dockerRaw } from "@/lib/docker"
import { appendEventInTransaction } from "@/lib/task-events"
import { assertAgentControl, workspaceRow, workstationHealth } from "@/lib/workstation"
import { collectArtifacts, ArtifactValidationError } from "./artifacts"
import { createTaskRequest } from "./requests"
import type { Decision } from "./model"
import type { ActionResult } from "./actions"
import type { DispatchAuthorization } from "./actions"
import { repairWorkflowStep, type RepairDecision } from "./workflow-repair"

export type FlowDecision = Decision & {
  workflow: { step: number; capture: boolean; repairStep?: number }
}
type Run = {
  checkpoint: WorkflowCheckpoint
  environment: WorkflowEnvironment | null
  started_at: Date | null
}

export function workflowWindowMatches(frame: WorkflowCheckpoint["frame"], title: string) {
  return (
    !!frame?.window &&
    /"Thunar"/.test(frame.window.wmClass) &&
    frame.window.title === title
  )
}

export async function authorizeWorkflowDispatch(
  task: Task,
  actionNo: number
): Promise<DispatchAuthorization> {
  const execution = task.configSnapshot.workflowExecution!
  const row = (
    await pool.query<{ elapsed: string }>(
      "SELECT extract(epoch from clock_timestamp()-started_at)::text AS elapsed FROM task_workflow_runs WHERE task_id=$1",
      [task.id]
    )
  ).rows[0]
  if (
    actionNo > execution.maxActions ||
    Number(row.elapsed) >= execution.maxDurationSeconds
  )
    return {
      rejected:
        "Workflow action/time allowance exhausted before dispatch; no input was sent.",
    }
  return { authorized: true }
}

async function initialize(task: Task, run: Run) {
  const execution = task.configSnapshot.workflowExecution!
  const row = await workspaceRow(task.agentId)
  if (run.started_at && run.checkpoint.bootId === row.bootId) return run
  const health = (await workstationHealth(task.agentId)) as Awaited<
    ReturnType<typeof workstationHealth>
  > & { capabilities?: string[] }
  if (!health.capabilities?.includes("thunar-keyboard-v1"))
    throw new Error(
      "This workstation image lacks the thunar-keyboard-v1 adapter; drain and explicitly pair a supporting image"
    )
  const [container] = JSON.parse(
    (
      await docker(["inspect", row.containerName], { maxOutputBytes: 100000 })
    ).stdout.toString()
  )
  const locale = (container.Config.Env as string[])
    .find((value) => value.startsWith("LANG="))
    ?.slice(5)
  if (
    locale !== execution.plan.environment.locale ||
    health.protocolVersion !== execution.plan.environment.guestProtocol
  )
    throw new Error(
      "Workflow source locale/protocol is incompatible with this workstation"
    )
  const environment: WorkflowEnvironment = {
    workstationImageId: container.Image,
    guestProtocol: health.protocolVersion,
    locale,
    application: "Thunar",
  }
  if (
    execution.validatedEnvironment &&
    !isDeepStrictEqual(environment, execution.validatedEnvironment)
  )
    throw new Error(
      "Workflow was verified on a different workstation image; use that exact image or independently verify a new version"
    )
  if (run.environment && !isDeepStrictEqual(environment, run.environment))
    throw new Error(
      "The workflow workstation image changed during this run; no further input is authorized"
    )
  const root = task.completionContract.directoryTree!.root
  for (const flag of run.started_at ? [] : ["-e", "-L"]) {
    const result = await dockerRaw(["exec", row.containerName, "test", flag, root])
    if (result.exitCode === 0)
      throw new Error("Destination already exists; choose a new workflow directory")
    if (result.exitCode !== 1)
      throw new Error(`Cannot check workflow destination: ${result.stderr}`)
  }
  const updated = (
    await pool.query<Run>(
      "UPDATE task_workflow_runs SET environment=$2,checkpoint=$3,started_at=COALESCE(started_at,clock_timestamp()) WHERE task_id=$1 RETURNING checkpoint,environment,started_at",
      [
        task.id,
        JSON.stringify(environment),
        JSON.stringify({ ...run.checkpoint, bootId: health.bootId, frame: null }),
      ]
    )
  ).rows[0]
  return updated
}

function frameFrom(output: Record<string, unknown>): WorkflowCheckpoint["frame"] {
  if (typeof output.observationId !== "string") return null
  return {
    observationId: output.observationId,
    epoch: Number(output.epoch),
    bootId: String(output.bootId),
    window: output.window as NonNullable<WorkflowCheckpoint["frame"]>["window"],
  }
}

export async function refreshWorkflowObservation(
  task: Task,
  output: Record<string, unknown>
) {
  const run = (
    await pool.query<Run>("SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0]
  const checkpoint = { ...run.checkpoint, frame: frameFrom(output) }
  if (checkpoint.phase !== "blocked" && checkpoint.phase !== "repair")
    checkpoint.phase = "act"
  await pool.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
    task.id,
    JSON.stringify(checkpoint),
  ])
}

async function completionSatisfied(task: Task) {
  try {
    await collectArtifacts(
      task.id,
      task.activeSegment,
      0,
      task.agentId,
      [],
      task.completionContract
    )
    return true
  } catch (error) {
    if (error instanceof ArtifactValidationError) return false
    throw error
  }
}

export async function nextWorkflowDecision(
  task: Task,
  epoch: number,
  actionNo: number,
  iteration: number,
  afterHandback: boolean,
  decisionNo = iteration
): Promise<FlowDecision | RepairDecision> {
  const execution = task.configSnapshot.workflowExecution!
  const run = await initialize(
    task,
    (
      await pool.query<Run>(
        "SELECT checkpoint,environment,started_at FROM task_workflow_runs WHERE task_id=$1",
        [task.id]
      )
    ).rows[0]
  )
  const checkpoint = run.checkpoint
  const variant =
    checkpoint.repair?.status === "accepted" && checkpoint.repair.step === checkpoint.step
      ? checkpoint.repair
      : null
  const workspace = await assertAgentControl(task.id, task.agentId)
  const decision = (
    toolName: string,
    input: Record<string, unknown>,
    capture = false
  ): FlowDecision => {
    const call = { toolCallId: `workflow-${iteration}`, toolName, input }
    return {
      kind: "decision",
      epoch,
      text: "",
      calls: [call],
      messages: [{ role: "assistant", content: [{ type: "tool-call", ...call }] }],
      usage: { input: 0, output: 0, cached: 0, reasoning: 0, missing: false },
      costMicros: 0,
      workflow: {
        step: checkpoint.step,
        capture,
        ...(variant ? { repairStep: variant.cursor } : {}),
      },
    }
  }
  const finish = () =>
    decision("complete_task", {
      summary: `流程已执行并通过固定目录检查：${task.completionContract.directoryTree!.root}`,
      files: [],
    })
  if (
    (checkpoint.phase === "blocked" || afterHandback) &&
    (await completionSatisfied(task))
  )
    return finish()
  if (checkpoint.phase !== "blocked" && checkpoint.step >= execution.plan.steps.length)
    return finish()
  if (checkpoint.repair?.status === "requesting" && checkpoint.phase !== "blocked") {
    if (
      !checkpoint.frame ||
      checkpoint.frame.epoch !== workspace.epoch ||
      checkpoint.frame.bootId !== workspace.bootId
    )
      return decision("screen_capture", {}, true)
    return repairWorkflowStep(task, checkpoint, decisionNo, checkpoint.repair.failure)
  }
  const spentMs = Date.now() - new Date(run.started_at!).getTime()
  if (actionNo >= execution.maxActions || spentMs >= execution.maxDurationSeconds * 1000)
    Object.assign(checkpoint, {
      phase: "blocked",
      blockedReason:
        "Workflow action/time allowance exhausted; no further desktop input will be sent.",
    })
  const step = variant
    ? variant.steps![variant.cursor]
    : execution.plan.steps[checkpoint.step]
  if (checkpoint.phase !== "blocked" && ("when" in step || step.operation === "assert")) {
    const expected = bindWorkflowText(
      "when" in step ? step.when.title : step.window.title,
      execution.parameters
    )
    if (
      !checkpoint.frame ||
      checkpoint.frame.epoch !== workspace.epoch ||
      checkpoint.frame.bootId !== workspace.bootId ||
      checkpoint.phase === "observe"
    )
      return decision("screen_capture", {}, true)
    if (!workflowWindowMatches(checkpoint.frame, expected)) {
      if (
        checkpoint.waitStartedAt !== null &&
        Date.now() - checkpoint.waitStartedAt >= 10000
      ) {
        const failure = `Expected Thunar window ${expected}; observed ${checkpoint.frame.window?.title ?? "no active window"}. No input was sent for this step.`
        if (execution.allowRepair && !checkpoint.repair)
          return repairWorkflowStep(task, checkpoint, decisionNo, failure)
        Object.assign(checkpoint, {
          phase: "blocked",
          blockedReason: failure,
        })
      } else return decision("screen_capture", {}, true)
    }
  }
  if (checkpoint.phase === "blocked") {
    await pool.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
      task.id,
      JSON.stringify(checkpoint),
    ])
    const requestId = `${task.id}-workflow-review-${iteration}`
    await createTaskRequest(task.id, task.activeSegment, requestId, "review", {
      purpose: "workflow_review",
      reason: checkpoint.blockedReason,
      message:
        "The workflow is stopped. Inspect or manually complete the directory task, then continue to run its fixed result check. Previous uncertain input will not be repeated.",
      workflowStep: checkpoint.step,
      nextStep: step?.label ?? "Fixed completion check",
    })
    return { kind: "request", requestId }
  }
  switch (step.operation) {
    case "open_application":
      return decision("desktop_open_application", { application: step.application })
    case "observe":
      return decision(step.share ? "screen_share" : "screen_capture", {})
    case "assert":
      return decision("workflow_assert", {})
    case "human_checkpoint":
      return decision("request_takeover", { reason: step.reason })
    case "key_press":
      return decision("key_press", {
        observationId: checkpoint.frame!.observationId,
        key: step.key,
        modifiers: step.modifiers,
      })
    case "key_type":
      return decision("key_type", {
        observationId: checkpoint.frame!.observationId,
        text: bindWorkflowText(step.text, execution.parameters),
      })
  }
}

export async function advanceWorkflow(
  task: Task,
  decision: FlowDecision,
  result: ActionResult & { requestId?: string },
  actionNo: number
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    if (
      (
        await client.query("SELECT 1 FROM task_events WHERE task_id=$1 AND key=$2", [
          task.id,
          `workflow:${actionNo}`,
        ])
      ).rowCount
    ) {
      await client.query("COMMIT")
      return
    }
    const run = (
      await client.query<Run>(
        "SELECT checkpoint FROM task_workflow_runs WHERE task_id=$1 FOR UPDATE",
        [task.id]
      )
    ).rows[0]
    const checkpoint = run.checkpoint
    if (checkpoint.step !== decision.workflow.step)
      throw new Error("Workflow checkpoint changed outside its serialized executor")
    const variant =
      checkpoint.repair?.status === "accepted" &&
      checkpoint.repair.step === checkpoint.step
        ? checkpoint.repair
        : null
    if (variant && variant.cursor !== decision.workflow.repairStep)
      throw new Error("Workflow repair cursor changed outside its serialized executor")
    if (result.needsReview || (!result.ok && !result.stale)) {
      checkpoint.phase = "blocked"
      checkpoint.blockedReason = String(
        result.output.error ??
          "Previous action has an unconfirmed effect. Inspect without repeating it."
      )
      checkpoint.frame = null
    } else if (result.stale) {
      checkpoint.phase = "observe"
      checkpoint.frame = null
    } else if (decision.workflow.capture) {
      checkpoint.phase = checkpoint.repair?.status === "requesting" ? "repair" : "act"
      checkpoint.frame = frameFrom(result.output)
      checkpoint.waitStartedAt ??= Date.now()
    } else {
      if (variant) {
        variant.cursor++
        if (variant.cursor === variant.steps!.length) checkpoint.step++
      } else checkpoint.step++
      checkpoint.phase = "observe"
      checkpoint.frame = null
      checkpoint.waitStartedAt = null
    }
    await client.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
      task.id,
      JSON.stringify(checkpoint),
    ])
    await appendEventInTransaction(
      client,
      task.id,
      `workflow:${actionNo}`,
      "workflow_step",
      {
        versionId: task.configSnapshot.workflowExecution!.versionId,
        step: decision.workflow.step,
        nextStep: checkpoint.step,
        actionNo,
        phase: checkpoint.phase,
        capture: decision.workflow.capture,
        ...(variant
          ? { repairStep: decision.workflow.repairStep, nextRepairStep: variant.cursor }
          : {}),
      }
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function completeWorkflowRun(client: PoolClient, task: Task) {
  const execution = task.configSnapshot.workflowExecution!
  await client.query(
    "SELECT id FROM workflow_versions WHERE workflow_id=(SELECT workflow_id FROM workflow_versions WHERE id=$1) ORDER BY revision FOR UPDATE",
    [execution.versionId]
  )
  const current = (
    await client.query<{
      environment: WorkflowEnvironment
      checkpoint: WorkflowCheckpoint
    }>(
      "UPDATE task_workflow_runs SET completed_at=clock_timestamp() WHERE task_id=$1 RETURNING environment,checkpoint",
      [task.id]
    )
  ).rows[0]
  const repair = current.checkpoint.repair
  if (repair) {
    const unknown = await client.query(
      "SELECT 1 FROM task_actions WHERE task_id=$1 AND status='unknown' LIMIT 1",
      [task.id]
    )
    if (
      repair.status === "accepted" &&
      repair.cursor === repair.steps!.length &&
      current.checkpoint.step === execution.plan.steps.length &&
      current.checkpoint.phase !== "blocked" &&
      !unknown.rowCount
    ) {
      const draftId = `${task.id}-workflow-revision`
      const plan = {
        ...workflowRepairPlan(execution.plan, {
          step: repair.step,
          steps: repair.steps!,
        }),
        repairOrigin: {
          versionId: execution.versionId,
          taskId: task.id,
          step: repair.step,
        },
      }
      await client.query(
        `INSERT INTO workflow_versions(id,workflow_id,revision,owner_id,name,source_task_id,compilation_task_id,status,environment,plan,imported_package,created_at,updated_at)
         SELECT $1,v.workflow_id,(SELECT max(revision)+1 FROM workflow_versions WHERE workflow_id=v.workflow_id),v.owner_id,v.name,v.source_task_id,$2,'draft',v.environment,$3,v.imported_package,now(),now()
         FROM workflow_versions v WHERE v.id=$4 ON CONFLICT(id) DO NOTHING`,
        [draftId, task.id, JSON.stringify(plan), execution.versionId]
      )
      current.checkpoint.repair!.draftVersionId = draftId
      await client.query("UPDATE task_workflow_runs SET checkpoint=$2 WHERE task_id=$1", [
        task.id,
        JSON.stringify(current.checkpoint),
      ])
      await appendEventInTransaction(
        client,
        task.id,
        "workflow-repair:draft",
        "workflow_repair",
        { phase: "draft", versionId: draftId, sourceVersionId: execution.versionId }
      )
    }
    return
  }
  if (execution.purpose !== "verify") return
  const rows = (
    await client.query<{
      parameters: Record<string, string>
      environment: WorkflowEnvironment
    }>(
      `SELECT r.parameters,r.environment FROM task_workflow_runs r JOIN tasks t ON t.id=r.task_id
     WHERE r.version_id=$1 AND r.purpose='verify' AND r.completed_at IS NOT NULL AND t.status='completed'
     AND t.result->'directoryTree'->>'grade'='program_checked'
     AND (r.checkpoint->>'step')::int=jsonb_array_length(t.config_snapshot->'workflowExecution'->'plan'->'steps')
     AND r.checkpoint->>'phase'<>'blocked'
     AND NOT (r.checkpoint ? 'repair')
     AND NOT EXISTS(SELECT 1 FROM task_actions a WHERE a.task_id=t.id AND a.status='unknown')
     ORDER BY r.completed_at`,
      [execution.versionId]
    )
  ).rows
  const matching = rows.filter((row) =>
    isDeepStrictEqual(row.environment, current.environment)
  )
  const distinct = new Set(
    matching.map((row) =>
      JSON.stringify(Object.fromEntries(Object.entries(row.parameters).sort()))
    )
  )
  if (distinct.size >= 3)
    await client.query(
      "UPDATE workflow_versions SET status='ready',validated_environment=$2,updated_at=now() WHERE id=$1 AND status='verifying'",
      [execution.versionId, JSON.stringify(current.environment)]
    )
}
