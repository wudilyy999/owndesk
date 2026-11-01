import { isDeepStrictEqual } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { tasks, workstationControl } from "@/db/schema"
import { appendEventInTransaction } from "@/lib/task-events"
import { docker } from "@/lib/docker"
import { desktopToolNames } from "@/lib/agent/tools"
import { interruptedShell } from "@/lib/action-receipts"
import { vaultFillReceiptSchema, type VaultGrant } from "@/lib/vault-schema"
import {
  paymentSubmitReceiptSchema,
  paymentResultReceiptSchema,
} from "@/lib/payment-schema"
import {
  acquireWorkspace,
  assertAgentControl,
  controller,
  ControllerError,
  ensureWorkstation,
  TaskCancelled,
  SegmentSuperseded,
  workstationHealth,
  workspaceRow,
  WorkspacePaused,
} from "@/lib/workstation"

const routes = {
  shell: "shell",
  fs_read: "fs_read",
  fs_write: "fs_write",
  fs_list: "fs_list",
  screen_capture: "screen_capture",
  screen_share: "screen_share",
  pointer_click: "pointer_click",
  pointer_move: "pointer_move",
  pointer_drag: "pointer_drag",
  pointer_scroll: "pointer_scroll",
  key_type: "key_type",
  key_press: "key_press",
  desktop_open_application: "desktop_open_application",
  desktop_list_windows: "desktop_list_windows",
  desktop_get_window_state: "desktop_get_window_state",
  desktop_ax_snapshot: "desktop_ax_snapshot",
  desktop_element_action: "desktop_element_action",
  desktop_ax_action: "desktop_ax_action",
  desktop_type: "desktop_type",
  desktop_tag_context: "desktop_tag_context",
  desktop_tag_replace: "desktop_tag_replace",
  desktop_tag_release: "desktop_tag_release",

  browser_open: "open",
  browser_pages: "pages",
  browser_observe: "observe",
  browser_click: "click",
  browser_fill: "fill",
  browser_screenshot: "screenshot",
  browser_download: "download",
  vault_fill: "vault_fill",
  payment_submit: "payment_submit",
  payment_result: "payment_result",
} as const
export type ActionKind = keyof typeof routes
export type ActionResult = {
  ok: boolean
  output: Record<string, unknown>
  needsReview?: string
  stale?: boolean
}
const readOnly = new Set<ActionKind>([
  "desktop_list_windows",
  "desktop_get_window_state",
  "desktop_ax_snapshot",
  "desktop_tag_context",
  "desktop_tag_release",

  "fs_read",
  "fs_list",
  "screen_capture",
  "screen_share",
  "browser_pages",
  "browser_observe",
  "browser_screenshot",
  "payment_result",
])
const verifiable = new Set<ActionKind>(["fs_write", "browser_download"])
const statusSchema = z
  .object({
    found: z.boolean(),
    bootId: z.string().optional(),
    currentBootId: z.string().optional(),
    status: z
      .enum(["starting", "running", "succeeded", "rejected", "unknown"])
      .optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.found &&
      (!value.status || !value.bootId || (value.status === "succeeded" && !value.result))
    )
      context.addIssue({
        code: "custom",
        message: "Workspace returned an incomplete action receipt",
      })
    if (!value.found && !value.bootId)
      context.addIssue({ code: "custom", message: "Workspace omitted its boot identity" })
  })
type Attempt = {
  attempt_no: number
  dispatch_id: string
  epoch: number
  boot_id: string
  status: string
  secret_released_at: Date | null
}
export type DispatchAuthorization =
  | { values: { field: string; value: string }[] }
  | { authorized: true }
  | { rejected: string }
  | { unknown: string }

function vaultReceipt(input: Record<string, unknown>, result: unknown, complete = false) {
  const parsed = vaultFillReceiptSchema.safeParse(result)
  if (!parsed.success) return null
  const expected = (input.fields as VaultGrant["fields"]).map((field) => field.field)
  const data = parsed.data
  if (
    data.origin !== input.origin ||
    data.filled.some((field) => !expected.includes(field)) ||
    data.attempted.some((field) => !expected.includes(field)) ||
    new Set(data.filled).size !== data.filled.length ||
    new Set(data.attempted).size !== data.attempted.length
  )
    return null
  if (
    complete &&
    (data.stage !== "done" ||
      !isDeepStrictEqual(data.filled, expected) ||
      !isDeepStrictEqual(data.attempted, expected))
  )
    return null
  return data
}

