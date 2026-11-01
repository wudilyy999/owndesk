import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, desc, eq, sql } from "drizzle-orm"
import { db, pool } from "@/db"
import {
  agents,
  artifacts,
  taskActions,
  taskRequests,
  workstationControl,
  taskEvents,
  tasks,
  taskInputSchema,
  completionContractSchema,
  threads,
  type Task,
  type TaskInput,
} from "@/db/schema"
import {
  APPLICATION_VERSION,
  durableClient,
  TASK_QUEUE,
  TASK_WORKFLOW,
} from "@/lib/durable"
import { getMaxSteps } from "@/lib/config"
import { agentSnapshot } from "@/lib/agent/snapshot"
import { assertDelegationRoster } from "@/lib/agent/roster"
import { freezeWorkflowCompilation, freezeWorkflowExecution } from "@/lib/workflows"
import { freezeManualCompilation } from "@/lib/manuals"
import { HttpError } from "@/lib/errors"
import { requestCancellation } from "@/lib/task-control"
import { appendEventInTransaction } from "@/lib/task-events"
import {
  conversationContext,
  type ConversationTurn,
  type ThreadInteraction,
} from "@/lib/thread-context"

type SubmittedTask = {
  id: string
  thread_id: string | null
  thread_turn: number | null
  request_payload: Omit<TaskInput, "clientRequestId">
}

// A person's own task always wins over the companion's daily-life session on the same agent
async function preemptLifeSessions(ownerId: string, agentId: string) {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM tasks WHERE owner_id=$1 AND agent_id=$2 AND config_snapshot ? 'lifeSession' AND status NOT IN ('completed','failed','cancelled')",
    [ownerId, agentId]
  )
  for (const row of rows) await requestCancellation(ownerId, row.id)
}

