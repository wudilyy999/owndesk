import { spawn } from "node:child_process"
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"

const groups = new Map()
export let shellUsed = false

function alive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

export async function stopProcessGroups() {
  for (const pgid of groups.keys()) if (alive(pgid)) process.kill(-pgid, "SIGTERM")
  await delay(150)
  for (const pgid of groups.keys()) if (alive(pgid)) process.kill(-pgid, "SIGKILL")
  // The worker performs a container stop when Shell was used: setsid/env-cleared children
  // are outside this process-group guarantee and must not survive cancellation.
}

export async function runProcess(
  program,
  args,
  { actionId, input, cwd, timeoutMs = 30000, shell = false, maxOutputBytes = 20000 } = {}
) {
  if (shell) shellUsed = true
  await mkdir("/tmp/personal-agent-processes", { recursive: true })
  const output = path.join("/tmp/personal-agent-processes", encodeURIComponent(actionId))
  const fd = await open(output, "w", 0o600)
  let child,
    result,
    timer,
    timedOut = false
  try {
    child = spawn(program, args, {
      cwd,
      detached: true,
      env: { ...process.env, PA_ACTION_ID: actionId },
      stdio: [input === undefined ? "ignore" : "pipe", fd.fd, fd.fd],
    })
    // Register listeners before yielding: ENOENT may be emitted before an async fd.close completes.
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
    })
    if (input !== undefined) child.stdin.end(input)
    if (child.pid) groups.set(child.pid, actionId)
    timer = setTimeout(() => {
      timedOut = true
      if (child.pid && alive(child.pid)) process.kill(-child.pid, "SIGKILL")
    }, timeoutMs)
    result = await completion
  } finally {
    clearTimeout(timer)
    await fd.close()
    if (child?.pid && !alive(child.pid)) groups.delete(child.pid)
  }
  const bytes = (await stat(output)).size
  const file = await open(output, "r")
  let content
  try {
    if (bytes <= maxOutputBytes) content = (await file.readFile()).toString("utf8")
    else {
      const half = Math.floor(maxOutputBytes / 2)
      const head = Buffer.alloc(half),
        tail = Buffer.alloc(half)
      await file.read(head, 0, half, 0)
      await file.read(tail, 0, half, bytes - half)
      content = `${head.toString()}\n… ${bytes - 2 * half} bytes omitted …\n${tail.toString()}`
    }
  } finally {
    await file.close()
  }
  return {
    ...result,
    output: content,
    bytes,
    timedOut,
    backgroundActive: !!child.pid && alive(child.pid),
  }
}
