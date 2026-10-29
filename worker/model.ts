import { generateText, type ModelMessage } from "ai"
import { db, pool } from "@/db"
import { tasks } from "@/db/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  createModel,
  getProviderCredentials,
  modelContextWindow,
} from "@/lib/providers/registry"
import { parseModelSpec } from "@/lib/providers/catalog"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import { getCustomPrices, monthlyUsage, monthlyBlock } from "@/lib/spend"
import {
  prepareModelContext,
  contextMessages,
  planContextCompaction,
  estimateContextTokens,
  validateContextSummary,
  isContextWindowError,
  DEFAULT_CONTEXT_LIMITS,
  type ContextCheckpoint,
} from "@/lib/agent/context"
import { toolsForTask } from "@/lib/agent/tools"
import { appendEventInTransaction } from "@/lib/task-events"
import { assertAgentControl, TaskCancelled, SegmentSuperseded } from "@/lib/workstation"
import { trackActivity } from "./activity"
import { createTaskRequest } from "./requests"

export type Decision = {
  kind: "decision"
  epoch: number
  text: string
  calls: { toolCallId: string; toolName: string; input: Record<string, unknown> }[]
  messages: ModelMessage[]
  usage: {
    input: number
    output: number
    cached: number
    reasoning: number
    missing: boolean
  }
  costMicros: number | null
  compaction?: { through: number }
  context?: { estimatedInput: number; through: number }
  finishReason?: string
}

export class ModelRequestError extends Error {
  name = "ModelRequestError"
  constructor(
    message: string,
    public decisionNo: number
  ) {
    super(message)
  }
}

export async function decide(
  taskId: string,
  segmentNo: number,
  decisionNo: number,
  history: ModelMessage[],
  goalIndex = history.findLastIndex((message) => message.role === "user")
): Promise<
  | Decision
  | { kind: "request"; requestId: string }
  | { kind: "capacity" }
  | { kind: "compacted" }
