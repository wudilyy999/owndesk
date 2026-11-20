import { withdrawnMemory } from "@/lib/companion/forgotten"
import { sealHistory, type Continuation } from "@/lib/continuation"
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
import { isRetriableModelError } from "@/lib/providers/fallback"
import { getSetting } from "@/lib/config"
import { parseModelSpec } from "@/lib/providers/catalog"
import { callCost, findPrice, toMicros, type Price } from "@/lib/providers/pricing"
import { getCustomPrices, monthlyUsage, monthlyBlock } from "@/lib/spend"
import {
  prepareModelContext,
  exceedsInputBudget,
  inputBudget,
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
  compaction?: { through: number; continuation?: Continuation; memoryRevision?: string }
  context?: { estimatedInput: number; through: number; model?: string }
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

class RetryWithFallback extends Error {}

export async function decide(
  taskId: string,
  segmentNo: number,
  decisionNo: number,
  history: ModelMessage[],
  goalIndex = history.findLastIndex((message) => message.role === "user")
) {
  try {
    return await decideOnRoute(taskId, segmentNo, decisionNo, history, goalIndex)
  } catch (error) {
    if (!(error instanceof RetryWithFallback)) throw error
    return decideOnRoute(taskId, segmentNo, decisionNo, history, goalIndex)
  }
}

async function decideOnRoute(
  taskId: string,
  segmentNo: number,
  decisionNo: number,
  history: ModelMessage[],
  goalIndex: number
): Promise<
  | Decision
  | { kind: "request"; requestId: string }
  | { kind: "capacity" }
  | { kind: "compacted"; more?: boolean }
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
    await pool.query<{ status: string; error: string | null }>(
      "SELECT status,error FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
      [taskId, segmentNo, -decisionNo]
    )
  ).rows[0]
  if (compactionAttempt && ["pending", "failed"].includes(compactionAttempt.status))
    return requestDecision(taskId, segmentNo, -decisionNo, [])
  const retrySummary =
    compactionAttempt?.status === "retryable" &&
    !compactionAttempt.error?.startsWith("FallbackSelected:")
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  const configured = (await getSetting("model.fallback"))?.trim()
  const fallback =
    configured && configured !== task.configSnapshot.model && parseModelSpec(configured)
      ? configured
      : null
  // A fold can span multiple decision numbers. Keep its route until the first normal
  // decision is saved, then give the primary another chance on the next action.
  const routed =
    fallback &&
    (
      await pool.query(
        `SELECT 1 FROM task_events e WHERE e.task_id=$1 AND e.type='model_fallback'
      AND e.payload->>'model'=$4 AND (e.payload->>'segmentNo')::int=$2
      AND (e.payload->>'decisionNo')::int <= $3 AND NOT EXISTS (
        SELECT 1 FROM task_model_decisions d WHERE d.task_id=e.task_id AND d.segment_no=$2
        AND d.status='succeeded' AND d.decision_no BETWEEN (e.payload->>'decisionNo')::int AND $3-1) LIMIT 1`,
        [taskId, segmentNo, decisionNo, fallback]
      )
    ).rowCount
  const model = routed ? fallback! : task.configSnapshot.model
  const route = { model, fallback: routed ? null : fallback }
  const removed = await withdrawnMemory(task.agentId)
  const savedReceipt = (
    await pool.query<{ decision_no: number; result: Decision }>(
      "SELECT decision_no,result FROM task_model_decisions WHERE task_id=$1 AND segment_no=$2 AND status='succeeded' AND result->'compaction' IS NOT NULL ORDER BY decision_no ASC LIMIT 1",
      [taskId, segmentNo]
    )
  ).rows[0]
  const saved =
    (savedReceipt?.result.compaction?.memoryRevision ?? "") === removed.revision
      ? savedReceipt
      : undefined
  history = removed.messages(history)
  const scope = task.configSnapshot.continuation
  if (
    (task.configSnapshot.historyPrivacy ?? "") !== removed.revision &&
    scope?.after &&
    history[1]?.role === "assistant"
  )
    history[1] = {
      role: "assistant",
      content: "[old thread summary withheld after a memory change]",
    }
  const source = task.configSnapshot.companionContext
  if (source?.windowed && removed.ids.size) {
    const start =
      1 +
      (task.configSnapshot.conversation?.length ?? 0) +
      (source.earlierSummary ? 1 : 0)
    for (const [i, m] of source.messages.entries())
      if (removed.ids.has(m.id) && start + i < goalIndex)
        history[start + i] = { role: m.role, content: "[removed source message]" }
  }
  if (source?.earlierSummary && (source.memoryRevision ?? "") !== removed.revision) {
    if (source.windowed) {
      const i = 1 + (task.configSnapshot.conversation?.length ?? 0)
      if (history[i]?.role === "assistant")
        history[i] = {
          role: "assistant",
          content: "[old source chat summary withheld after a memory change]",
        }
    } else if (typeof history[goalIndex]?.content === "string") {
      history[goalIndex] = {
        role: "user",
        content: String(history[goalIndex].content).split(
          "\n\nSource chat for this confirmed task"
        )[0],
      }
    }
  }
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
    window: routed
      ? Math.min(
          task.configSnapshot.contextWindowTokens ?? Infinity,
          modelContextWindow(model)
        )
      : (task.configSnapshot.contextWindowTokens ?? modelContextWindow(model)),
  }
  const inputLimit = inputBudget(limits.window, limits.output)
  const estimate = (view: ModelMessage[]) =>
    schemaTokens + estimateContextTokens(prepareModelContext(model, view, session))
  const historyRoom =
    inputLimit -
    estimate(history.filter((m, i) => m.role === "system" || i === goalIndex))
  const planFold = () =>
    planContextCompaction(
      history,
      goalIndex,
      checkpoint,
      inputLimit - 2048,
      forceCompaction ? 0 : historyRoom
    )
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
    (last.context.model ?? task.configSnapshot.model) === model &&
    last.context.estimatedInput > 0
  )
    estimatedInput = Math.ceil(
      estimatedInput * Math.max(1, last.usage.input / last.context.estimatedInput)
    )
  if (exceedsInputBudget(estimatedInput, inputLimit) || forceCompaction || retrySummary) {
    if (savedReceipt && !saved && savedReceipt.decision_no === -decisionNo)
      return { kind: "compacted", more: true }
    if (saved?.decision_no === -decisionNo && estimatedInput > inputLimit && planFold())
      return { kind: "compacted", more: true }
    if (saved?.decision_no !== -decisionNo) {
      const plan = planFold()
      const projected = plan
        ? estimate(
            contextMessages(history, goalIndex, {
              through: plan.through,
              summary: "x".repeat(12000),
            })
          )
        : Infinity
      if (
        plan &&
        (projected <= inputLimit || plan.more) &&
        projected < estimatedInput - 1024
      ) {
        const scope = task.configSnapshot.continuation
        const shareable =
          scope &&
          (task.configSnapshot.historyPrivacy ?? "") === removed.revision &&
          segmentNo === 1 &&
          task.configSnapshot.conversation &&
          goalIndex === 1 + task.configSnapshot.conversation.length
            ? sealHistory(scope, task.configSnapshot.conversation, plan.through)
            : null
        if (shareable) {
          // Reusable history may not learn this task's goal or later supplements.
          const payload = JSON.parse(String(plan.messages[1].content))
          payload.currentTask = []
          plan.messages[1] = { role: "user", content: JSON.stringify(payload) }
        }
        const compacted = await requestDecision(
          taskId,
          segmentNo,
          -decisionNo,
          plan.messages,
          route,
          {
            through: plan.through,
            memoryRevision: removed.revision,
            ...(shareable ? { continuation: shareable } : {}),
          }
        )
        if (compacted.kind !== "decision") return compacted
        validateContextSummary(compacted.text, compacted.calls, compacted.finishReason)
        return {
          kind: "compacted",
          ...(plan.more &&
          estimate(
            contextMessages(history, goalIndex, {
              through: plan.through,
              summary: compacted.text,
            })
          ) > inputLimit
            ? { more: true }
            : {}),
        } // Re-enter the existing step/cost/control gates before the next request.
      }
      if (retrySummary)
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
  try {
    return await requestDecision(taskId, segmentNo, decisionNo, view, route, undefined, {
      model,
      estimatedInput: rawEstimate,
      through: checkpoint?.through ?? 0,
    })
  } catch (error) {
    // The provider refused the context before answering: compact once and rebuild the same step
    // (OpenCode's overflow rule). The refused attempt keeps its unknown cost; a refusal after
    // this compaction, or a failed compaction, stops for the owner as before.
    if (
      error instanceof ModelRequestError &&
      error.message.startsWith("ContextWindowExceeded:") &&
      !forceCompaction &&
      saved?.decision_no !== -decisionNo
    ) {
      const retried = await pool.query(
        "UPDATE task_model_decisions SET status='retryable' WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND status='failed' AND error LIKE 'ContextWindowExceeded:%'",
        [taskId, segmentNo, decisionNo]
      )
      if (retried.rowCount)
        return decide(taskId, segmentNo, decisionNo, history, goalIndex)
    }
    throw error
  }
}

async function requestDecision(
  taskId: string,
  segmentNo: number,
  decisionNo: number,
  history: ModelMessage[],
  route?: { model: string; fallback: string | null },
  compaction?: { through: number; continuation?: Continuation; memoryRevision?: string },
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
  const spec = route?.model ?? task.configSnapshot.model
  const parsed = parseModelSpec(spec)!
  const credentials = await getProviderCredentials(parsed.provider)
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
    price = findPrice(spec, {
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
      [...key, attemptNo, spec, JSON.stringify(price), price?.kind === "local" ? 0 : null]
    )
    await appendEventInTransaction(
      intent,
      taskId,
      `model-started:${segmentNo}:${decisionNo}:${previous?.attempts ?? 0}`,
      "model_started",
      {
        decisionNo,
        model: spec,
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
      const removed = await withdrawnMemory(task.agentId)
      const safeHistory = JSON.parse(
        JSON.stringify(removed.messages(history), (_, value) =>
          typeof value === "string" ? redact(value) : value
        )
      ) as ModelMessage[]
      const result = await generateText({
        model: await createModel(spec, credentials),
        tools: compaction ? {} : toolsForTask(task.configSnapshot),
        ...(!compaction &&
        (task.configSnapshot.workflowCompilation || task.configSnapshot.workflowExecution)
          ? { toolChoice: "required" as const }
          : {}),
        ...prepareModelContext(spec, safeHistory, {
          taskId,
          threadId: task.threadId,
          segmentNo,
          epoch: workspace.epoch,
          bootId: workspace.bootId,
        }),
        maxOutputTokens: compaction ? 4096 : DEFAULT_CONTEXT_LIMITS.output,
        maxRetries: 0,
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
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
    const nextModel =
      route?.fallback && isRetriableModelError(error) ? route.fallback : null
    const failure = await pool.connect()
    try {
      await failure.query("BEGIN")
      await failure.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [taskId])
      await failure.query(
        "UPDATE task_model_decisions SET status=$5,error=$4,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3",
        [
          ...key,
          nextModel ? `FallbackSelected: ${message}` : message,
          nextModel ? "retryable" : "failed",
        ]
      )
      await failure.query(
        "UPDATE task_model_attempts SET status='unknown',error=$5,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND decision_no=$3 AND attempt_no=$4",
        [...key, attemptNo, message]
      )
      if (nextModel)
        await appendEventInTransaction(
          failure,
          taskId,
          `model-fallback:${segmentNo}:${decisionNo}:${attemptNo}`,
          "model_fallback",
          { segmentNo, decisionNo: Math.abs(decisionNo), model: nextModel }
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
    if (nextModel) throw new RetryWithFallback()
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