export async function executeAction(
  taskId: string,
  segmentNo: number,
  actionNo: number,
  kind: ActionKind,
  input: Record<string, unknown>,
  expectedEpoch?: number,
  authorizeDispatch?: (attemptNo: number) => Promise<DispatchAuthorization>
): Promise<ActionResult> {
  if (!Object.hasOwn(routes, kind)) throw new Error(`Unknown workstation tool ${kind}`)
  if (["vault_fill", "payment_submit"].includes(kind) && !authorizeDispatch)
    throw new Error("Sensitive dispatch requires its bound authorizer")
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (task.configSnapshot.workstationChannel === "desktop" && !desktopToolNames.has(kind))
    return {
      ok: false,
      output: {
        error: "Desktop-only task rejected this workstation tool before dispatch.",
      },
    }
  if (task.cancelRequestedAt || task.status === "cancelled") throw new TaskCancelled()
  const key = [taskId, segmentNo, actionNo]
  const {
    rows: [existing],
  } = await pool.query<{
    kind: string
    input: Record<string, unknown>
    status: string
    receipt: ActionResult | null
  }>(
    "SELECT kind,input,status,receipt FROM task_actions WHERE task_id=$1 AND segment_no=$2 AND action_no=$3",
    key
  )
  if (existing && (existing.kind !== kind || !isDeepStrictEqual(existing.input, input)))
    throw new Error("Logical action ID reused with a different tool or input")
  if (existing?.status === "succeeded" || existing?.status === "failed") {
    if (interruptedShell(kind, existing.receipt!.output))
      return requestReview(
        taskId,
        segmentNo,
        actionNo,
        task.agentId,
        kind,
        "Shell was interrupted; external effects may already have occurred. Inspect them before continuing.",
        {
          signal: existing.receipt!.output.signal,
          timedOut: existing.receipt!.output.timedOut,
        }
      )
    return existing.receipt!
  }
  if (task.activeSegment !== segmentNo) throw new SegmentSuperseded()
  if (existing?.status === "unknown")
    return requestReview(
      taskId,
      segmentNo,
      actionNo,
      task.agentId,
      kind,
      "Previous execution has an unresolved external effect"
    )

  await ensureWorkstation(task.agentId)
  let workspace = await workspaceRow(task.agentId)
  const health = await workstationHealth(task.agentId)
  if (
    [
      "desktop_list_windows",
      "desktop_get_window_state",
      "desktop_ax_snapshot",
      "desktop_element_action",
      "desktop_ax_action",
      "desktop_type",
      "desktop_tag_context",
      "desktop_tag_replace",
      "desktop_tag_release",
    ].includes(kind) &&
    !health.capabilities?.includes("atspi-native-v1")
  )
    return {
      ok: false,
      output: {
        error:
          "This workstation does not advertise atspi-native-v1; use existing desktop observations/input or upgrade its paired image.",
        rejectedBeforeEffect: true,
      },
    }
  if (["human", "quarantined"].includes(workspace.mode) || workspace.desiredMode)
    throw new WorkspacePaused()
  if (
    workspace.activeTaskId !== taskId ||
    workspace.mode !== "agent" ||
    workspace.bootId !== health.bootId ||
    workspace.epoch !== health.epoch
  )
    workspace = await acquireWorkspace(
      task,
      task.configSnapshot.lifeSession ? "life" : "errand"
    )
  await assertAgentControl(taskId, task.agentId)
  if (task.configSnapshot.workstationChannel === "desktop") {
    const key = `desktop-environment:${segmentNo}:${workspace.bootId}`
    if (
      !(
        await pool.query("SELECT 1 FROM task_events WHERE task_id=$1 AND key=$2", [
          task.id,
          key,
        ])
      ).rowCount
    ) {
      const [container] = JSON.parse(
        (
          await docker(["inspect", workspace.containerName], { maxOutputBytes: 100000 })
        ).stdout.toString()
      )
      const locale = (container.Config.Env as string[])
        .find((value) => value.startsWith("LANG="))!
        .slice(5)
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await appendEventInTransaction(client, task.id, key, "desktop_environment", {
          environment: {
            workstationImageId: container.Image,
            guestProtocol: health.protocolVersion,
            locale,
            application: "Thunar",
          },
          bootId: workspace.bootId,
        })
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
  }
  if (!existing && expectedEpoch !== undefined && expectedEpoch !== workspace.epoch)
    return {
      ok: false,
      stale: true,
      output: {
        error:
          "Control changed after this model decision. Observe again before deciding another action.",
      },
    }
  const effect = readOnly.has(kind)
    ? "read"
    : verifiable.has(kind)
      ? "verifiable"
      : "ambiguous"
  let attempt = (
    await pool.query<Attempt>(
      "SELECT * FROM task_action_attempts WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 ORDER BY attempt_no DESC LIMIT 1",
      key
    )
  ).rows[0]
  if (!attempt) {
    const dispatchId = `${taskId}-s${segmentNo}-a${actionNo}`
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `INSERT INTO task_actions(task_id,segment_no,action_no,dispatch_id,epoch,boot_id,kind,input,effect_class,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'intent',now())`,
        [
          ...key,
          dispatchId,
          workspace.epoch,
          workspace.bootId,
          kind,
          JSON.stringify(input),
          effect,
        ]
      )
      await client.query(
        `INSERT INTO task_action_attempts(task_id,segment_no,action_no,attempt_no,dispatch_id,epoch,boot_id,status,created_at)
        VALUES($1,$2,$3,1,$4,$5,$6,'intent',now())`,
        [...key, dispatchId, workspace.epoch, workspace.bootId]
      )
      await client.query(
        "UPDATE workstation_control SET active_action_id=$2 WHERE agent_id=$1",
        [task.agentId, dispatchId]
      )
      await appendEventInTransaction(
        client,
        taskId,
        `action:${segmentNo}:${actionNo}`,
        "tool_started",
        { segmentNo, actionNo, tool: kind }
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    attempt = {
      attempt_no: 1,
      dispatch_id: dispatchId,
      epoch: workspace.epoch,
      boot_id: workspace.bootId!,
      status: "intent",
      secret_released_at: null,
    }
  }

  let status = statusSchema.parse(
    await controller(task.agentId, "/action-status", { id: attempt.dispatch_id })
  )
  if (
    kind === "vault_fill" &&
    !status.found &&
    attempt.boot_id !== workspace.bootId &&
    !attempt.secret_released_at
  )
    return finishAction(key, task.agentId, attempt.attempt_no, {
      ok: false,
      stale: true,
      output: {
        error:
          "The approved workspace changed before secrets were released. Observe and request a new approval.",
        rejectedBeforeEffect: true,
      },
    })
  if (
    (status.found && status.status === "unknown") ||
    (!status.found && attempt.boot_id !== workspace.bootId)
  ) {
    const reconciled = await reconcileFile(
      task.agentId,
      workspace.epoch,
      kind,
      input,
      attempt.dispatch_id
    )
    if (reconciled)
      return finishAction(key, task.agentId, attempt.attempt_no, {
        ok: true,
        output: { ...reconciled, reconciled: true },
      })
    if (!readOnly.has(kind))
      return requestReview(
        taskId,
        segmentNo,
        actionNo,
        task.agentId,
        kind,
        kind === "vault_fill"
          ? "Sensitive fill has no confirmed receipt after a workspace change. No secret was resent."
          : (status.error ?? "Controller changed before a final receipt was recorded"),
        kind === "vault_fill"
          ? (vaultReceipt(input, status.result) ?? undefined)
          : undefined
      )
    await pool.query(
      "UPDATE task_action_attempts SET status='unknown',finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4",
      [...key, attempt.attempt_no]
    )
    attempt = {
      attempt_no: attempt.attempt_no + 1,
      dispatch_id: `${taskId}-s${segmentNo}-a${actionNo}-r${attempt.attempt_no + 1}`,
      epoch: workspace.epoch,
      boot_id: workspace.bootId!,
      status: "intent",
      secret_released_at: null,
    }
    await pool.query(
      `INSERT INTO task_action_attempts(task_id,segment_no,action_no,attempt_no,dispatch_id,epoch,boot_id,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'intent',now())`,
      [...key, attempt.attempt_no, attempt.dispatch_id, attempt.epoch, attempt.boot_id]
    )
    status = statusSchema.parse(
      await controller(task.agentId, "/action-status", { id: attempt.dispatch_id })
    )
  }
  if (!status.found) {
    const release = authorizeDispatch
      ? await authorizeDispatch(attempt.attempt_no)
      : undefined
    if (release && "unknown" in release)
      return requestReview(
        taskId,
        segmentNo,
        actionNo,
        task.agentId,
        kind,
        release.unknown
      )
    if (release && "rejected" in release)
      return finishAction(key, task.agentId, attempt.attempt_no, {
        ok: false,
        stale: true,
        output: { error: release.rejected, rejectedBeforeEffect: true },
      })
    // A stable dispatch ID deduplicates an earlier request that is still arriving at this boot.
    await controller(task.agentId, "/actions", {
      id: attempt.dispatch_id,
      kind: routes[kind],
      params: {
        ...input,
        epoch: attempt.epoch,
        ...(kind === "browser_download" ? { actionId: attempt.dispatch_id } : {}),
      },
      ...(release && "values" in release ? { transient: release.values } : {}),
    })
  }

  while (true) {
    const {
      rows: [state],
    } = await pool.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1",
      [taskId]
    )
    if (state.cancel_requested_at) throw new TaskCancelled()
    status = statusSchema.parse(
      await controller(task.agentId, "/action-status", { id: attempt.dispatch_id })
    )
    if (status.status === "succeeded") {
      if (interruptedShell(kind, status.result!))
        return requestReview(
          taskId,
          segmentNo,
          actionNo,
          task.agentId,
          kind,
          "Shell was interrupted; external effects may already have occurred. Inspect them before continuing.",
          { signal: status.result!.signal, timedOut: status.result!.timedOut }
        )
      const receipt: Record<string, unknown> | null | undefined =
        kind === "vault_fill"
          ? vaultReceipt(input, status.result, true)
          : kind === "payment_submit"
            ? paymentSubmitReceiptSchema.safeParse(status.result).data
            : kind === "payment_result"
              ? paymentResultReceiptSchema.safeParse(status.result).data
              : status.result!
      const paymentResult =
        kind === "payment_result" && receipt
          ? paymentResultReceiptSchema.parse(receipt)
          : null
      if (
        (receipt &&
          ["payment_submit", "payment_result"].includes(kind) &&
          (receipt.origin !== input.origin ||
            receipt.submissionRequestId !== input.submissionRequestId)) ||
        (paymentResult &&
          (paymentResult.epoch !== attempt.epoch ||
            paymentResult.bootId !== attempt.boot_id ||
            paymentResult.evidence.merchant.text !== input.merchant ||
            paymentResult.evidence.amount.text !== input.amount ||
            Object.entries(
              input.evidenceRefs as Record<keyof typeof paymentResult.evidence, string>
            ).some(
              ([key, ref]) =>
                paymentResult.evidence[key as keyof typeof paymentResult.evidence].ref !==
                ref
            )))
      )
        return requestReview(
          taskId,
          segmentNo,
          actionNo,
          task.agentId,
          kind,
          "Payment evidence does not match this authorized action; inspect the result without submitting again."
        )
      if (!receipt)
        return requestReview(
          taskId,
          segmentNo,
          actionNo,
          task.agentId,
          kind,
          "Sensitive action returned an invalid receipt; inspect the page without repeating the action."
        )
      return finishAction(key, task.agentId, attempt.attempt_no, {
        ok: true,
        output:
          typeof receipt.image === "string"
            ? { ...receipt, epoch: attempt.epoch, bootId: attempt.boot_id }
            : receipt,
      })
    }
    if (status.status === "rejected") {
      const details = kind === "vault_fill" ? vaultReceipt(input, status.result) : null
      if (details?.attempted.length)
        return requestReview(
          taskId,
          segmentNo,
          actionNo,
          task.agentId,
          kind,
          "Sensitive fill may be partial; inspect before continuing.",
          details
        )
      return finishAction(key, task.agentId, attempt.attempt_no, {
        ok: false,
        stale:
          kind.startsWith("pointer_") ||
          kind.startsWith("key_") ||
          (kind.startsWith("desktop_") && !readOnly.has(kind)),
        output: {
          error:
            kind === "vault_fill"
              ? "Sensitive fill was rejected before typing. Observe the page and request a fresh approval."
              : status.error,
          rejectedBeforeEffect: true,
        },
      })
    }
    if (!status.found || status.status === "unknown") {
      if (readOnly.has(kind))
        return finishAction(key, task.agentId, attempt.attempt_no, {
          ok: false,
          output: { error: status.error ?? "Observation was interrupted; observe again" },
        })
      const reconciled = await reconcileFile(
        task.agentId,
        workspace.epoch,
        kind,
        input,
        attempt.dispatch_id
      )
      if (reconciled)
        return finishAction(key, task.agentId, attempt.attempt_no, {
          ok: true,
          output: { ...reconciled, reconciled: true },
        })
      return requestReview(
        taskId,
        segmentNo,
        actionNo,
        task.agentId,
        kind,
        kind === "vault_fill"
          ? "Sensitive fill may have happened fully or partially. Inspect the page; no secret was resent."
          : (status.error ?? "Tool outcome could not be confirmed"),
        kind === "vault_fill"
          ? (vaultReceipt(input, status.result) ?? undefined)
          : undefined
      )
    }
    await delay(200)
  }
}

