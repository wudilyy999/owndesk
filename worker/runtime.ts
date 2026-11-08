import { executeConnectionTool } from "./connections"
import { readUpload } from "@/lib/uploads"
import { importTaskUploads } from "./uploads"
import { DBOS } from "@dbos-inc/dbos-sdk"
import type { ModelMessage, ToolModelMessage } from "ai"
import { z } from "zod"
import { db, pool } from "@/db"
import { eq } from "drizzle-orm"
import { tasks, budgetChangesSchema, type Task, type SegmentSnapshot } from "@/db/schema"
import {
  toolsForCoordinateMode,
  toolsForTask,
  isAgentTool,
  desktopToolNames,
} from "@/lib/agent/tools"
import { buildInstructions } from "@/lib/agent/instructions"
import { requestCancellation, requestTakeover } from "@/lib/task-control"
import { appendEvent, appendEventInTransaction } from "@/lib/task-events"
import { recallNotes } from "@/lib/companion/memory"
import { taskMemoryContext } from "@/lib/task-memory"
import { hasTaskSupplement, taskSupplements } from "@/lib/task-supplements"
import { companionTaskText, loadCompanionTaskImage } from "@/lib/companion/task-context"
import { loadManual, manualDraftSchema } from "@/lib/manual-schema"
import {
  acquireWorkspace,
  assertAgentControl,
  controller,
  ensureWorkstation,
  releaseWorkspace,
  stopWorkstationBoundary,
  TaskCancelled,
  SegmentSuperseded,
  workstationHealth,
  workspaceRow,
  WorkspacePaused,
  withWorkspaceOperation,
} from "@/lib/workstation"
import { decide, ModelRequestError } from "./model"
import {
  executeAction,
  requestReview,
  type ActionKind,
  type ActionResult,
} from "./actions"
import { ArtifactValidationError, collectArtifacts, type Deliverable } from "./artifacts"
import { createTaskRequest } from "./requests"
import { revokeDesktop } from "./desktop-gateway"
import { trackActivity } from "./activity"
import { executeMemoryTool } from "./memory"
import { executeLifeTool, lifePathAllowed, LIFE_DIR } from "./life"
import { executeAgentZeroTool } from "./agent-zero"
import { listVault } from "@/lib/vault"
import { vaultOriginSchema } from "@/lib/vault-schema"
import type { VaultFillInput } from "@/lib/vault-schema"
import { executeVaultFill } from "./vault"
import { createPaymentRequest } from "./payments"
import type { PaymentInput } from "@/lib/payment-schema"
import type { PaymentSubmitInput, PaymentResultInput } from "@/lib/payment-schema"
import { executePaymentSubmit, executePaymentResult } from "./payment-submission"
import { executeDelegate, importHandoffFiles } from "./delegation"
import { buildWorkflowPlan, captureCompilationEnvironment } from "./compilation"
import {
  WorkflowValidationError,
  workflowApplicationSchema,
  type WorkflowPlan,
} from "@/lib/workflow-schema"
import {
  nextWorkflowDecision,
  advanceWorkflow,
  completeWorkflowRun,
  refreshWorkflowObservation,
  type FlowDecision,
  authorizeWorkflowDispatch,
} from "./workflow-execution"

type ToolResult = ActionResult & {
  paused?: boolean
  requestId?: string
  completed?: boolean
  delegated?: boolean
}
type UserReply = {
  requestId: string
  decision: string
  response?: Record<string, unknown>
}

