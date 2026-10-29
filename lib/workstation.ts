import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { eq } from "drizzle-orm"
import { db, pool } from "@/db"
import { agents, tasks, workstationControl, type Task } from "@/db/schema"
import { docker, dockerRaw, dockerReason, dockerStream } from "@/lib/docker"
import { env } from "@/lib/env"
import { decryptSecret, encryptSecret } from "@/lib/secrets"
import { assertWorkstationNetwork } from "@/worker/network"

export type WorkspaceHealth = {
  ready: boolean
  protocolVersion: number
  capabilities?: string[]
  mode: string
  epoch: number
  bootId: string
  active: number
  shellUsed: boolean
}
export type Workspace = typeof workstationControl.$inferSelect
export class ControllerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message)
  }
}
type Connection = { token: string; password: string }
const pending = new Map<string, Promise<Workspace>>()
const lifecycleLocks = new Map<string, Promise<void>>()
const prefix = `pa-${env.INSTALL_ID.slice(0, 8)}`
export const workstationName = (agentId: string) => `${prefix}-ws-${agentId}`
export const workstationVolume = (agentId: string) => `${prefix}-home-${agentId}`
export const viewerName = (agentId: string) => `${prefix}-viewer-${agentId}`
export const displayVolume = (agentId: string) => `${prefix}-display-${agentId}`

export async function withWorkspaceOperation<T>(
  agentId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = lifecycleLocks.get(agentId)
  let release!: () => void
  const latch = new Promise<void>((resolve) => {
    release = resolve
  })
  lifecycleLocks.set(agentId, latch)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (lifecycleLocks.get(agentId) === latch) lifecycleLocks.delete(agentId)
  }
}

export async function workspaceRow(agentId: string): Promise<Workspace> {
  const [row] = await db
    .select()
    .from(workstationControl)
    .where(eq(workstationControl.agentId, agentId))
  if (!row) throw new Error("Workstation has not been provisioned")
  return row
}

export function workspaceConnection(workspace: Workspace): Connection {
  return JSON.parse(decryptSecret(workspace.connectionSecret))
}

async function inspect(name: string) {
  const result = await dockerRaw(["inspect", "--type", "container", name], {
    timeoutMs: 15000,
  })
  if (result.exitCode !== 0) {
    if (/no such (container|object)/i.test(result.stderr)) return null
    throw new Error(dockerReason(result.stderr))
  }
  const [data] = JSON.parse(result.stdout.toString()) as {
    State: { Running: boolean }
    Config: { Labels: Record<string, string> }
    HostConfig: {
      PortBindings: Record<string, unknown> | null
      NetworkMode: string
      CapDrop: string[] | null
      Sysctls: Record<string, string> | null
      Dns: string[] | null
    }
  }[]
  if (data.Config.Labels["personal-agent.install"] !== env.INSTALL_ID)
    throw new Error("Container belongs to a different installation")
  return data
}

export async function controller<T = Record<string, unknown>>(
  agentId: string,
  route: string,
  body: unknown
): Promise<T> {
  const row = await workspaceRow(agentId)
  const result = await dockerRaw(
    [
      "exec",
      "-i",
      row.containerName,
      "node",
      "/opt/owndesk-controller/request.mjs",
      route,
    ],
    { input: JSON.stringify(body), timeoutMs: route === "/quiesce" ? 5000 : 45000 }
  )
  if (result.exitCode !== 0) {
    if (result.stdout.length) {
      const failure = JSON.parse(result.stdout.toString()) as {
        error: string
        code?: string
        status?: number
      }
      throw new ControllerError(failure.error, failure.code, failure.status)
    }
    throw new Error(
      `Workstation ${route} transport failed: ${dockerReason(result.stderr)}`
    )
  }
  return JSON.parse(result.stdout.toString()) as T
}

export async function workstationHealth(agentId: string): Promise<WorkspaceHealth> {
  const row = await workspaceRow(agentId)
  const result = await docker(
    ["exec", row.containerName, "curl", "-fsS", "http://127.0.0.1:6079/health"],
    { timeoutMs: 10000 }
  )
  return JSON.parse(result.stdout.toString())
}

