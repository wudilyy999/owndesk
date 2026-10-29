import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Task } from "@/db/schema"
import {
  allowedPluginCall,
  type AgentZeroPluginPackage,
  type AgentZeroPluginReference,
} from "@/lib/agent-zero"
import { loadAgentZeroPackage } from "@/lib/agent-zero-plugins"
import { docker } from "@/lib/docker"
import { assertAgentControl, controller, workspaceRow } from "@/lib/workstation"
import { executeAction, requestReview } from "./actions"

// This fixed bootstrap only copies the pinned package. It never imports plugin code.
export const prepareAgentZeroSource = `import base64,json,pathlib,sys
p=json.load(sys.stdin)
r=pathlib.Path(p["root"])
r.mkdir(parents=True,exist_ok=True)
r=r.resolve()
for name,value in p["files"].items():
 t=(r/name).resolve()
 if not t.is_relative_to(r): raise ValueError("Plugin path escaped its package")
 t.parent.mkdir(parents=True,exist_ok=True)
 tmp=t.with_name(t.name+".pa-copy")
 tmp.write_bytes(base64.b64decode(value,validate=True))
 tmp.replace(t)
(r/".pa-bridge.py").write_text(p["bridge"],encoding="utf-8")
`

export const agentZeroRoot = (id: string, commit: string) =>
  `/home/agent/.local/share/personal-agent/agent-zero/${id}/${commit}`

export function agentZeroShellInput(
  reference: AgentZeroPluginReference,
  raw: unknown,
  task: Pick<Task, "id" | "configSnapshot">
) {
  const { call } = allowedPluginCall([reference], raw)
  const request = JSON.stringify({
    ...call,
    config: reference.config,
    context_id: task.id,
    agent_name: task.configSnapshot.name ?? "OwnDesk",
  })
  if (Buffer.byteLength(request) > 60000)
    throw new Error("Plugin tool arguments exceed 60 KiB")
  return {
    command: `python3 '${agentZeroRoot(reference.id, reference.commit)}/.pa-bridge.py' <<'PA_PLUGIN_REQUEST'\n${request}\nPA_PLUGIN_REQUEST`,
    cwd: "/home/agent",
    timeout: 120,
  }
}

export async function prepareAgentZeroPackage(
  container: string,
  pkg: AgentZeroPluginPackage
) {
  const bridge = await readFile(path.resolve("scripts/agent-zero-bridge.py"), "utf8")
  await docker(["exec", "-i", container, "python3", "-c", prepareAgentZeroSource], {
    input: JSON.stringify({
      root: agentZeroRoot(pkg.id, pkg.commit),
      files: pkg.files,
      bridge,
    }),
    timeoutMs: 30000,
  })
}

export async function executeAgentZeroTool(
  task: Task,
  segmentNo: number,
  actionNo: number,
  raw: unknown,
  epoch: number
) {
  let reference, call
  try {
    ;({ reference, call } = allowedPluginCall(
      task.configSnapshot.agentZeroPlugins ?? [],
      raw
    ))
  } catch (error) {
    return { ok: false, output: { error: (error as Error).message } }
  }
  const input = agentZeroShellInput(reference, call, task)
  const result = await executeAction(
    task.id,
    segmentNo,
    actionNo,
    "shell",
    input,
    epoch,
    async () => {
      const workspace = await assertAgentControl(task.id, task.agentId)
      if (workspace.epoch !== epoch)
        return { rejected: "Control changed before plugin preparation" }
      const pkg = await loadAgentZeroPackage(reference.id, reference.commit)
      const row = await workspaceRow(task.agentId)
      await prepareAgentZeroPackage(row.containerName, pkg)
      const current = await assertAgentControl(task.id, task.agentId)
      return current.epoch === epoch
        ? { authorized: true }
        : { rejected: "Control changed during plugin preparation" }
    }
  )
  if (!result.ok || result.needsReview || result.stale) return result
  const output = String(result.output.output ?? "")
  if (result.output.exitCode !== 0)
    return requestReview(
      task.id,
      segmentNo,
      actionNo,
      task.agentId,
      "shell",
      `Plugin ${reference.id}/${call.tool} exited without a confirmed result; inspect its effects before continuing.`,
      { exitCode: result.output.exitCode, output }
    )
  const current = await assertAgentControl(task.id, task.agentId)
  const file = await controller<{ content: string; truncated: boolean }>(
    task.agentId,
    "/fs_read",
    {
      epoch: current.epoch,
      path: `${agentZeroRoot(reference.id, reference.commit)}/.pa-results/${task.id}-s${segmentNo}-a${actionNo}.json`,
    }
  )
  if (file.truncated)
    return {
      ok: false,
      output: {
        error:
          "Plugin result exceeds the 1 MiB read limit; read the saved result file in smaller parts.",
        ...result.output,
      },
    }
  const receipt = z
    .object({
      message: z.string(),
      breakLoopRequested: z.boolean(),
      additional: z.unknown(),
    })
    .parse(JSON.parse(file.content))
  return { ok: true, output: { plugin: reference.id, tool: call.tool, ...receipt } }
}