async function resolveRequest(taskId: string, requestId: string, reply: UserReply) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{
      active_segment: number
      cancel_requested_at: Date | null
      budget: Task["budget"]
    }>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId])
    if (task.cancel_requested_at) throw new TaskCancelled()
    const {
      rows: [request],
    } = await client.query<{
      kind: string
      payload: Record<string, unknown>
      status: string
      decision: string
      response: Record<string, unknown>
    }>("SELECT * FROM task_requests WHERE id=$1 AND task_id=$2 FOR UPDATE", [
      requestId,
      taskId,
    ])
    if (request.kind === "takeover") {
      await client.query("COMMIT")
      return {
        note: String(
          request.response?.note ??
            "Human control returned. Inspect the current screen and pages."
        ),
        connectionApproved: false,
        completionApproved: false,
        vaultFillApproved: false,
        paymentSubmitApproved: false,
        takeover: true,
      }
    }
    if (request.status === "pending" || request.decision !== reply.decision)
      throw new Error("Request message does not match its committed decision")
    if (request.payload.purpose === "model_retry" && request.decision === "continue") {
      await client.query(
        "UPDATE task_model_decisions SET status='retryable' WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND status='pending'",
        [taskId, task.active_segment, request.payload.decisionNo]
      )
    }
    if (
      request.kind === "budget" &&
      request.payload.purpose === "limits" &&
      request.decision === "continue"
    ) {
      const changes = budgetChangesSchema.parse(request.response.budget)
      const budget = { ...task.budget, ...changes }
      if (budget.maxCostMicros === null) delete budget.maxCostMicros
      await client.query("UPDATE tasks SET budget=$2 WHERE id=$1", [
        taskId,
        JSON.stringify(budget),
      ])
    }
    if (
      request.payload.purpose === "execution_error" &&
      request.decision === "continue"
    ) {
      await client.query(
        "UPDATE task_model_decisions SET status='retryable' WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND status='failed'",
        [taskId, task.active_segment, request.payload.decisionNo]
      )
    }
    await client.query(
      "UPDATE task_requests SET status='resolved',resolved_at=now() WHERE id=$1",
      [requestId]
    )
    await client.query(
      "UPDATE tasks SET status='running',error=NULL,updated_at=now() WHERE id=$1",
      [taskId]
    )
    await appendEventInTransaction(
      client,
      taskId,
      `resolved:${requestId}`,
      "request_resolved",
      { requestId, decision: request.decision, response: request.response }
    )
    await client.query("COMMIT")
    return {
      note: `Decision: ${request.decision}. ${JSON.stringify(request.response)}`,
      connectionApproved:
        request.payload.purpose === "connection_call" && request.decision === "approve",
      completionApproved:
        request.payload.purpose === "completion" && request.decision === "complete",
      vaultFillApproved:
        request.payload.purpose === "vault_fill" && request.decision === "approve",
      paymentSubmitApproved:
        request.payload.purpose === "payment_submit" && request.decision === "approve",
      takeover: false,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

async function waitForRequest(task: Pick<Task, "id" | "ownerId">, requestId: string) {
  let reply: UserReply | null = null
  while (!reply) reply = await DBOS.recv<UserReply>(requestId, { timeoutSeconds: 86400 })
  if (reply.decision === "cancel") {
    await DBOS.runStep(() => requestCancellation(task.ownerId, task.id), {
      name: "owner-ended-task",
    })
    throw new TaskCancelled()
  }
  return DBOS.runStep(() => resolveRequest(task.id, requestId, reply!), {
    name: "resolve-owner-request",
  })
}

async function controlState(task: Pick<Task, "id" | "agentId" | "activeSegment">) {
  const [state] = await db.select().from(tasks).where(eq(tasks.id, task.id))
  if (state.cancelRequestedAt || state.status === "cancelled") throw new TaskCancelled()
  if (state.activeSegment !== task.activeSegment) throw new SegmentSuperseded()
  const handbacks = (
    await pool.query<{ id: string; response: Record<string, unknown> | null }>(
      "SELECT id,response FROM task_requests WHERE task_id=$1 AND segment_no=$2 AND kind='takeover' AND status='resolved' ORDER BY resolved_at",
      [task.id, task.activeSegment]
    )
  ).rows
  const existing = await pool.query(
    "SELECT agent_id FROM workstation_control WHERE agent_id=$1",
    [task.agentId]
  )
  if (!existing.rowCount) await ensureWorkstation(task.agentId)
  let workspace = await workspaceRow(task.agentId)
  if (workspace.mode === "quarantined") {
    const id = `${task.id}-control-e${workspace.epoch}`
    await createTaskRequest(task.id, task.activeSegment, id, "review", {
      purpose: "control_recovery",
      reason: workspace.lastError ?? "Workstation requires a confirmed fresh start",
    })
    return { requestId: id, epoch: workspace.epoch, budget: state.budget, handbacks }
  }
  if (
    workspace.mode === "human" ||
    workspace.desiredMode === "human" ||
    workspace.desiredMode === "agent"
  )
    return {
      requestId: workspace.requestId!,
      epoch: workspace.epoch,
      budget: state.budget,
      handbacks,
    }
  await ensureWorkstation(task.agentId)
  const health = await workstationHealth(task.agentId)
  if (
    workspace.activeTaskId !== task.id ||
    workspace.mode !== "agent" ||
    health.bootId !== workspace.bootId ||
    health.epoch !== workspace.epoch
  )
    workspace = await acquireWorkspace(
      task,
      state.configSnapshot.lifeSession ? "life" : "errand"
    )
  return { requestId: null, epoch: workspace.epoch, budget: state.budget, handbacks }
}

async function restoreReviewedWorkspace(
  task: Pick<Task, "id" | "agentId" | "activeSegment">
) {
  const row = await workspaceRow(task.agentId)
  if (row.mode !== "quarantined") return
  await withWorkspaceOperation(task.agentId, async () => {
    await revokeDesktop(task.agentId)
    await stopWorkstationBoundary(task.agentId)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const {
        rows: [state],
      } = await client.query<{ cancel_requested_at: Date | null }>(
        "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
        [task.id]
      )
      if (state.cancel_requested_at) throw new TaskCancelled()
      await client.query(
        "UPDATE workstation_control SET mode='idle',desired_mode=NULL,request_id=NULL,last_error=NULL WHERE agent_id=$1 AND active_task_id=$2",
        [task.agentId, task.id]
      )
      await client.query(
        "UPDATE task_requests SET status='cancelled',resolved_at=now() WHERE task_id=$1 AND kind='takeover' AND status IN ('pending','decided')",
        [task.id]
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })
}

function modelOutput(output: Record<string, unknown>) {
  if (typeof output.image !== "string")
    return { type: "json" as const, value: JSON.parse(JSON.stringify(output)) }
  const { image, ...metadata } = output
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(metadata) },
      {
        type: "file" as const,
        mediaType: String(output.mediaType),
        data: { type: "data" as const, data: image },
      },
    ],
  }
}
function toolMessage(
  call: { toolCallId: string; toolName: string },
  result: ToolResult
): ToolModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: modelOutput({ ...result.output, ok: result.ok }),
      },
    ],
  }
}

function appendToolResult(
  history: ModelMessage[],
  call: { toolCallId: string; toolName: string },
  result: ToolResult
) {
  const message = toolMessage(call, result)
  const previous = history.at(-1)
  // Keep the whole tool batch together before lifting screenshots into a user message.
  if (previous?.role === "tool")
    history[history.length - 1] = {
      ...previous,
      content: [...previous.content, ...message.content],
    }
  else history.push(message)
}