async function reconcileFile(
  agentId: string,
  epoch: number,
  kind: ActionKind,
  input: Record<string, unknown>,
  dispatchId: string
): Promise<Record<string, unknown> | null> {
  try {
    if (kind === "fs_write") {
      const file = await controller<{
        content: string
        bytes: number
        truncated: boolean
      }>(agentId, "/fs_read", { epoch, path: input.path })
      if (!file.truncated && file.content === input.content)
        return { path: input.path, bytes: file.bytes }
    }
    if (kind === "browser_download") {
      const directory = `/home/agent/Downloads/agent/${dispatchId}`
      const listing = await controller<{
        entries: { name: string; dir: boolean; size: number }[]
      }>(agentId, "/fs_list", { epoch, path: directory })
      const files = listing.entries.filter((e) => !e.dir && !e.name.endsWith(".partial"))
      if (files.length === 1 && files[0].size > 0)
        return {
          path: `${directory}/${files[0].name}`,
          name: files[0].name,
          bytes: files[0].size,
          verification:
            "Local download completion only; business contents still need trusted verification",
        }
    }
    return null
  } catch (error) {
    if (
      error instanceof ControllerError &&
      ["ENOENT", "ENOTDIR"].includes(error.code ?? "")
    )
      return null
    throw error
  }
}