> {
  const prior = (
    await pool.query<{ status: string; error: string | null }>(
      "SELECT status,error FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
      [taskId, segmentNo, decisionNo]
    )
  ).rows[0]
  if (prior && prior.status !== "retryable")
    return requestDecision(taskId, segmentNo, decisionNo, history)
  const forceCompaction = prior?.error?.startsWith("ContextWindowExceeded:") ?? false
  const compactionAttempt = (
    await pool.query<{ status: string }>(
      "SELECT status FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
      [taskId, segmentNo, -decisionNo]
    )
  ).rows[0]
  if (compactionAttempt && ["pending", "failed"].includes(compactionAttempt.status))
    return requestDecision(taskId, segmentNo, -decisionNo, [])
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  const saved = (
    await pool.query<{ decision_no: number; result: Decision }>(
      "SELECT decision_no,result FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND status='succeeded' AND result->'compaction' IS NOT NULL ORDER BY decision_no ASC LIMIT 1",
      [taskId, segmentNo]
    )
  ).rows[0]
  const checkpoint: ContextCheckpoint | undefined = saved
    ? {
        through: saved.result.compaction!.through,
        summary: validateContextSummary(
          saved.result.text,
          saved.result.calls,
          saved.result.finishReason
        ),
      }
    : undefined
  const workspace = await assertAgentControl(taskId, task.agentId)
  const session = {
    taskId,
    threadId: task.threadId,
    segmentNo,
    epoch: workspace.epoch,
    bootId: workspace.bootId,
  }
  const tools = toolsForTask(task.configSnapshot)
  const schemaTokens = estimateContextTokens(
    Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      schema: z.toJSONSchema(tool.inputSchema as z.ZodType),
    }))
  )
  const limits = {
    ...DEFAULT_CONTEXT_LIMITS,
    window:
      task.configSnapshot.contextWindowTokens ??
      modelContextWindow(task.configSnapshot.model),
  }
  const inputLimit = limits.window - limits.output
  const estimate = (view: ModelMessage[]) =>
    schemaTokens +
    estimateContextTokens(prepareModelContext(task.configSnapshot.model, view, session))
  const view = contextMessages(history, goalIndex, checkpoint)
  let estimatedInput = estimate(view)
  const rawEstimate = estimatedInput
  const last = (
    await pool.query<{ result: Decision }>(
      "SELECT result FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND status='succeeded' AND decision_no>0 ORDER BY decision_no DESC LIMIT 1",
      [taskId, segmentNo]
    )
  ).rows[0]?.result
  if (
    last?.context?.through === (checkpoint?.through ?? 0) &&
    last.context.estimatedInput > 0
  )
    estimatedInput = Math.ceil(
      estimatedInput * Math.max(1, last.usage.input / last.context.estimatedInput)
    )
  if (
    estimatedInput >= Math.floor(inputLimit * 0.8) ||
    forceCompaction ||
    compactionAttempt?.status === "retryable"
  ) {
    if (saved?.decision_no !== -decisionNo) {
      const plan = planContextCompaction(
        history,
        goalIndex,
        checkpoint,
        inputLimit - 2048
      )
      const projected = plan
        ? estimate(
            contextMessages(history, goalIndex, {
              through: plan.through,
              summary: "x".repeat(12000),
            })
          )
        : Infinity
      if (plan && projected <= inputLimit && projected < estimatedInput - 1024) {
        const compacted = await requestDecision(
          taskId,
          segmentNo,
          -decisionNo,
          plan.messages,
          {
            through: plan.through,
          }
        )
        if (compacted.kind !== "decision") return compacted
        validateContextSummary(compacted.text, compacted.calls, compacted.finishReason)
        return { kind: "compacted" } // Re-enter the existing step/cost/control gates before the next request.
      }
      if (compactionAttempt?.status === "retryable")
        throw new Error(
          "The authorized compaction retry has no useful older history to summarize; inspect the changed context"
        )
      if (forceCompaction)
        throw new Error(
          "The provider rejected the context and no useful compaction fits; correct the model window before another request"
        )
    }
  }
  if (estimatedInput > inputLimit)
    throw new Error(
      "Pinned/recent context exceeds the reserved window after available compaction; reduce the input or increase its configured window"
    )
  return requestDecision(taskId, segmentNo, decisionNo, view, undefined, {
    estimatedInput: rawEstimate,
    through: checkpoint?.through ?? 0,
  })
}