export async function submitTask(ownerId: string, source: string, raw: TaskInput) {
  const input = taskInputSchema.parse(raw)
  const { clientRequestId: requestKey, ...payload } = input
  const previous = await pool.query<SubmittedTask>(
    "SELECT id,thread_id,thread_turn,request_payload FROM tasks WHERE owner_id=$1 AND source=$2 AND request_key=$3",
    [ownerId, source, requestKey]
  )
  if (previous.rows[0]) {
    if (!isDeepStrictEqual(payload, previous.rows[0].request_payload))
      throw new HttpError(409, "Request key already used with different task parameters")
    return {
      taskId: previous.rows[0].id,
      threadId: previous.rows[0].thread_id,
      threadTurn: previous.rows[0].thread_turn,
      reused: true,
    }
  }
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId))
  if (!agent) throw new HttpError(404, "Agent not found")
  await assertDelegationRoster(input.delegateAgentIds ?? [])
  const config: Task["configSnapshot"] = await agentSnapshot(
    agent,
    ownerId,
    input.timeZone,
    !input.workflowExecution || input.workflowExecution.allowRepair === true
  )
  if (input.desktopCoordinateMode)
    config.desktopCoordinateMode = input.desktopCoordinateMode
  if (input.manualCompilation) {
    if (
      config.runtime !== "agent" ||
      input.threadId ||
      input.delegateAgentIds?.length ||
      input.workflowCompilation ||
      input.workflowExecution ||
      input.workstationChannel ||
      input.manualId ||
      input.completionContract.artifact ||
      input.completionContract.directoryTree ||
      input.completionContract.requireHumanReview
    )
      throw new HttpError(
        400,
        "Generate manuals in a new single-agent task with no desktop execution contract"
      )
    config.manualCompilation = await freezeManualCompilation(
      ownerId,
      input.manualCompilation
    )
    delete config.manuals
  }
  if (input.manualId) {
    if (
      config.runtime !== "agent" ||
      input.workflowCompilation ||
      input.workflowExecution
    )
      throw new HttpError(
        400,
        "Operation manuals require the ordinary agent execution path"
      )
    if (!config.manuals?.some((manual) => manual.id === input.manualId))
      throw new HttpError(409, "The selected manual is disabled or unavailable")
    config.manualId = input.manualId
  }
  if (input.lifeSession) {
    if (
      config.runtime !== "agent" ||
      input.threadId ||
      input.delegateAgentIds?.length ||
      input.workflowCompilation ||
      input.workflowExecution ||
      input.manualCompilation ||
      input.manualId ||
      input.workstationChannel ||
      input.completionContract.artifact ||
      input.completionContract.directoryTree ||
      input.completionContract.requireHumanReview
    )
      throw new HttpError(400, "A life session is a plain single-agent task")
    config.lifeSession = input.lifeSession
  } else await preemptLifeSessions(ownerId, agent.id)
  if (input.workstationChannel) {
    if (
      config.runtime !== "agent" ||
      input.workflowCompilation ||
      input.delegateAgentIds?.length
    )
      throw new HttpError(
        400,
        "Desktop-only tasks require the single-agent desktop execution path"
      )
    config.workstationChannel = input.workstationChannel
  }
  if (input.workflowCompilation) {
    if (config.runtime !== "agent" || input.delegateAgentIds?.length || input.threadId)
      throw new HttpError(
        400,
        "Compile in a new single-agent conversation without delegation"
      )
    config.workflowCompilation = await freezeWorkflowCompilation(
      ownerId,
      input.workflowCompilation,
      input.completionContract
    )
  }
  const runtime = config.runtime
  if (
    input.workflowExecution &&
    (runtime !== "agent" ||
      input.workflowCompilation ||
      input.delegateAgentIds?.length ||
      input.threadId)
  )
    throw new HttpError(
      400,
      "Run workflows in a new single-agent task without compilation or delegation"
    )
  if (
    runtime === "fixture" &&
    (input.completionContract.artifact ||
      input.completionContract.directoryTree ||
      input.completionContract.requireHumanReview ||
      input.threadId)
  )
    throw new HttpError(
      400,
      "The fixture uses a fixed known-answer contract; custom contracts need the model runtime"
    )
  const budget =
    runtime === "agent"
      ? {
          ...input.budget,
          maxSteps: Math.min(input.budget.maxSteps, await getMaxSteps()),
        }
      : input.budget
  const durable = await durableClient()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    if (config.manualCompilation) {
      await client.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
        config.manualCompilation.sourceTaskId,
      ])
      const active = await client.query(
        "SELECT id FROM tasks WHERE owner_id=$1 AND config_snapshot->'manualCompilation'->>'sourceTaskId'=$2 AND status NOT IN ('completed','failed','cancelled') AND (source<>$3 OR request_key<>$4) LIMIT 1",
        [ownerId, config.manualCompilation.sourceTaskId, source, requestKey]
      )
      if (active.rowCount)
        throw new HttpError(
          409,
          `A manual draft is already in progress; resume task ${active.rows[0].id}`
        )
    }
    let completionContract = input.completionContract
    if (input.workflowExecution) {
      const frozen = await freezeWorkflowExecution(
        client,
        ownerId,
        input.workflowExecution
      )
      config.workflowExecution = frozen.execution
      completionContract = completionContractSchema.parse(frozen.completionContract)
      if (
        Object.keys(input.completionContract).some(
          (key) => key !== "requireHumanReview"
        ) ||
        input.completionContract.requireHumanReview
      )
        throw new HttpError(
          400,
          "Workflow execution uses its immutable version's bound completion contract"
        )
    }
    const taskId = randomUUID()
    const inserted = await client.query<{ id: string }>(
      `
      INSERT INTO tasks(id,owner_id,agent_id,source,request_key,request_payload,goal,status,
        active_segment,completion_contract,config_snapshot,budget,next_event_seq,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'queued',1,$8,$9,$10,0,now(),now())
      ON CONFLICT(owner_id,source,request_key) DO NOTHING RETURNING id`,
      [
        taskId,
        ownerId,
        agent.id,
        source,
        requestKey,
        JSON.stringify(payload),
        input.goal,
        JSON.stringify(completionContract),
        JSON.stringify(config),
        JSON.stringify(budget),
      ]
    )
    if (!inserted.rowCount) {
      const {
        rows: [existing],
      } = await client.query<SubmittedTask>(
        "SELECT id,thread_id,thread_turn,request_payload FROM tasks WHERE owner_id=$1 AND source=$2 AND request_key=$3",
        [ownerId, source, requestKey]
      )
      if (!isDeepStrictEqual(payload, existing.request_payload))
        throw new HttpError(
          409,
          "Request key already used with different task parameters"
        )
      await client.query("COMMIT")
      return {
        taskId: existing.id,
        threadId: existing.thread_id,
        threadTurn: existing.thread_turn,
        reused: true,
      }
    }
    let threadId: string | null = null,
      threadTurn: number | null = null
    if (runtime === "agent" && !input.lifeSession) {
      threadId = input.threadId ?? randomUUID()
      if (input.threadId) {
        const thread = await client.query(
          `SELECT th.id FROM threads th WHERE th.id=$1 AND th.agent_id=$2
          AND EXISTS(SELECT 1 FROM tasks WHERE thread_id=th.id AND owner_id=$3) FOR UPDATE`,
          [threadId, agent.id, ownerId]
        )
        if (!thread.rowCount)
          throw new HttpError(404, "Conversation does not belong to this owner and agent")
        const active = await client.query(
          "SELECT id FROM tasks WHERE thread_id=$1 AND (status NOT IN ('completed','cancelled','failed') OR cancel_workflow_pending) LIMIT 1",
          [threadId]
        )
        if (active.rowCount)
          throw new HttpError(
            409,
            "The previous turn is still active; answer its request or cancel it before sending another message"
          )
      } else {
        await client.query(
          "INSERT INTO threads(id,agent_id,title,preview,active_at,created_at) VALUES($1,$2,$3,$4,now(),now())",
          [threadId, agent.id, input.goal.slice(0, 80), input.goal.slice(0, 200)]
        )
      }
      const count = await client.query<{ next: number }>(
        "SELECT COALESCE(max(thread_turn),0)+1 AS next FROM tasks WHERE thread_id=$1",
        [threadId]
      )
      threadTurn = count.rows[0].next
      const past = (
        await client.query<ConversationTurn>(
          "SELECT id,goal,status,result,error FROM tasks WHERE thread_id=$1 AND owner_id=$2 ORDER BY thread_turn DESC LIMIT 50",
          [threadId, ownerId]
        )
      ).rows.reverse()
      const interactions = await client.query<{ taskId: string } & ThreadInteraction>(
        `SELECT task_id AS "taskId",kind,decision,
        COALESCE(payload->>'question',payload->>'reason',payload->>'message',payload->>'summary','') AS question,
        COALESCE(response->>'answer',response->>'note','') AS answer FROM task_requests
        WHERE task_id=ANY($1::text[]) AND status='resolved' ORDER BY resolved_at,id`,
        [past.map((turn) => turn.id)]
      )
      for (const turn of past)
        turn.interactions = interactions.rows.filter(
          (interaction) => interaction.taskId === turn.id
        )
      const context = conversationContext(past)
      config.conversation = context.conversation
      config.omittedConversationTurns =
        context.omittedConversationTurns + threadTurn - 1 - past.length
      await client.query(
        "UPDATE tasks SET thread_id=$2,thread_turn=$3,config_snapshot=$4 WHERE id=$1",
        [taskId, threadId, threadTurn, JSON.stringify(config)]
      )
      await client.query(
        "UPDATE threads SET active_at=clock_timestamp(),preview=$2 WHERE id=$1",
        [threadId, input.goal.slice(0, 200)]
      )
      await client.query(
        "INSERT INTO messages(id,thread_id,role,parts,metadata,created_at) VALUES($1,$2,'user',$3,$4,clock_timestamp())",
        [
          `${taskId}-prompt`,
          threadId,
          JSON.stringify([{ type: "text", text: input.goal }]),
          JSON.stringify({
            taskId,
            agentId: agent.id,
            threadTurn,
            ...(source === "telegram" ? { via: "telegram" } : {}),
          }),
        ]
      )
    }
    if (config.workflowCompilation)
      await client.query(
        `INSERT INTO workflow_versions(id,workflow_id,revision,owner_id,name,source_task_id,compilation_task_id,status,created_at,updated_at)
         VALUES($1,$1,1,$2,$3,$4,$1,'draft',now(),now())`,
        [
          taskId,
          ownerId,
          config.workflowCompilation.name,
          config.workflowCompilation.sourceTaskId,
        ]
      )
    if (config.workflowExecution)
      await client.query(
        `INSERT INTO task_workflow_runs(task_id,version_id,purpose,parameters,checkpoint,created_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [
          taskId,
          config.workflowExecution.versionId,
          config.workflowExecution.purpose,
          JSON.stringify(config.workflowExecution.parameters),
          JSON.stringify({
            step: 0,
            phase: "observe",
            frame: null,
            waitStartedAt: null,
            blockedReason: null,
          }),
        ]
      )
    const workflowID = `${taskId}:1`
    await client.query(
      "INSERT INTO task_segments(task_id,segment_no,agent_id,workflow_id,snapshot,created_at) VALUES($1,1,$2,$3,$4,now())",
      [taskId, agent.id, workflowID, JSON.stringify({ config })]
    )
    await appendEventInTransaction(client, taskId, "accepted", "accepted", {
      agentId: agent.id,
      goal: input.goal,
      threadId,
      threadTurn,
    })
    await durable.enqueueInTransaction(
      client,
      {
        queueName: TASK_QUEUE,
        workflowName: TASK_WORKFLOW,
        workflowID,
        queuePartitionKey: agent.id,
        appVersion: APPLICATION_VERSION,
      },
      taskId,
      1
    )
    await client.query("COMMIT")
    return { taskId, threadId, threadTurn, reused: false }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function getTask(ownerId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.ownerId, ownerId)))
  if (!task) throw new HttpError(404, "Task not found")
  const [thread] = task.threadId
    ? await db
        .select({ id: threads.id, title: threads.title })
        .from(threads)
        .where(eq(threads.id, task.threadId))
    : []
  const [files, requests, actions, controlRows, modelUsage, paymentRows, segments] =
    await Promise.all([
      db.select().from(artifacts).where(eq(artifacts.taskId, taskId)),
      db.select().from(taskRequests).where(eq(taskRequests.taskId, taskId)),
      db
        .select({
          segmentNo: taskActions.segmentNo,
          actionNo: taskActions.actionNo,
          kind: taskActions.kind,
          status: taskActions.status,
          createdAt: taskActions.createdAt,
          finishedAt: taskActions.finishedAt,
        })
        .from(taskActions)
        .where(eq(taskActions.taskId, taskId)),
      // Project explicitly: the encrypted connection credential never enters Web JSON or SSE.
      db
        .select({
          mode: workstationControl.mode,
          epoch: workstationControl.epoch,
          desiredMode: workstationControl.desiredMode,
          updatedAt: workstationControl.updatedAt,
        })
        .from(workstationControl)
        .where(eq(workstationControl.activeTaskId, taskId)),
      pool.query<{
        decisions: number
        known_cost_micros: string
        unknown_cost_attempts: number
        uncertain_attempts: number
      }>(
        `SELECT (SELECT count(*)::int FROM task_model_decisions WHERE task_id=$1) AS decisions,COALESCE(sum(COALESCE(cost_micros,reconciled_cost_micros)),0)::text AS known_cost_micros,
      count(*) FILTER(WHERE cost_micros IS NULL AND reconciled_cost_micros IS NULL)::int AS unknown_cost_attempts,
      count(*) FILTER(WHERE status='unknown')::int AS uncertain_attempts FROM task_model_attempts WHERE task_id=$1`,
        [taskId]
      ),
      pool.query<{ evidence: import("@/lib/payment-schema").PaymentResultReceipt }>(
        "SELECT receipt->'output' AS evidence FROM task_actions WHERE task_id=$1 AND kind='payment_result' AND status='succeeded' ORDER BY segment_no,action_no",
        [taskId]
      ),
      pool.query<{
        segmentNo: number
        agentId: string
        name: string
        model: string
        brief: string | null
      }>(
        `SELECT segment_no AS "segmentNo",agent_id AS "agentId",snapshot->'config'->>'name' AS name,snapshot->'config'->>'model' AS model,snapshot->'handoff'->'input'->>'brief' AS brief FROM task_segments WHERE task_id=$1 ORDER BY segment_no`,
        [taskId]
      ),
    ])
  return {
    ...task,
    workflowRun: task.configSnapshot.workflowExecution
      ? {
          versionId: task.configSnapshot.workflowExecution.versionId,
          purpose: task.configSnapshot.workflowExecution.purpose,
          allowRepair: task.configSnapshot.workflowExecution.allowRepair === true,
          totalSteps: task.configSnapshot.workflowExecution.plan.steps.length,
          ...(
            await pool.query<{
              step: number
              phase: string
              blockedReason: string | null
              repairStatus: string | null
              repairCursor: number | null
              draftVersionId: string | null
            }>(
              `SELECT (checkpoint->>'step')::int AS step,checkpoint->>'phase' AS phase,checkpoint->>'blockedReason' AS "blockedReason",
               checkpoint->'repair'->>'status' AS "repairStatus",(checkpoint->'repair'->>'cursor')::int AS "repairCursor",checkpoint->'repair'->>'draftVersionId' AS "draftVersionId"
         FROM task_workflow_runs WHERE task_id=$1`,
              [task.id]
            )
          ).rows[0],
        }
      : null,
    conversationAgentId: task.requestPayload.agentId,
    segments: segments.rows,
    configSnapshot: {
      runtime: task.configSnapshot.runtime,
      model: task.configSnapshot.model,
    },
    thread: thread ?? null,
    artifacts: files,
    requests,
    actions,
    paymentResults: paymentRows.rows.map((row) => row.evidence),
    control: controlRows[0] ?? null,
    usage: modelUsage.rows[0],
  }
}

export async function listTasks(ownerId: string) {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        sql`${tasks.configSnapshot}->>'runtime' IS DISTINCT FROM 'fixture'`,
        sql`NOT ${tasks.configSnapshot} ? 'lifeSession'`
      )
    )
    .orderBy(desc(tasks.createdAt))
    .limit(50)
  return rows.map((task) => ({
    ...task,
    conversationAgentId: task.requestPayload.agentId,
  }))
}

export async function listTaskEvents(taskId: string, after: number) {
  const result = await pool.query(
    "SELECT seq,type,payload,created_at FROM task_events WHERE task_id=$1 AND seq>$2 ORDER BY seq LIMIT 200",
    [taskId, after]
  )
  return result.rows as {
    seq: number
    type: string
    payload: Record<string, unknown>
    created_at: Date
  }[]
}