async function finishAction(
  key: (string | number)[],
  agentId: string,
  attemptNo: number,
  receipt: ActionResult
) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const {
      rows: [task],
    } = await client.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [key[0]]
    )
    if (task.cancel_requested_at) throw new TaskCancelled()
    await client.query(
      "UPDATE task_actions SET status=$4,receipt=$5,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3",
      [...key, receipt.ok ? "succeeded" : "failed", JSON.stringify(receipt)]
    )
    await client.query(
      "UPDATE task_action_attempts SET status=$5,receipt=$6,finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND attempt_no=$4",
      [...key, attemptNo, receipt.ok ? "succeeded" : "rejected", JSON.stringify(receipt)]
    )
    await client.query(
      "UPDATE workstation_control SET active_action_id=NULL WHERE agent_id=$1 AND active_task_id=$2",
      [agentId, key[0]]
    )
    await appendEventInTransaction(
      client,
      String(key[0]),
      `action-result:${key[1]}:${key[2]}`,
      "tool_result",
      { segmentNo: key[1], actionNo: key[2], ok: receipt.ok }
    )
    await client.query("COMMIT")
    return receipt
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function requestReview(
  taskId: string,
  segmentNo: number,
  actionNo: number,
  agentId: string,
  kind: ActionKind,
  reason: string,
  details?: Record<string, unknown>
): Promise<ActionResult> {
  const requestId = `${taskId}-s${segmentNo}-a${actionNo}-review`
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const state = await client.query<{ cancel_requested_at: Date | null }>(
      "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
      [taskId]
    )
    if (state.rows[0].cancel_requested_at) throw new TaskCancelled()
    await client.query(
      "UPDATE task_actions SET status='unknown' WHERE task_id=$1 AND segment_no=$2 AND action_no=$3",
      [taskId, segmentNo, actionNo]
    )
    await client.query(
      "UPDATE task_action_attempts SET status='unknown',finished_at=now() WHERE task_id=$1 AND segment_no=$2 AND action_no=$3 AND status='intent'",
      [taskId, segmentNo, actionNo]
    )
    await client.query(
      `INSERT INTO task_requests(id,task_id,agent_id,segment_no,action_no,kind,payload,payload_version,status,created_at)
      VALUES($1,$2,$3,$4,$5,'review',$6,1,'pending',now()) ON CONFLICT(id) DO NOTHING`,
      [
        requestId,
        taskId,
        agentId,
        segmentNo,
        actionNo,
        JSON.stringify({ tool: kind, reason, ...(details ? { details } : {}) }),
      ]
    )
    await client.query(
      "UPDATE tasks SET status='needs_review',error=$2,updated_at=now() WHERE id=$1 AND cancel_requested_at IS NULL",
      [taskId, reason]
    )
    await client.query(
      "UPDATE workstation_control SET active_action_id=NULL WHERE agent_id=$1 AND active_task_id=$2",
      [agentId, taskId]
    )
    await appendEventInTransaction(
      client,
      taskId,
      `review:${requestId}`,
      "needs_review",
      {
        requestId,
        tool: kind,
        reason,
        message:
          "The action may already have happened. No automatic replay was performed.",
      }
    )
    await client.query("COMMIT")
    return {
      ok: false,
      needsReview: requestId,
      output: { error: reason, effect: "unknown", ...(details ? { details } : {}) },
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