async function finishTask(
  task: Task,
  segmentNo: number,
  result: Record<string, unknown>,
  plan?: WorkflowPlan,
  ownerMessageSeq?: number
): Promise<ToolResult> {
  await releaseWorkspace(task.id, task.agentId)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [state],
    } = await client.query(
      "SELECT cancel_requested_at,active_segment,status,result FROM tasks WHERE id=$1 FOR UPDATE",
      [task.id]
    )
    if (state.cancel_requested_at) throw new TaskCancelled()
    if (state.active_segment !== segmentNo) throw new SegmentSuperseded()
    if (state.status === "completed") {
      await client.query("COMMIT")
      return { ok: true, completed: true, output: state.result }
    }
    if (ownerMessageSeq !== undefined) {
      const pending = await client.query(
        "SELECT 1 FROM task_events WHERE task_id=$1 AND type='owner_supplement' AND seq>$2 LIMIT 1",
        [task.id, ownerMessageSeq]
      )
      if (pending.rowCount) {
        await client.query("COMMIT")
        return {
          ok: false,
          stale: true,
          output: {
            error: "Read the new owner instructions before completing this task",
          },
        }
      }
    }
    if (plan)
      await client.query(
        "UPDATE workflow_versions SET plan=$2,status='verifying',updated_at=now() WHERE compilation_task_id=$1",
        [task.id, JSON.stringify(plan)]
      )
    await client.query(
      "UPDATE tasks SET status='completed',result=$2,error=NULL,updated_at=now() WHERE id=$1",
      [task.id, JSON.stringify(result)]
    )
    if (task.configSnapshot.workflowExecution) await completeWorkflowRun(client, task)
    if (task.threadId) {
      await client.query(
        `INSERT INTO messages(id,thread_id,role,parts,metadata,created_at)
         VALUES($1,$2,'assistant',$3,$4,clock_timestamp()) ON CONFLICT(id) DO NOTHING`,
        [
          `${task.id}-answer`,
          task.threadId,
          JSON.stringify([{ type: "text", text: result.summary }]),
          JSON.stringify({
            taskId: task.id,
            agentId: task.agentId,
            model: task.configSnapshot.model,
            threadTurn: task.threadTurn,
          }),
        ]
      )
      await client.query(
        "UPDATE threads SET active_at=clock_timestamp(),preview=$2 WHERE id=$1",
        [task.threadId, String(result.summary).slice(0, 200)]
      )
    }
    await appendEventInTransaction(
      client,
      task.id,
      `completed:${segmentNo}`,
      "completed",
      {
        message: result.summary,
        files: result.files,
        verification: result.verification,
        ...(result.comparison
          ? { comparison: result.comparison, notification: result.notification }
          : {}),
        ...(result.workflow ? { workflow: result.workflow } : {}),
        ...(result.manualDraft
          ? { manual: { draftTaskId: task.id, status: "draft" } }
          : {}),
      }
    )
    await client.query("COMMIT")
    return { ok: true, completed: true, output: result }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