async function requestDecision(
  taskId: string,
  segmentNo: number,
  decisionNo: number,
  history: ModelMessage[],
  compaction?: { through: number },
  context?: Decision["context"]
): Promise<Decision | { kind: "request"; requestId: string } | { kind: "capacity" }> {
  const key = [taskId, segmentNo, decisionNo]
  const previous = (
    await pool.query<{ status: string; result: Decision; attempts: number }>(
      "SELECT status,result,attempts FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
      key
    )
  ).rows[0]
  if (previous?.status === "succeeded") return previous.result
  if (previous?.status === "pending") {
    await pool.query(
      "UPDATE task_model_attempts SET status='unknown',error='Request interrupted before a saved response' WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND status='pending'",
      key
    )
    const requestId = `${taskId}-s${segmentNo}-d${decisionNo}-retry-${previous.attempts}`
    await createTaskRequest(taskId, segmentNo, requestId, "budget", {
      purpose: "model_retry",
      decisionNo,
      message:
        "The model request was interrupted before a response was saved. The provider may have billed it. Continue only if you accept another request.",
    })
    return { kind: "request", requestId }
  }
  if (previous?.status === "failed")
    throw new ModelRequestError(
      "The previous model request failed; inspect the recorded error before starting another task",
      decisionNo
    )
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (task.activeSegment !== segmentNo) throw new SegmentSuperseded()
  const workspace = await assertAgentControl(taskId, task.agentId)
  const parsed = parseModelSpec(task.configSnapshot.model)!
  const credentials = await getProviderCredentials(parsed.provider)
  const model = await createModel(task.configSnapshot.model, credentials)
  const redact = (value: string) =>
    credentials.apiKey
      ? value
          .replaceAll(credentials.apiKey, "[redacted API key]")
          .replaceAll(
            JSON.stringify(credentials.apiKey).slice(1, -1),
            "[redacted API key]"
          )
      : value
  let price: Price | null
  const attemptNo = (previous?.attempts ?? 0) + 1
  const intent = await pool.connect()
  try {
    await intent.query("BEGIN")
    await intent.query("SELECT pg_advisory_xact_lock(71261206)")
    const {
      rows: [active],
    } = await intent.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId]
    )
    if (active.cancel_requested_at) throw new TaskCancelled()
    price = findPrice(task.configSnapshot.model, {
      custom: await getCustomPrices(intent),
    })
    const month = await monthlyUsage(task.ownerId, intent)
    const block = monthlyBlock(month, price)
    if (block) {
      const {
        rows: [waiting],
      } = await intent.query(
        "SELECT id FROM task_requests WHERE task_id=$1 AND status='pending' AND payload->>'purpose'='monthly' AND payload->>'decisionNo'=$2 ORDER BY created_at DESC LIMIT 1",
        [taskId, String(decisionNo)]
      )
      const requestId =
        waiting?.id ??
        `${taskId}-monthly-${segmentNo}-${decisionNo}-${crypto.randomUUID()}`
      if (!waiting)
        await createTaskRequest(
          taskId,
          segmentNo,
          requestId,
          "budget",
          { purpose: "monthly", decisionNo, message: block, monthly: month },
          intent
        )
      await intent.query("COMMIT")
      return { kind: "request", requestId }
    }
    // ponytail: a configured cap serializes paid requests; measured need can justify cost reservations later.
    if (month.budgetMicros !== null && price?.kind !== "local" && month.pendingPaid > 0) {
      await intent.query("COMMIT")
      return { kind: "capacity" }
    }
    await intent.query(
      `INSERT INTO task_model_decisions(task_id,segment_no,decision_no,epoch,status,created_at)
      VALUES($1,$2,$3,$4,'pending',now()) ON CONFLICT(task_id,segment_no,decision_no)
      DO UPDATE SET status='pending',epoch=excluded.epoch,attempts=task_model_decisions.attempts+1,uncertain_attempts=task_model_decisions.uncertain_attempts+1,error=NULL`,
      [...key, workspace.epoch]
    )
    await intent.query(
      `INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,price_snapshot,cost_micros,started_at)
      VALUES($1,$2,$3,$4,$5,'pending',$6,$7,now())`,
      [
        ...key,
        attemptNo,
        task.configSnapshot.model,
        JSON.stringify(price),
        price?.kind === "local" ? 0 : null,
      ]
    )
    await appendEventInTransaction(
      intent,
      taskId,
      `model-started:${segmentNo}:${decisionNo}:${previous?.attempts ?? 0}`,
      "model_started",
      {
        decisionNo,
        model: task.configSnapshot.model,
        phase: compaction
          ? "context_compaction"
          : task.configSnapshot.workflowCompilation
            ? "workflow_compilation"
            : task.configSnapshot.workflowExecution
              ? "workflow_repair"
              : "agent",
        ...(task.configSnapshot.workflowExecution
          ? { workflowId: task.configSnapshot.workflowExecution.versionId }
          : {}),
      }
    )
    await intent.query("COMMIT")
  } catch (error) {
    await intent.query("ROLLBACK")
    throw error
  } finally {
    intent.release()
  }

  let decision: Decision
  try {
    decision = await trackActivity(taskId, async (signal) => {
      const safeHistory = JSON.parse(
        JSON.stringify(history, (_, value) =>
          typeof value === "string" ? redact(value) : value
        )
      ) as ModelMessage[]
      const result = await generateText({
        model,
        tools: compaction ? {} : toolsForTask(task.configSnapshot),
        ...(!compaction &&
        (task.configSnapshot.workflowCompilation || task.configSnapshot.workflowExecution)
          ? { toolChoice: "required" as const }
          : {}),
        ...prepareModelContext(task.configSnapshot.model, safeHistory, {
          taskId,
          threadId: task.threadId,
          segmentNo,
          epoch: workspace.epoch,
          bootId: workspace.bootId,
        }),
        maxOutputTokens: compaction ? 4096 : DEFAULT_CONTEXT_LIMITS.output,
        maxRetries: 0,
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      })
      const usage = z
        .object({
          missing: z.boolean(),
          input: z.number().int().safe().nonnegative(),
          output: z.number().int().safe().nonnegative(),
          cached: z.number().int().safe().nonnegative(),
          reasoning: z.number().int().safe().nonnegative(),
        })
        .parse({
          missing:
            result.totalUsage.inputTokens === undefined ||
            result.totalUsage.outputTokens === undefined,
          input: result.totalUsage.inputTokens ?? 0,
          output: result.totalUsage.outputTokens ?? 0,
          cached: result.totalUsage.inputTokenDetails.cacheReadTokens ?? 0,
          reasoning: result.totalUsage.outputTokenDetails.reasoningTokens ?? 0,
        })
      const cost =
        usage.missing && price?.kind !== "local" ? null : callCost(price, usage)
      return JSON.parse(
        JSON.stringify(
          {
            kind: "decision",
            epoch: workspace.epoch,
            text: result.text,
            calls: result.toolCalls.map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input as Record<string, unknown>,
            })),
            messages: JSON.parse(
              JSON.stringify(result.response.messages)
            ) as ModelMessage[],
            usage,
            costMicros:
              cost === null
                ? null
                : z.number().int().safe().nonnegative().parse(toMicros(cost)),
            ...(compaction ? { compaction } : {}),
            ...(context ? { context } : {}),
            finishReason: result.finishReason,
          },
          (_, value) => (typeof value === "string" ? redact(value) : value)
        )
      ) as Decision
    })
  } catch (error) {
    let message =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    message = redact(message)
    if (isContextWindowError(error)) message = `ContextWindowExceeded: ${message}`
    const failure = await pool.connect()
    try {
      await failure.query("BEGIN")
      await failure.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [taskId])
      await failure.query(
        "UPDATE task_model_decisions SET status='failed',error=$4,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
        [...key, message]
      )
      await failure.query(
        "UPDATE task_model_attempts SET status='unknown',error=$5,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND attempt_no=$4",
        [...key, attemptNo, message]
      )
      await failure.query("COMMIT")
    } catch (recordError) {
      await failure.query("ROLLBACK")
      throw recordError
    } finally {
      failure.release()
    }
    const state = await pool.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1",
      [taskId]
    )
    if (state.rows[0].cancel_requested_at) throw new TaskCancelled()
    throw new ModelRequestError(message, decisionNo)
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [taskId])
    await client.query(
      "UPDATE task_model_decisions SET status='succeeded',result=$4,cost_micros=$5,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
      [...key, JSON.stringify(decision), decision.costMicros]
    )
    await client.query(
      "UPDATE task_model_attempts SET status='succeeded',usage=$5,cost_micros=$6,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND attempt_no=$4",
      [...key, attemptNo, JSON.stringify(decision.usage), decision.costMicros]
    )
    await appendEventInTransaction(
      client,
      taskId,
      `model-result:${segmentNo}:${decisionNo}`,
      "model_decision",
      {
        decisionNo,
        text: decision.text,
        tools: decision.calls.map((call) => call.toolName),
        usage: decision.usage,
        costMicros: decision.costMicros,
        ...(decision.compaction ? { compaction: decision.compaction } : {}),
        ...(decision.context ? { context: decision.context } : {}),
        phase: compaction
          ? "context_compaction"
          : task.configSnapshot.workflowCompilation
            ? "workflow_compilation"
            : task.configSnapshot.workflowExecution
              ? "workflow_repair"
              : "agent",
      }
    )
    await client.query("COMMIT")
    return decision
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
