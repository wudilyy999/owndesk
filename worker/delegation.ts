import path from "node:path"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { db, pool } from "@/db"
import { agents, type SegmentSnapshot, type Task } from "@/db/schema"
import { eq } from "drizzle-orm"
import { agentSnapshot } from "@/lib/agent/snapshot"
import {
  APPLICATION_VERSION,
  TASK_QUEUE,
  TASK_WORKFLOW,
  durableClient,
} from "@/lib/durable"
import { HttpError } from "@/lib/errors"
import { artifactDir } from "@/lib/env"
import { docker } from "@/lib/docker"
import { appendEventInTransaction } from "@/lib/task-events"
import {
  assertAgentControl,
  releaseWorkspace,
  workspaceRow,
  workstationName,
  withWorkspaceOperation,
  TaskCancelled,
  SegmentSuperseded,
  WorkspacePaused,
} from "@/lib/workstation"
import { ArtifactValidationError, collectArtifacts } from "./artifacts"
import { trackActivity } from "./activity"

type Handoff = NonNullable<SegmentSnapshot["handoff"]>
export async function executeDelegate(
  task: Task,
  segmentNo: number,
  actionNo: number,
  input: Handoff["input"],
  epoch: number
) {
  if (!task.requestPayload.delegateAgentIds?.includes(input.agentId))
    return {
      ok: false,
      output: {
        error: "Target is outside this task's owner-approved delegation roster.",
      },
    }
  const next = segmentNo + 1
  const result = {
    ok: true,
    delegated: true,
    output: { agentId: input.agentId, segmentNo: next, workflowId: `${task.id}:${next}` },
  }
  const previous = (
    await pool.query<{ snapshot: SegmentSnapshot }>(
      "SELECT snapshot FROM task_segments WHERE task_id=$1 AND segment_no=$2",
      [task.id, next]
    )
  ).rows[0]
  if (previous) {
    if (
      previous.snapshot.handoff!.actionNo !== actionNo ||
      !isDeepStrictEqual(previous.snapshot.handoff!.input, input)
    )
      throw new Error("Delegation action reused with different parameters")
    return result
  }
  const key = `handoff-prepared:${segmentNo}:${actionNo}`
  let prepared = (
    await pool.query<{ payload: SegmentSnapshot }>(
      "SELECT payload FROM task_events WHERE task_id=$1 AND key=$2",
      [task.id, key]
    )
  ).rows[0]?.payload
  if (prepared && !isDeepStrictEqual(prepared.handoff!.input, input))
    throw new Error("Delegation preparation reused with different parameters")
  if (!prepared) {
    const control = await assertAgentControl(task.id, task.agentId, segmentNo)
    if (control.epoch !== epoch)
      return {
        ok: false,
        stale: true,
        output: { error: "Control changed; observe before delegating." },
      }
    const [target] = await db.select().from(agents).where(eq(agents.id, input.agentId))
    if (!target || target.model === "fixture/durable-report")
      return {
        ok: false,
        output: { error: "Choose an existing non-fixture agent from list_agents." },
      }
    try {
      const config: Task["configSnapshot"] = await agentSnapshot(
        target,
        task.ownerId,
        task.configSnapshot.timeZone
      )
      config.conversation = task.configSnapshot.conversation
      config.omittedConversationTurns = task.configSnapshot.omittedConversationTurns
      const { files } = await trackActivity(task.id, () =>
        collectArtifacts(task.id, segmentNo, actionNo, task.agentId, input.files, {
          requireHumanReview: false,
        })
      )
      const answers = (
        await pool.query<{ question: string; answer: string }>(
          "SELECT payload->>'question' AS question,response->>'answer' AS answer FROM task_requests WHERE task_id=$1 AND status='resolved' AND payload->>'purpose'='question' AND response->>'answer' IS NOT NULL ORDER BY resolved_at DESC LIMIT 20",
          [task.id]
        )
      ).rows.reverse()
      prepared = {
        config,
        handoff: {
          fromSegment: segmentNo,
          fromAgentId: task.agentId,
          actionNo,
          input,
          files,
          answers,
        },
      }
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const state = (
          await client.query(
            "SELECT active_segment,cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
            [task.id]
          )
        ).rows[0]
        if (state.cancel_requested_at) throw new TaskCancelled()
        if (state.active_segment !== segmentNo) throw new SegmentSuperseded()
        const current = (
          await client.query(
            "SELECT mode,desired_mode,epoch,active_task_id FROM workstation_control WHERE agent_id=$1 FOR UPDATE",
            [task.agentId]
          )
        ).rows[0]
        if (
          current.mode !== "agent" ||
          current.desired_mode ||
          current.epoch !== epoch ||
          current.active_task_id !== task.id
        )
          throw new WorkspacePaused()
        const unfinished = await client.query(
          "SELECT 1 FROM task_actions WHERE task_id=$1 AND status='intent' LIMIT 1",
          [task.id]
        )
        if (unfinished.rowCount)
          throw new HttpError(
            409,
            "Finish or reconcile the current action before delegating."
          )
        await appendEventInTransaction(client, task.id, key, "handoff_prepared", prepared)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      if (error instanceof HttpError || error instanceof ArtifactValidationError)
        return { ok: false, output: { error: error.message } }
      throw error
    }
  }
  const source = await workspaceRow(task.agentId)
  if (source.activeTaskId === task.id) await releaseWorkspace(task.id, task.agentId)
  else if (source.activeTaskId || source.mode !== "idle" || source.desiredMode)
    throw new WorkspacePaused()
  const durable = await durableClient(),
    client = await pool.connect()
  try {
    await client.query("BEGIN")
    const state = (
      await client.query(
        "SELECT active_segment,cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
        [task.id]
      )
    ).rows[0]
    if (state.cancel_requested_at) throw new TaskCancelled()
    if (state.active_segment !== segmentNo) throw new SegmentSuperseded()
    await client.query(
      "INSERT INTO task_segments(task_id,segment_no,agent_id,workflow_id,snapshot,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())",
      [task.id, next, input.agentId, `${task.id}:${next}`, JSON.stringify(prepared)]
    )
    await client.query(
      "UPDATE tasks SET agent_id=$2,active_segment=$3,config_snapshot=$4,status='queued',updated_at=clock_timestamp() WHERE id=$1",
      [task.id, input.agentId, next, JSON.stringify(prepared.config)]
    )
    await durable.enqueueInTransaction(
      client,
      {
        queueName: TASK_QUEUE,
        workflowName: TASK_WORKFLOW,
        workflowID: `${task.id}:${next}`,
        queuePartitionKey: input.agentId,
        appVersion: APPLICATION_VERSION,
      },
      task.id,
      next
    )
    await appendEventInTransaction(
      client,
      task.id,
      `delegated:${segmentNo}:${actionNo}`,
      "delegated",
      {
        fromAgentId: task.agentId,
        agentId: input.agentId,
        fromSegment: segmentNo,
        segmentNo: next,
        brief: input.brief,
        files: prepared.handoff!.files,
        message: `${task.configSnapshot.name} handed the remaining task to ${prepared.config.name}; queued on the target workstation.`,
      }
    )
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function importHandoffFiles(
  task: Task,
  segmentNo: number,
  handoff: Handoff
) {
  return withWorkspaceOperation(task.agentId, () =>
    trackActivity(task.id, async () => {
      const files: { id: string; path: string }[] = []
      for (const [index, file] of handoff.files.entries()) {
        await assertAgentControl(task.id, task.agentId, segmentNo)
        const artifact = (
          await pool.query<{ storage_path: string }>(
            "SELECT storage_path FROM artifacts WHERE id=$1 AND task_id=$2",
            [file.id, task.id]
          )
        ).rows[0]
        const source = path.join(artifactDir, artifact.storage_path)
        const target = `/home/agent/Transfers/${task.id}/s${segmentNo}/${index}-${file.name}`
        const expected = await readFile(source)
        await docker(
          [
            "exec",
            workstationName(task.agentId),
            "mkdir",
            "-p",
            path.posix.dirname(target),
          ],
          { timeoutMs: 15000 }
        )
        await docker(["cp", source, `${workstationName(task.agentId)}:${target}`], {
          timeoutMs: 60000,
        })
        const actual = await docker(
          ["exec", workstationName(task.agentId), "cat", target],
          { timeoutMs: 15000, maxOutputBytes: 20000000 }
        )
        if (!actual.stdout.equals(expected))
          throw new Error("Transferred file differs from the frozen host artifact")
        files.push({ id: file.id, path: target })
      }
      return files
    })
  )
}