// Adapted from the pinned MIT upstream's named workstation/home lifecycle. One in-process creator per agent.
export function ensureWorkstation(agentId: string): Promise<Workspace> {
  let job = pending.get(agentId)
  if (!job) {
    job = withWorkspaceOperation(agentId, () => prepareWorkstation(agentId)).finally(() =>
      pending.delete(agentId)
    )
    pending.set(agentId, job)
  }
  return job
}

async function prepareWorkstation(agentId: string): Promise<Workspace> {
  await assertWorkstationNetwork()
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))
  if (!agent) throw new Error("Agent not found")
  const name = workstationName(agentId)
  const connection: Connection = {
    token: randomBytes(32).toString("hex"),
    password: randomBytes(6).toString("base64"),
  }
  await db
    .insert(workstationControl)
    .values({
      agentId,
      containerName: name,
      connectionSecret: encryptSecret(JSON.stringify(connection)),
    })
    .onConflictDoNothing()
  let row = await workspaceRow(agentId)
  const existing = await inspect(name)
  if (!existing) {
    const image = await dockerRaw(["image", "inspect", env.WORKSTATION_IMAGE], {
      timeoutMs: 15000,
    })
    if (image.exitCode !== 0)
      throw new Error(
        `Workstation image missing. Run npm run workstation:build (${env.WORKSTATION_IMAGE})`
      )
    const secret = workspaceConnection(row)
    const labels = [
      "--label",
      `personal-agent.install=${env.INSTALL_ID}`,
      "--label",
      `personal-agent.agent=${agentId}`,
    ]
    await docker(["volume", "create", ...labels, workstationVolume(agentId)])
    await docker(["volume", "create", ...labels, displayVolume(agentId)])
    await docker(
      [
        "create",
        "--name",
        name,
        ...labels,
        "--label",
        "personal-agent.protocol=6",
        "--hostname",
        "workstation",
        "--env",
        "PA_WORKSPACE_TOKEN",
        "--env",
        "OWNDESK_VNC_PASSWORD",
        "--env",
        "OWNDESK_IDLE_MINUTES=0",
        "--volume",
        `${workstationVolume(agentId)}:/home/agent`,
        "--volume",
        `${displayVolume(agentId)}:/tmp/.X11-unix`,
        "--shm-size",
        "1g",
        "--cpus",
        String(env.WORKSTATION_CPUS),
        "--memory",
        `${env.WORKSTATION_MEMORY_MB}m`,
        ...(env.WORKSTATION_NETWORK
          ? [
              "--network",
              env.WORKSTATION_NETWORK,
              "--dns",
              env.PA_GUEST_DNS,
              "--cap-drop",
              "CAP_NET_RAW",
              "--sysctl",
              "net.ipv6.conf.all.disable_ipv6=1",
              "--sysctl",
              "net.ipv6.conf.default.disable_ipv6=1",
            ]
          : []),
        env.WORKSTATION_IMAGE,
      ],
      {
        env: { PA_WORKSPACE_TOKEN: secret.token, OWNDESK_VNC_PASSWORD: secret.password },
        timeoutMs: 60000,
      }
    )
  } else if (existing.Config.Labels["personal-agent.protocol"] !== "6") {
    throw new Error(
      "Workstation protocol differs; drain and upgrade this workstation before running tasks"
    )
  } else if (Object.keys(existing.HostConfig.PortBindings ?? {}).length) {
    throw new Error("Workstation has legacy published ports; drain and recreate it")
  } else if (
    env.NETWORK_GUARD_IMAGE &&
    (existing.HostConfig.NetworkMode !== env.WORKSTATION_NETWORK ||
      !existing.HostConfig.CapDrop?.includes("CAP_NET_RAW") ||
      existing.HostConfig.Sysctls?.["net.ipv6.conf.all.disable_ipv6"] !== "1" ||
      existing.HostConfig.Sysctls?.["net.ipv6.conf.default.disable_ipv6"] !== "1" ||
      existing.HostConfig.Dns?.length !== 1 ||
      existing.HostConfig.Dns[0] !== env.PA_GUEST_DNS)
  ) {
    throw new Error("Workstation network policy differs; drain and recreate it")
  }
  if (!existing?.State.Running) await docker(["start", name], { timeoutMs: 60000 })
  await docker(["exec", name, "owndesk-ready"], { timeoutMs: 45000 })
  const health = await workstationHealth(agentId)
  if (health.protocolVersion !== 6)
    throw new Error(
      "Workstation image protocol differs; drain and recreate it with the configured protocol-6 image"
    )
  await prepareViewer(agentId, row)
  // Active tasks reconcile their boot in acquireWorkspace; an idle desktop has no task claimant.
  if (
    health.bootId !== row.bootId &&
    row.mode === "idle" &&
    !row.activeTaskId &&
    !row.desiredMode
  ) {
    const epoch = row.epoch + 1
    await controller(agentId, "/control", { epoch, mode: "idle" })
    await db
      .update(workstationControl)
      .set({ bootId: health.bootId, epoch, updatedAt: new Date() })
      .where(eq(workstationControl.agentId, agentId))
    row = await workspaceRow(agentId)
  }
  await db
    .update(agents)
    .set({ workstationId: name, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
  return row
}

async function prepareViewer(agentId: string, row: Workspace) {
  const name = viewerName(agentId)
  const existing = await inspect(name)
  if (
    existing &&
    (Object.keys(existing.HostConfig.PortBindings ?? {}).length ||
      existing.HostConfig.NetworkMode !== "none")
  )
    throw new Error("Viewer has legacy networking; drain and recreate it")
  if (!existing) {
    const secret = workspaceConnection(row)
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `personal-agent.install=${env.INSTALL_ID}`,
        "--label",
        `personal-agent.agent=${agentId}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m",
        "--volume",
        `${displayVolume(agentId)}:/tmp/.X11-unix:ro`,
        "--env",
        "OWNDESK_VNC_PASSWORD",
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--memory",
        "256m",
        "--cpus",
        "0.5",
        "--network",
        "none",
        "--entrypoint",
        "/usr/bin/tini",
        env.WORKSTATION_IMAGE,
        "--",
        "/bin/bash",
        "/usr/local/bin/pa-viewer",
      ],
      { env: { OWNDESK_VNC_PASSWORD: secret.password }, timeoutMs: 45000 }
    )
  }
  if (!existing?.State.Running) await docker(["start", name], { timeoutMs: 45000 })
  await docker(
    [
      "exec",
      name,
      "sh",
      "-c",
      "for i in $(seq 50); do ss -Hltn '( sport = :5900 )' | grep -q . && exit 0; sleep 0.1; done; cat /tmp/viewer.log >&2; exit 1",
    ],
    { timeoutMs: 10000 }
  )
}

export async function acquireWorkspace(
  task: Pick<Task, "id" | "agentId" | "activeSegment">
): Promise<Workspace> {
  await ensureWorkstation(task.agentId)
  return withWorkspaceOperation(task.agentId, async () => {
    const health = await workstationHealth(task.agentId)
    const client = await pool.connect()
    let fence: number
    try {
      await client.query("BEGIN")
      const {
        rows: [state],
      } = await client.query<{
        cancel_requested_at: Date | null
        status: string
        agent_id: string
        active_segment: number
      }>(
        "SELECT cancel_requested_at,status,agent_id,active_segment FROM tasks WHERE id=$1 FOR UPDATE",
        [task.id]
      )
      if (state.cancel_requested_at || state.status === "cancelled")
        throw new TaskCancelled()
      if (state.agent_id !== task.agentId || state.active_segment !== task.activeSegment)
        throw new SegmentSuperseded()
      const {
        rows: [workspace],
      } = await client.query<{
        active_task_id: string | null
        mode: string
        epoch: number
        desired_mode: string | null
      }>(
        "SELECT active_task_id,mode,epoch,desired_mode FROM workstation_control WHERE agent_id=$1 FOR UPDATE",
        [task.agentId]
      )
      if (workspace.active_task_id && workspace.active_task_id !== task.id)
        throw new Error("Workspace is already held by a different task")
      if (["human", "quarantined"].includes(workspace.mode) || workspace.desired_mode)
        throw new WorkspacePaused()
      fence = Math.max(workspace.epoch, health.epoch) + 1
      await client.query(
        "UPDATE workstation_control SET active_task_id=$2,active_segment=$3,mode='quiescing',epoch=$4,updated_at=now() WHERE agent_id=$1",
        [task.agentId, task.id, task.activeSegment, fence]
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    const quiet = await quiesceWorkstation(task.agentId, fence, true)
    const current = await workspaceRow(task.agentId)
    if (current.desiredMode) throw new WorkspacePaused()
    const epoch = fence + 1
    await controller(task.agentId, "/control", { epoch, mode: "agent" })
    await db
      .update(workstationControl)
      .set({
        mode: "agent",
        epoch,
        bootId: quiet.bootId,
        activeActionId: null,
        updatedAt: new Date(),
      })
      .where(eq(workstationControl.agentId, task.agentId))
    await db
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
    return workspaceRow(task.agentId)
  })
}

export async function releaseWorkspace(taskId: string, agentId: string) {
  return withWorkspaceOperation(agentId, async () => {
    const row = await workspaceRow(agentId)
    if (row.activeTaskId !== taskId) throw new Error("Task does not own this workstation")
    if (row.desiredMode || ["human", "quarantined"].includes(row.mode))
      throw new WorkspacePaused()
    const epoch = row.epoch + 1
    await db
      .update(workstationControl)
      .set({ mode: "quiescing", epoch, updatedAt: new Date() })
      .where(eq(workstationControl.agentId, agentId))
    const quiet = await quiesceWorkstation(agentId, epoch, false)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const {
        rows: [task],
      } = await client.query<{ cancel_requested_at: Date | null }>(
        "SELECT cancel_requested_at FROM tasks WHERE id=$1 FOR UPDATE",
        [taskId]
      )
      const {
        rows: [current],
      } = await client.query<{ desired_mode: string | null }>(
        "SELECT desired_mode FROM workstation_control WHERE agent_id=$1 FOR UPDATE",
        [agentId]
      )
      if (task.cancel_requested_at) throw new TaskCancelled()
      if (current.desired_mode) throw new WorkspacePaused()
      if (!quiet.coldReset)
        await controller(agentId, "/control", { epoch: epoch + 1, mode: "idle" })
      await client.query(
        `UPDATE workstation_control SET mode='idle',epoch=$2,boot_id=$3,
        active_task_id=NULL,active_segment=NULL,active_action_id=NULL,updated_at=now() WHERE agent_id=$1`,
        [agentId, epoch + 1, quiet.bootId]
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

export class TaskCancelled extends Error {
  constructor() {
    super("Task was cancelled")
  }
}
export class SegmentSuperseded extends Error {
  constructor() {
    super("A later task segment owns execution")
  }
}
export class WorkspacePaused extends Error {
  constructor() {
    super("Workspace is paused for its owner")
  }
}

export async function assertAgentControl(
  taskId: string,
  agentId: string,
  segmentNo?: number
): Promise<Workspace> {
  const {
    rows: [task],
  } = await pool.query<{
    cancel_requested_at: Date | null
    status: string
    agent_id: string
    active_segment: number
  }>("SELECT cancel_requested_at,status,agent_id,active_segment FROM tasks WHERE id=$1", [
    taskId,
  ])
  if (task.cancel_requested_at || task.status === "cancelled") throw new TaskCancelled()
  if (
    task.agent_id !== agentId ||
    (segmentNo !== undefined && task.active_segment !== segmentNo)
  )
    throw new SegmentSuperseded()
  if (["waiting_user", "needs_review"].includes(task.status)) throw new WorkspacePaused()
  if (task.status !== "running")
    throw new Error(`Task cannot dispatch an action from ${task.status}`)
  const row = await workspaceRow(agentId)
  if (row.activeTaskId !== taskId || row.mode !== "agent" || row.desiredMode)
    throw new WorkspacePaused()
  const health = await workstationHealth(agentId)
  if (
    health.bootId !== row.bootId ||
    health.epoch !== row.epoch ||
    health.mode !== "agent"
  )
    throw new Error(
      "Workstation controller changed; reconcile it before dispatching another action"
    )
  return row
}

// Returns only after real input has stopped. Shell requires a complete container boundary.
export async function quiesceWorkstation(
  agentId: string,
  epoch: number,
  restart: boolean,
  forceCold = false
): Promise<{ bootId: string; coldReset: boolean }> {
  const row = await workspaceRow(agentId)
  if (forceCold || !(await inspect(row.containerName))?.State.Running) {
    await stopWorkstationBoundary(agentId)
    if (!restart) return { bootId: row.bootId!, coldReset: true }
    await prepareWorkstation(agentId)
    return { bootId: (await workstationHealth(agentId)).bootId, coldReset: true }
  }
  const health = await controller<WorkspaceHealth>(agentId, "/quiesce", { epoch })
  const shell = await pool.query(
    "SELECT 1 FROM task_actions a JOIN tasks t ON t.id=a.task_id WHERE t.agent_id=$1 AND a.kind='shell' AND a.boot_id=$2 LIMIT 1",
    [agentId, row.bootId]
  )
  if (forceCold || health.shellUsed || shell.rowCount) {
    await stopWorkstationBoundary(agentId)
    if (!restart) return { bootId: health.bootId, coldReset: true }
    await prepareWorkstation(agentId)
    return { bootId: (await workstationHealth(agentId)).bootId, coldReset: true }
  }
  const deadline = Date.now() + 35000
  while (Date.now() < deadline) {
    const current = await workstationHealth(agentId)
    if (current.active === 0) {
      await confirmManualInputStopped(agentId)
      return { bootId: current.bootId, coldReset: false }
    }
    await delay(100)
  }
  await stopWorkstationBoundary(agentId)
  throw new Error(
    "An in-flight browser action did not quiesce; workstation stopped for review"
  )
}

export async function openDesktopStream(agentId: string, mode: "watch" | "control") {
  const row = await workspaceRow(agentId)
  const port = mode === "watch" ? 5900 : 5901
  const name = mode === "watch" ? viewerName(agentId) : row.containerName
  let found = await inspect(name)
  if (
    !found?.State.Running &&
    row.mode !== "quarantined" &&
    (mode === "watch" || (row.mode === "idle" && !row.activeTaskId))
  ) {
    await ensureWorkstation(agentId)
    found = await inspect(name)
  }
  if (!found?.State.Running) throw new Error("Workstation is not running")
  return dockerStream([
    "exec",
    "-i",
    name,
    "node",
    "-e",
    `const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1');
process.stdin.pipe(socket); socket.pipe(process.stdout);
process.stdin.on('end', () => socket.destroy());
socket.on('error', () => { console.error('Desktop loopback relay failed'); process.exit(1); });
socket.on('close', () => process.exit(0));`,
    String(port),
  ])
}

export async function confirmManualInputStopped(agentId: string) {
  const row = await workspaceRow(agentId)
  const deadline = Date.now() + 5000
  while (true) {
    const result = await docker(
      [
        "exec",
        row.containerName,
        "ss",
        "-Htn",
        "state",
        "established",
        "( sport = :5901 )",
      ],
      { timeoutMs: 5000 }
    )
    if (!result.stdout.toString().trim()) break
    if (Date.now() >= deadline) throw new Error("A manual VNC connection is still active")
    await delay(100)
  }
  // Release held keys/buttons after the control sockets close, before another agent epoch begins.
  await docker(["exec", "-i", row.containerName, "python3", "-"], {
    timeoutMs: 5000,
    input: `
import ctypes
x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[ctypes.c_char_p]; x.XOpenDisplay.restype=ctypes.c_void_p
x.XQueryKeymap.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
x.XSync.argtypes=[ctypes.c_void_p,ctypes.c_int]; x.XCloseDisplay.argtypes=[ctypes.c_void_p]
t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('Display is unavailable for input release')
keys=(ctypes.c_ubyte*32)(); x.XQueryKeymap(d,keys)
for code in range(8,256):
 if keys[code//8] & (1 << (code%8)): t.XTestFakeKeyEvent(d,code,0,0)
for button in range(1,6): t.XTestFakeButtonEvent(d,button,0,0)
x.XSync(d,0); x.XCloseDisplay(d)
`,
  })
}

// The host's container lifecycle remains available when the guest controller is unresponsive.
export async function stopWorkstationBoundary(agentId: string) {
  for (const name of [viewerName(agentId), workstationName(agentId)]) {
    const current = await inspect(name)
    if (!current) continue
    if (current.State.Running)
      await docker(["stop", "--time", "5", name], { timeoutMs: 15000 })
    if ((await inspect(name))?.State.Running)
      throw new Error(`Container boundary ${name} is still running`)
    if (name === workstationName(agentId))
      await docker(["rm", name], { timeoutMs: 15000 })
  }
}

export async function stopInstallationWorkstations() {
  const running = await docker([
    "ps",
    "--filter",
    `label=personal-agent.install=${env.INSTALL_ID}`,
    "--format",
    "{{.Names}}",
  ])
  const names = running.stdout.toString().trim().split("\n").filter(Boolean)
  if (names.length) await docker(["stop", "--time", "5", ...names], { timeoutMs: 20000 })
  const remaining = await docker([
    "ps",
    "--filter",
    `label=personal-agent.install=${env.INSTALL_ID}`,
    "--format",
    "{{.Names}}",
  ])
  if (remaining.stdout.toString().trim())
    throw new Error(
      "Emergency stop could not confirm all installation workstations stopped"
    )
}

// Adapted from the pinned MIT upstream's idle-stop/home-preserving lifecycle. The trusted worker
// owns the timer; the guest cannot decide whether a durable task is still active.
export async function sweepIdleWorkstations(): Promise<string[]> {
  if (env.WORKSTATION_IDLE_MINUTES === 0) return []
  const cutoff = new Date(Date.now() - env.WORKSTATION_IDLE_MINUTES * 60000)
  const { rows } = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM workstation_control WHERE mode='idle'
      AND active_task_id IS NULL AND desired_mode IS NULL AND updated_at<$1`,
    [cutoff]
  )
  const stopped: string[] = []
  for (const { agent_id: agentId } of rows) {
    await withWorkspaceOperation(agentId, async () => {
      const current = await workspaceRow(agentId)
      if (
        current.mode !== "idle" ||
        current.activeTaskId ||
        current.desiredMode ||
        current.updatedAt >= cutoff
      )
        return
      // A submitted task exists before ensure/acquire starts. Rechecking here
      // protects their preparation gap as well as queued work and human waits.
      const pending = await pool.query(
        "SELECT 1 FROM tasks WHERE agent_id=$1 AND status NOT IN ('completed','failed','cancelled') LIMIT 1",
        [agentId]
      )
      if (pending.rowCount) return
      const names = [viewerName(agentId), workstationName(agentId)]
      const instances = await Promise.all(names.map(inspect))
      if (!instances.some((instance) => instance?.State.Running)) return
      for (const [index, name] of names.entries()) {
        if (!instances[index]?.State.Running) continue
        await docker(["stop", "--time", "10", name], { timeoutMs: 20000 })
        if ((await inspect(name))?.State.Running)
          throw new Error(`Idle workstation ${name} is still running`)
      }
      await pool.query(
        `UPDATE workstation_control SET epoch=epoch+1,boot_id=NULL,
          active_action_id=NULL,updated_at=now() WHERE agent_id=$1`,
        [agentId]
      )
      stopped.push(agentId)
    })
  }
  return stopped
}