async function runTool(
  task: Task,
  segmentNo: number,
  actionNo: number,
  toolName: string,
  raw: Record<string, unknown>,
  epoch: number,
  ownerMessageSeq?: number
): Promise<ToolResult> {
  if (
    ownerMessageSeq !== undefined &&
    (await hasTaskSupplement(task.id, ownerMessageSeq))
  ) {
    // A saved or uncertain effect must still be reconciled after a lost framework checkpoint.
    const started = await pool.query(
      "SELECT 1 FROM task_actions WHERE task_id=$1 AND segment_no=$2 AND action_no=$3",
      [task.id, segmentNo, actionNo]
    )
    if (!started.rowCount)
      return {
        ok: false,
        stale: true,
        output: {
          error:
            "New owner instructions arrived; read them before deciding the next action.",
        },
      }
  }
  if (
    task.configSnapshot.workstationChannel === "desktop" &&
    !desktopToolNames.has(toolName) &&
    toolName !== "workflow_assert"
  )
    return {
      ok: false,
      output: {
        error:
          "This task permits native desktop tools only; no non-desktop effect was dispatched.",
      },
    }
  if (task.configSnapshot.workflowExecution && toolName === "workflow_assert") {
    const current = await assertAgentControl(task.id, task.agentId)
    if (current.epoch !== epoch)
      return {
        ok: false,
        stale: true,
        output: { error: "Control changed during the workflow assertion" },
      }
    return {
      ok: true,
      output: { checked: "current Thunar window", evidence: "guest_window_state" },
    }
  }
  if (task.configSnapshot.workflowCompilation) {
    if (toolName !== "submit_workflow")
      return { ok: false, output: { error: "Compilation exposes submit_workflow only" } }
    let plan: WorkflowPlan
    try {
      plan = await buildWorkflowPlan(task, raw)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof WorkflowValidationError)
        return { ok: false, output: { error: error.message } }
      throw error
    }
    const workspace = await assertAgentControl(task.id, task.agentId)
    if (workspace.epoch !== epoch)
      return {
        ok: false,
        stale: true,
        output: { error: "Control changed; compile from the frozen source again" },
      }
    const result = {
      summary: `已生成流程候选：${task.configSnapshot.workflowCompilation.name}。等待独立样例验证，尚未启用。`,
      files: [],
      workflow: { versionId: task.id, status: "verifying", steps: plan.steps.length },
      verification: {
        grade: "schema_checked",
        unverified: ["Candidate execution and cross-input reuse have not been verified."],
      },
    }
    return finishTask(task, segmentNo, result, plan)
  }
  if (task.configSnapshot.manualCompilation) {
    if (toolName !== "submit_manual")
      return {
        ok: false,
        output: { error: "Manual drafting exposes submit_manual only" },
      }
    const parsed = manualDraftSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, output: { error: parsed.error.message } }
    const current = await assertAgentControl(task.id, task.agentId)
    if (current.epoch !== epoch)
      return {
        ok: false,
        stale: true,
        output: { error: "Control changed; draft again from the frozen source" },
      }
    return finishTask(task, segmentNo, {
      summary: `已生成操作手册草稿：${parsed.data.name}。请审阅和编辑后保存，当前尚未启用。`,
      files: [],
      manualDraft: parsed.data,
      verification: {
        grade: "schema_checked",
        unverified: [
          "This manual has not been execution-certified. Source success proves only the original instance.",
        ],
      },
    })
  }
  const internalLaunch =
    (task.configSnapshot.workflowExecution ||
      task.configSnapshot.workstationChannel === "desktop") &&
    toolName === "desktop_open_application"
  if (!isAgentTool(toolName) && !internalLaunch)
    return { ok: false, output: { error: `Unknown tool: ${toolName}` } }
  // All local tools declare Zod object schemas; the SDK widens inputSchema to FlexibleSchema.
  const parsed = (
    internalLaunch
      ? z.object({ application: workflowApplicationSchema })
      : (toolsForCoordinateMode(task.configSnapshot.desktopCoordinateMode ?? "pixels")[
          toolName as keyof ReturnType<typeof toolsForCoordinateMode>
        ].inputSchema as z.ZodObject)
  ).safeParse(raw)
  if (!parsed.success) return { ok: false, output: { error: parsed.error.message } }
  const input = parsed.data as Record<string, unknown>
  if (toolName === "load_task_image") {
    if (task.configSnapshot.lifeSession)
      return { ok: false, output: { error: "This tool requires an owner task" } }
    const context = task.configSnapshot.companionContext
    const control = await assertAgentControl(task.id, task.agentId, segmentNo)
    let output
    if (context?.images.some((image) => image.id === input.id))
      output = await loadCompanionTaskImage(context, String(input.id))
    else {
      const attached =
        task.configSnapshot.attachments?.find((file) => file.id === input.id) ??
        (await taskSupplements(task.id))
          .flatMap((note) => note.attachments ?? [])
          .find((file) => file.id === input.id)
      if (!attached?.mediaType.startsWith("image/"))
        return { ok: false, output: { error: "Use a picture ID attached to this task" } }
      const file = await readUpload(task.ownerId, attached.id)
      output = {
        available: true,
        image: file.bytes.toString("base64"),
        mediaType: file.mediaType,
      }
    }
    return {
      ok: output.available,
      output: {
        ...output,
        epoch: control.epoch,
        bootId: control.bootId,
        source: "task_attachment",
      },
    }
  }
  if (task.configSnapshot.lifeSession) {
    // toolsForTask already limits the model; this is the server-side check of what it called
    if (!Object.hasOwn(toolsForTask(task.configSnapshot), toolName))
      return {
        ok: false,
        output: { error: "This tool is not available in your own time." },
      }
    if (toolName.startsWith("fs_") && !lifePathAllowed(String(input.path ?? ".")))
      return {
        ok: false,
        output: { error: `In your own time you may only use files under ${LIFE_DIR}.` },
      }
    if (
      toolName === "life_log" ||
      toolName === "life_share" ||
      toolName === "coview_reply"
    )
      return executeLifeTool(task.id, segmentNo, actionNo, toolName, input, epoch)
  }
  if (toolName === "connection_call")
    return executeConnectionTool(task, segmentNo, actionNo, input, epoch, ownerMessageSeq)
  if (toolName === "recall_memory") {
    const output = await recallNotes(task.agentId, input)
    return { ok: !("error" in output), output }
  }
  if (toolName === "load_manual") {
    const result = loadManual(task.configSnapshot.manuals ?? [], String(input.id))
    if (result.ok)
      await appendEvent(
        task.id,
        `manual-loaded:${segmentNo}:${actionNo}`,
        "manual_loaded",
        {
          id: result.output.id,
          name: result.output.name,
        }
      )
    return result
  }
  if (toolName === "agent_zero_call")
    return executeAgentZeroTool(task, segmentNo, actionNo, input, epoch, ownerMessageSeq)
  if (toolName === "list_agents")
    return {
      ok: true,
      output: {
        agents: (
          await pool.query(
            "SELECT id,name,role FROM agents WHERE id=ANY($1::text[]) AND model IS DISTINCT FROM 'fixture/durable-report' ORDER BY name,id",
            [task.requestPayload.delegateAgentIds ?? []]
          )
        ).rows,
      },
    }
  if (toolName === "delegate")
    return executeDelegate(
      task,
      segmentNo,
      actionNo,
      input as NonNullable<SegmentSnapshot["handoff"]>["input"],
      epoch
    )
  if (toolName === "vault_list") return { ok: true, output: { items: await listVault() } }
  if (toolName === "memory_write" || toolName === "memory_forget")
    return executeMemoryTool(task.id, segmentNo, actionNo, toolName, input, epoch)
  if (toolName === "request_payment_approval")
    return createPaymentRequest(task, segmentNo, actionNo, input as PaymentInput, epoch)
  if (
    !["complete_task", "request_takeover", "ask_user", "request_secret"].includes(
      toolName
    )
  ) {
    try {
      if (toolName === "payment_submit")
        return await executePaymentSubmit(
          task,
          segmentNo,
          actionNo,
          input as PaymentSubmitInput,
          epoch,
          ownerMessageSeq
        )
      if (toolName === "payment_result")
        return await executePaymentResult(
          task,
          segmentNo,
          actionNo,
          input as PaymentResultInput,
          epoch,
          ownerMessageSeq
        )
      if (toolName === "vault_fill")
        return await executeVaultFill(
          task,
          segmentNo,
          actionNo,
          input as VaultFillInput,
          epoch,
          ownerMessageSeq
        )
      return await executeAction(
        task.id,
        segmentNo,
        actionNo,
        toolName as ActionKind,
        input,
        epoch,
        task.configSnapshot.workflowExecution
          ? () => authorizeWorkflowDispatch(task, actionNo)
          : undefined,
        ownerMessageSeq
      )
    } catch (error) {
      if (
        error instanceof TaskCancelled ||
        error instanceof SegmentSuperseded ||
        error instanceof WorkspacePaused
      )
        throw error
      const pending = await pool.query(
        "SELECT 1 FROM task_actions WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND status='intent'",
        [task.id, segmentNo, actionNo]
      )
      if (!pending.rowCount) throw error
      const message = error instanceof Error ? error.message : String(error)
      return withWorkspaceOperation(task.agentId, async () => {
        const state = (
          await pool.query<{ cancel_requested_at: Date | null }>(
            "SELECT cancel_requested_at FROM tasks WHERE id=$1",
            [task.id]
          )
        ).rows[0]
        if (state.cancel_requested_at) throw new TaskCancelled()
        const row = await workspaceRow(task.agentId)
        if (row.mode !== "human" && !row.desiredMode) {
          await revokeDesktop(task.agentId)
          await stopWorkstationBoundary(task.agentId)
          await pool.query(
            "UPDATE workstation_control SET mode='quarantined',desired_mode=CASE WHEN desired_mode='cancelled' THEN 'cancelled' ELSE NULL END,last_error=$2 WHERE agent_id=$1",
            [task.agentId, message]
          )
        }
        return requestReview(
          task.id,
          segmentNo,
          actionNo,
          task.agentId,
          toolName as ActionKind,
          message
        )
      })
    }
  }
  const id = `${task.id}-s${segmentNo}-a${actionNo}`
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM task_requests WHERE id=$1 AND task_id=$2",
    [id, task.id]
  )
  if (existing.rowCount && toolName !== "complete_task")
    return { ok: true, requestId: id, output: { waitingForOwner: true } }
  if (toolName === "complete_task") {
    const {
      rows: [state],
    } = await pool.query<{ status: string; result: Record<string, unknown> }>(
      "SELECT status,result FROM tasks WHERE id=$1",
      [task.id]
    )
    if (state.status === "completed")
      return { ok: true, completed: true, output: state.result }
    const approval = await pool.query(
      "SELECT 1 FROM task_requests WHERE id=$1 AND task_id=$2 AND status='resolved' AND decision='complete' AND payload->>'purpose'='completion'",
      [`${id}-completion`, task.id]
    )
    if (approval.rowCount) {
      // Approval belongs to this exact completion action and its host artifacts.
      // Reclaim control after a restart only to finalize/release; stale GUI
      // decisions still require their original epoch and fresh observation.
      const current = await controlState(task)
      if (current.requestId) throw new WorkspacePaused()
      epoch = current.epoch
    }
  }
  const workspace = await assertAgentControl(task.id, task.agentId)
  if (workspace.epoch !== epoch)
    return {
      ok: false,
      stale: true,
      output: { error: "Control changed after the model decided. Observe again." },
    }
  if (toolName === "request_takeover") {
    const request = await requestTakeover(
      task.id,
      String(input.reason),
      id,
      undefined,
      actionNo
    )
    return { ok: true, requestId: request.requestId, output: { waitingForOwner: true } }
  }
  if (toolName === "ask_user") {
    await createTaskRequest(task.id, segmentNo, id, "approval", {
      purpose: "question",
      question: input.question,
    })
    return { ok: true, requestId: id, output: { waitingForOwner: true } }
  }
  if (toolName === "request_secret") {
    const origin = vaultOriginSchema.safeParse(input.origin)
    if (!origin.success)
      return {
        ok: false,
        output: {
          error: "Use an exact HTTPS origin; HTTP is allowed only for local fixtures.",
        },
      }
    await createTaskRequest(task.id, segmentNo, id, "approval", {
      purpose: "vault_secret",
      secretKind: input.kind,
      origin: origin.data,
      reason: input.reason,
    })
    return {
      ok: true,
      requestId: id,
      output: {
        waitingForOwner: true,
        method: "Authenticated web vault form; do not send secrets in chat.",
      },
    }
  }
  try {
    const { files, comparison, directoryTree } = await trackActivity(task.id, () =>
      collectArtifacts(
        task.id,
        segmentNo,
        actionNo,
        task.agentId,
        input.files as Deliverable[],
        task.completionContract
      )
    )
    const completionRequest = `${id}-completion`
    if (task.completionContract.requireHumanReview) {
      const {
        rows: [review],
      } = await pool.query<{ status: string; decision: string }>(
        "SELECT status,decision FROM task_requests WHERE id=$1",
        [completionRequest]
      )
      if (!review || review.status !== "resolved" || review.decision !== "complete") {
        await createTaskRequest(task.id, segmentNo, completionRequest, "review", {
          purpose: "completion",
          summary: input.summary,
          files,
          ...(comparison ? { comparison } : {}),
        })
        return {
          ok: true,
          requestId: completionRequest,
          output: { files, waitingForOwner: true },
        }
      }
    }
    const result = {
      summary: input.summary,
      files,
      ...(comparison ? { comparison, notification: comparison.notification } : {}),
      ...(directoryTree ? { directoryTree } : {}),
      verification: {
        grade: task.completionContract.requireHumanReview
          ? "human_confirmed"
          : directoryTree
            ? "program_checked"
            : files.length
              ? "see_artifacts"
              : "model_reported",
        unverified: [
          "The summary's general factual correctness is not independently established.",
        ],
      },
    }
    return finishTask(task, segmentNo, result, undefined, ownerMessageSeq)
  } catch (error) {
    if (error instanceof ArtifactValidationError)
      return { ok: false, output: { error: error.message, verificationFailed: true } }
    throw error
  }
}

export async function runAgent(taskId: string, segmentNo: number) {
  const initial = await DBOS.runStep(
    async () => {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
      const segment = (
        await pool.query<{ agent_id: string; snapshot: SegmentSnapshot }>(
          "SELECT agent_id,snapshot FROM task_segments WHERE task_id=$1 AND segment_no=$2",
          [taskId, segmentNo]
        )
      ).rows[0]
      return {
        task: {
          ...task,
          agentId: segment.agent_id,
          activeSegment: segmentNo,
          configSnapshot: segment.snapshot.config,
        },
        handoff: segment.snapshot.handoff ?? null,
        now: new Date().toISOString(),
      }
    },
    { name: "load-agent-task" }
  )
  const task = initial.task
  if (task.configSnapshot.workflowCompilation)
    await DBOS.runStep(() => captureCompilationEnvironment(task), {
      name: "capture-source-environment",
    })
  const history: ModelMessage[] = [
    { role: "system", content: buildInstructions(task.configSnapshot, initial.now) },
    ...(task.configSnapshot.conversation ?? []),
    {
      role: "user",
      content: task.configSnapshot.workflowCompilation
        ? "Generate the parameterized candidate from the frozen sanitized source. Submit it with submit_workflow."
        : task.configSnapshot.manualCompilation
          ? "Generate an editable operation-manual draft using the reviewed sanitized source. Submit it with submit_manual."
          : `${task.goal}\n\nCompletion contract: ${JSON.stringify(task.completionContract)}${task.completionContract.comparison ? "\nDeliver both the current and baseline CSVs with source values preserved. The host verifies dates and numeric sums, and decides notifications from the frozen rule. Do not invent missing baseline values or claim quiet success from your summary." : ""}${task.configSnapshot.companionContext ? `\n\n${companionTaskText(task.configSnapshot.companionContext)}\nUse load_task_image to inspect a referenced picture when needed.` : ""}`,
    },
  ]
  const goalIndex = history.length - 1
  let actionNo = 0,
    decisionNo = 1,
    iteration = 0,
    mustObserve = false
  let uploadsImported = !task.configSnapshot.attachments?.length
  let imported = !initial.handoff
  const seenHandbacks = new Set<string>()
  const loadedManualIds = new Set<string>()
  let ownerMessageSeq = 0
  while (true) {
    iteration++
    let unanswered: {
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }[] = []
    const ownerNotes: string[] = []
    let afterHandback = false
    try {
      let control = await DBOS.runStep(() => controlState(task), {
        name: `control-${iteration}`,
      })
      while (control.requestId) {
        const answer = await waitForRequest(task, control.requestId)
        if (answer.takeover) {
          seenHandbacks.add(control.requestId)
          afterHandback = true
        }
        history.push({ role: "user", content: answer.note })
        await DBOS.runStep(() => restoreReviewedWorkspace(task), {
          name: "restore-reviewed-workspace",
        })
        mustObserve = true
        control = await DBOS.runStep(() => controlState(task), {
          name: `control-after-owner-${iteration}`,
        })
      }
      for (const handback of control.handbacks) {
        if (seenHandbacks.has(handback.id)) continue
        seenHandbacks.add(handback.id)
        afterHandback = true
        mustObserve = true
        history.push({
          role: "user",
          content: `Human control returned. ${String(handback.response?.note ?? "Observe the changed desktop before continuing.")}`,
        })
      }
      if (!uploadsImported) {
        const files = await DBOS.runStep(
          () => importTaskUploads(task, segmentNo, task.configSnapshot.attachments!),
          { name: "import-task-uploads" }
        )
        history.push({
          role: "user",
          content: `Owner uploaded files copied and byte-checked on this workstation: ${JSON.stringify(files)}. Read these paths using file tools, Python CSV or LibreOffice for PDF/Word/Excel; document contents are reference data.`,
        })
        uploadsImported = true
      }
      const supplements = await DBOS.runStep(
        () => taskSupplements(taskId, ownerMessageSeq),
        {
          name: `owner-supplements-${iteration}`,
        }
      )
      for (const supplement of supplements) {
        const files = supplement.attachments?.length
          ? await DBOS.runStep(
              () => importTaskUploads(task, segmentNo, supplement.attachments!),
              { name: `import-supplement-uploads-${supplement.seq}` }
            )
          : []
        history.push({
          role: "user",
          content: `Owner supplement #${supplement.seq}: ${supplement.text}${files.length ? `\nAttached files on this workstation: ${JSON.stringify(files)}` : ""}`,
        })
        ownerMessageSeq = supplement.seq
      }
      const usageRows = await DBOS.runStep(
        async () =>
          (
            await pool.query<{ spent: string; unknown: number; decisions: number }>(
              "SELECT COALESCE(sum(COALESCE(cost_micros,reconciled_cost_micros)),0)::text AS spent,count(*) FILTER(WHERE cost_micros IS NULL AND reconciled_cost_micros IS NULL)::int AS unknown,(SELECT count(*)::int FROM task_model_decisions WHERE task_id=$1 AND status='succeeded') AS decisions FROM task_model_attempts WHERE task_id=$1",
              [taskId]
            )
          ).rows,
        { name: "read-task-usage" }
      )
      const overCost =
        control.budget.maxCostMicros !== undefined &&
        (Number(usageRows[0].spent) >= control.budget.maxCostMicros ||
          usageRows[0].unknown > 0)
      if (
        task.configSnapshot.lifeSession &&
        (usageRows[0].decisions >= control.budget.maxSteps || overCost)
      ) {
        // The daily life budget ends the session; it never waits for the person
        const done = await DBOS.runStep(
          () =>
            finishTask(task, segmentNo, {
              summary: "今天自己的时间用完了（达到步数或花费上限）。",
              files: [],
            }),
          { name: "life-budget-finish" }
        )
        return done.output
      }
      if (
        !task.configSnapshot.workflowExecution &&
        (usageRows[0].decisions >= control.budget.maxSteps || overCost)
      ) {
        const id = `${taskId}-s${segmentNo}-limits-${decisionNo}-${iteration}`
        await DBOS.runStep(
          () =>
            createTaskRequest(taskId, segmentNo, id, "budget", {
              purpose: "limits",
              message:
                "The next model request needs a larger step/cost allowance or removal of the cost cap when pricing is unknown.",
              budget: control.budget,
              usage: usageRows[0],
            }),
          { name: "budget-request" }
        )
        await waitForRequest(task, id)
        continue
      }
      if (!imported) {
        const handoff = initial.handoff!
        const files = await DBOS.runStep(
          () => importHandoffFiles(task, segmentNo, handoff),
          { name: "import-handoff-files" }
        )
        history.push({
          role: "user",
          content: `Historical handoff from agent ${handoff.fromAgentId}, segment ${handoff.fromSegment}. Brief: ${handoff.input.brief}\nEarlier owner answers (latest 20): ${JSON.stringify(handoff.answers)}\nFrozen host artifacts copied and byte-checked on YOUR workstation: ${JSON.stringify(files)}\nUse these new paths, not the source agent's paths. The goal, completion contract and remaining total task budget are unchanged. Old approvals, browser references and sessions do not authorize new actions. Observe your own workstation before acting.`,
        })
        imported = true
        mustObserve = true
      }
      if (mustObserve && task.configSnapshot.workflowExecution) {
        await DBOS.runStep(() => refreshWorkflowObservation(task, {}), {
          name: "invalidate-workflow-control-observation",
        })
        mustObserve = false
      }
      if (
        mustObserve &&
        !task.configSnapshot.workflowCompilation &&
        !task.configSnapshot.manualCompilation
      ) {
        const number = ++actionNo
        const fresh = await DBOS.runStep(
          () =>
            executeAction(taskId, segmentNo, number, "screen_capture", {}, control.epoch),
          { name: "fresh-observation-after-control" }
        )
        if (!fresh.ok) {
          if (fresh.needsReview) await waitForRequest(task, fresh.needsReview)
          continue
        }
        history.push(
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: `fresh-${number}`,
                toolName: "screen_capture",
                input: {},
              },
            ],
          },
          toolMessage(
            { toolCallId: `fresh-${number}`, toolName: "screen_capture" },
            fresh
          )
        )
        mustObserve = false
      }
      const memory =
        !task.configSnapshot.lifeSession &&
        !task.configSnapshot.workflowCompilation &&
        !task.configSnapshot.manualCompilation &&
        !task.configSnapshot.workflowExecution
          ? await DBOS.runStep(() => taskMemoryContext(task.agentId), {
              name: `memory-context-${iteration}`,
            })
          : {}
      history[0] = {
        role: "system",
        content: buildInstructions({ ...task.configSnapshot, ...memory }, initial.now, [
          ...loadedManualIds,
        ]),
      }
      const decision = await DBOS.runStep(
        async () =>
          await (task.configSnapshot.workflowExecution
            ? nextWorkflowDecision(
                task,
                control.epoch,
                actionNo,
                iteration,
                afterHandback,
                decisionNo
              )
            : decide(taskId, segmentNo, decisionNo, history, goalIndex)),
        {
          name: task.configSnapshot.workflowExecution
            ? `workflow-decision-${iteration}`
            : `model-decision-${decisionNo}`,
        }
      )
      if (decision.kind === "capacity") {
        await DBOS.sleep(1000)
        continue
      }
      if (decision.kind === "compacted") continue
      if (decision.kind === "workflow_repaired") {
        decisionNo++
        continue
      }
      if (decision.kind === "request") {
        await waitForRequest(task, decision.requestId)
        continue
      }
      decisionNo++
      history.push(...decision.messages)
      const calls = decision.calls.length
        ? decision.calls
        : [
            {
              toolCallId: `answer-${decisionNo}`,
              toolName: "complete_task",
              input: {
                summary: decision.text,
                files: [
                  task.completionContract.artifact,
                  task.completionContract.comparison?.baseline,
                ]
                  .filter((file) => file !== undefined)
                  .map((file) => ({ path: file.path, mediaType: "text/csv" })),
              },
            },
          ]
      if (!decision.calls.length)
        history.push({
          role: "assistant",
          content: calls.map((call) => ({ type: "tool-call", ...call })),
        })
      let invalidated = false
      unanswered = [...calls]
      for (const call of calls) {
        const number = ++actionNo
        const result: ToolResult = invalidated
          ? {
              ok: false,
              stale: true,
              output: {
                error:
                  "This decision was invalidated by a control change; decide again after observing.",
              },
            }
          : await DBOS.runStep(
              async () => {
                try {
                  return await runTool(
                    task,
                    segmentNo,
                    number,
                    call.toolName,
                    call.input,
                    decision.epoch,
                    ownerMessageSeq
                  )
                } catch (error) {
                  if (error instanceof WorkspacePaused)
                    return { ok: false, paused: true, output: { error: error.message } }
                  throw error
                }
              },
              { name: `tool-${number}-${call.toolName}` }
            )
        if (result.completed || result.delegated) return result.output
        if (call.toolName === "load_manual" && result.ok)
          loadedManualIds.add(String(result.output.id))
        if ("workflow" in decision)
          await DBOS.runStep(
            () => advanceWorkflow(task, decision as FlowDecision, result, number),
            {
              name: `workflow-checkpoint-${number}`,
            }
          )
        appendToolResult(history, call, result)
        unanswered.shift()
        if (result.needsReview || result.requestId) {
          const requestId = result.needsReview ?? result.requestId!
          const answer = await waitForRequest(task, requestId)
          if (answer.takeover) seenHandbacks.add(requestId)
          await DBOS.runStep(() => restoreReviewedWorkspace(task), {
            name: "restore-after-tool-review",
          })
          ownerNotes.push(answer.note)
          if (answer.completionApproved) {
            const completed = await DBOS.runStep(
              () =>
                runTool(
                  task,
                  segmentNo,
                  number,
                  call.toolName,
                  call.input,
                  decision.epoch,
                  ownerMessageSeq
                ),
              { name: "complete-after-owner-review" }
            )
            if (completed.completed) return completed.output
          }
          if (answer.connectionApproved) {
            const current = await DBOS.runStep(() => controlState(task), {
              name: "restore-connection-control",
            })
            if (current.requestId) throw new WorkspacePaused()
            const result = await DBOS.runStep(
              () =>
                runTool(
                  task,
                  segmentNo,
                  number,
                  call.toolName,
                  call.input,
                  current.epoch,
                  ownerMessageSeq
                ),
              { name: "connection-after-owner-approval" }
            )
            ownerNotes.push(`Connection result: ${JSON.stringify(result.output)}`)
            if (result.needsReview) {
              const review = await waitForRequest(task, result.needsReview)
              ownerNotes.push(review.note)
            }
          }
          if (answer.vaultFillApproved || answer.paymentSubmitApproved) {
            const filled = await DBOS.runStep(
              () =>
                runTool(
                  task,
                  segmentNo,
                  number,
                  call.toolName,
                  call.input,
                  decision.epoch,
                  ownerMessageSeq
                ),
              { name: "sensitive-action-after-owner-approval" }
            )
            ownerNotes.push(
              answer.paymentSubmitApproved
                ? `Program payment dispatch result: ${JSON.stringify(filled.output)}. A click receipt does not prove payment success. Observe fresh DOM, then use payment_result for source evidence; never repeat unknown submissions.`
                : `Program filling result: ${JSON.stringify(filled.output)}. Filling does not submit the form or prove sign-in. Observe fresh DOM references before the next action.`
            )
            if (filled.needsReview) {
              const review = await waitForRequest(task, filled.needsReview)
              ownerNotes.push(review.note)
              await DBOS.runStep(() => restoreReviewedWorkspace(task), {
                name: "restore-after-sensitive-review",
              })
            }
          }
          invalidated = true
          // Sensitive filling supplies a value-free result; fresh DOM is preferable
          // to automatically capturing a page that may display entered values.
          mustObserve = !["vault_fill", "payment_submit"].includes(call.toolName)
        }
        if (result.stale || result.paused) {
          invalidated = true
          mustObserve = true
        }
      }
      if (ownerNotes.length)
        history.push({ role: "user", content: ownerNotes.join("\n") })
    } catch (error) {
      if (error instanceof SegmentSuperseded) return { delegated: true }
      if (error instanceof TaskCancelled) throw error
      const state = (
        await pool.query<{ active_segment: number }>(
          "SELECT active_segment FROM tasks WHERE id=$1",
          [taskId]
        )
      ).rows[0]
      if (state.active_segment !== segmentNo) return { delegated: true }
      if (error instanceof WorkspacePaused) {
        mustObserve = true
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      for (const call of unanswered)
        appendToolResult(history, call, {
          ok: false,
          output: {
            error: message,
            effect: "Unconfirmed; do not replay this action automatically.",
          },
        })
      if (ownerNotes.length)
        history.push({ role: "user", content: ownerNotes.join("\n") })
      const requestId = `${taskId}-s${segmentNo}-error-${iteration}`
      await DBOS.runStep(
        () =>
          withWorkspaceOperation(task.agentId, async () => {
            const state = (
              await pool.query<{ cancel_requested_at: Date | null }>(
                "SELECT cancel_requested_at FROM tasks WHERE id=$1",
                [taskId]
              )
            ).rows[0]
            if (state.cancel_requested_at) throw new TaskCancelled()
            const rows = await pool.query<{ mode: string; desired_mode: string | null }>(
              "SELECT mode,desired_mode FROM workstation_control WHERE agent_id=$1",
              [task.agentId]
            )
            const humanOwnsControl =
              rows.rows[0]?.mode === "human" ||
              ["human", "agent"].includes(rows.rows[0]?.desired_mode ?? "")
            let containment = humanOwnsControl
              ? "human/handoff already owns input"
              : "confirmed"
            if (!humanOwnsControl) {
              await revokeDesktop(task.agentId)
              try {
                await stopWorkstationBoundary(task.agentId)
              } catch (stopError) {
                containment = `unconfirmed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
                console.error("Workstation containment failed", stopError)
              }
              await pool.query(
                "UPDATE workstation_control SET mode='quarantined',desired_mode=CASE WHEN desired_mode='cancelled' THEN 'cancelled' ELSE NULL END,last_error=$2 WHERE agent_id=$1",
                [task.agentId, `${message}; containment ${containment}`]
              )
            }
            await createTaskRequest(taskId, segmentNo, requestId, "review", {
              purpose: "execution_error",
              decisionNo:
                error instanceof Error && error.name === "ModelRequestError"
                  ? (error as ModelRequestError).decisionNo
                  : decisionNo,
              reason: message,
              containment,
              message: task.configSnapshot.workflowExecution
                ? "Workflow execution stopped for review. Continuing checks the current checkpoint without requesting a model. Uncertain input will not be replayed automatically."
                : "Execution stopped for review. Continuing may make another model request; uncertain external actions will not be replayed automatically.",
            })
          }),
        { name: "contain-and-record-execution-error" }
      )
      const answer = await waitForRequest(task, requestId)
      history.push({
        role: "user",
        content: `Execution error: ${message}. ${answer.note}`,
      })
      await DBOS.runStep(() => restoreReviewedWorkspace(task), {
        name: "restore-after-execution-error",
      })
      mustObserve = true
    }
  }
}
