import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

const recoveryTail = process.argv.includes("--recovery-tail")
const cancelTail = process.argv.includes("--cancel-tail")
assert(!(recoveryTail && cancelTail))
process.loadEnvFile(".env")
const database = `agent_native_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
await admin.connect()
const mainBefore = (
  await admin.query(
    "SELECT (SELECT count(*)::int FROM tasks) tasks,(SELECT count(*)::int FROM task_actions) actions,(SELECT count(*)::int FROM task_model_attempts) attempts"
  )
).rows[0]
await admin.query(`CREATE DATABASE "${database}"`)
await admin.end()
const url = new URL(process.env.DATABASE_URL!)
url.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  INSTALL_ID: randomUUID(),
  MASTER_KEY: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomUUID(),
  APP_URL: "http://127.0.0.1:17437",
  WORKER_HOST: "127.0.0.1",
  WORKER_PORT: "17438",
  WORKSTATION_IMAGE: process.env.ATSPI_TEST_IMAGE ?? "owndesk-workstation:0.6.5-atspi",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "native-test@example.test",
  OWNER_PASSWORD: randomUUID(),
})
const jobs: { child: ChildProcess; done: Promise<number | null> }[] = []
const workerContainers: string[] = []
function start(script: string, name: string) {
  const image = script === "worker/main.ts" ? process.env.ATSPI_WORKER_IMAGE : undefined
  const container = `pa-${database}-${name}`
  const keys = [
    "DATABASE_URL",
    "INSTALL_ID",
    "MASTER_KEY",
    "BETTER_AUTH_SECRET",
    "APP_URL",
    "WORKER_HOST",
    "WORKER_PORT",
    "WORKSTATION_IMAGE",
    "WORKSTATION_MEMORY_MB",
    "WORKSTATION_IDLE_MINUTES",
    "WORKSTATION_NETWORK",
    "NETWORK_GUARD_IMAGE",
    "PA_GUEST_DNS",
  ]
  const args = image
    ? [
        "run",
        "--rm",
        "--name",
        container,
        "--network",
        "host",
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
        ...keys
          .filter((key) => process.env[key] !== undefined)
          .flatMap((key) => ["--env", key]),
        "--env",
        "DOCKER_HOST=unix:///var/run/docker.sock",
        "--env",
        "ARTIFACT_DIR=/app/data/artifacts",
        image,
      ]
    : ["--import", "tsx", script]
  if (image) workerContainers.push(container)
  const child = spawn(image ? "docker" : process.execPath, args, {
    env: process.env,
    detached: true,
  })
  let log = ""
  child.stdout!.on("data", (b) => (log += b))
  child.stderr!.on("data", (b) => (log += b))
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), log)
    return child.exitCode
  })
  const job = { child, done }
  jobs.push(job)
  return job
}
async function until<T>(read: () => Promise<T | undefined>, label: string) {
  const end = Date.now() + 180000
  while (Date.now() < end) {
    const r = await read()
    if (r !== undefined) return r
    await delay(150)
  }
  throw new Error(`Timed out ${label}`)
}
let steps = 0,
  summaries = 0,
  passed = false,
  failure: string | undefined,
  taskId: string | undefined,
  windowId: string | undefined
const errors: string[] = [],
  checks: string[] = [],
  requests: any[] = []
const model = createServer((req, res) => {
  void (async () => {
    assert.equal(req.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const serialized = JSON.stringify(body)
    assert(!serialized.includes("PA_WORKSPACE_TOKEN"))
    if (!body.tools) {
      summaries++
      assert(serialized.includes("Summarize the supplied historical agent transcript"))
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: `native-summary-${summaries}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "native-fixture",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content:
                  "Goal and constraints: navigate Thunar to /tmp with native GUI. Confirmed actions and results: observations were collected; the desktop was cold recreated after owner question. Unknown effects and failures: none in this local fixed-response path. Files and resource references: /tmp. Latest memory changes: none. Decisions and remaining steps: acquire fresh window controls, focus location, set /tmp and inspect the resulting state; old observations never authorize input.",
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
        })
      )
      return
    }
    const names = body.tools.map((t: any) => t.function.name)
    for (const name of [
      "desktop_list_windows",
      "desktop_get_window_state",
      "desktop_element_action",
      "desktop_ax_action",
      "desktop_type",
      "desktop_tag_context",
      "desktop_tag_replace",
      "desktop_tag_release",
    ])
      assert(names.includes(name), `Missing model tool ${name}`)
    const previous = body.messages.filter((m: any) => m.role === "tool").at(-1)
    const decoded = previous ? JSON.parse(previous.content) : undefined
    const output = Array.isArray(decoded)
      ? JSON.parse(
          decoded.find((p: any) => p.type === "text" && p.text.startsWith("{")).text
        )
      : decoded
    const step = steps++
    requests.push({
      step,
      toolResultName: previous?.name,
      output,
      images: (serialized.match(/data:image\/jpeg;base64,/g) ?? []).length,
    })
    let tool: string, args: Record<string, unknown>
    if (step === 0) {
      tool = "desktop_open_application"
      args = { application: "Thunar" }
    } else if (step === 1) {
      tool = "desktop_list_windows"
      args = {}
    } else if (step === 2) {
      windowId = output.windows.find((w: any) => w.name?.includes("Thunar")).window_id
      assert(windowId)
      tool = "desktop_get_window_state"
      args = { window_id: windowId, max_depth: 12, max_nodes: 500 }
    } else if (step === 3 && cancelTail) {
      const location = output.elements.find(
        (e: any) => e.states?.includes("editable") && e.text === "/home/agent/"
      )
      assert(location)
      tool = "desktop_element_action"
      args = {
        observationId: output.observationId,
        element_index: location.element_index,
        operation: "focus",
        dispatch: "foreground",
      }
    } else if (step === 4 && cancelTail) {
      assert.equal(output.focus_verified, true)
      tool = "ask_user"
      args = { question: "本机固定响应取消尾段：已完成原生焦点操作，等待取消。" }
    } else if (step === 3 && recoveryTail) {
      assert(output.tree && output.elements?.length && output.observationId)
      tool = "ask_user"
      args = { question: "本机固定响应恢复尾段：确认冷重建后重新发现窗口。" }
    } else if (step === 4 && recoveryTail) {
      tool = "desktop_open_application"
      args = { application: "Thunar" }
    } else if (step === 5 && recoveryTail) {
      tool = "desktop_list_windows"
      args = {}
    } else if (step === 6 && recoveryTail) {
      const fresh = output.windows.find((w: any) => w.name?.includes("Thunar"))
      assert(fresh)
      windowId = fresh.window_id
      tool = "desktop_get_window_state"
      args = { window_id: windowId, max_depth: 12, max_nodes: 500 }
    } else if (step === 7 && recoveryTail) {
      const location = output.elements.find(
        (e: any) => e.states?.includes("editable") && e.text === "/home/agent/"
      )
      assert(location)
      tool = "desktop_element_action"
      args = {
        observationId: output.observationId,
        element_index: location.element_index,
        operation: "focus",
        dispatch: "foreground",
      }
    } else if (step === 8 && recoveryTail) {
      assert.equal(output.focus_verified, true)
      const location = output.elements.find(
        (e: any) => e.states?.includes("editable") && e.text === "/home/agent/"
      )
      assert(location)
      tool = "desktop_ax_action"
      args = {
        observationId: output.observationId,
        path: location.path,
        operation: "set_value",
        value: "/tmp",
        submit: true,
        dispatch: "foreground",
      }
    } else if (step === 9 && recoveryTail) {
      assert.equal(output.effect, "dispatched")
      tool = "desktop_get_window_state"
      args = { window_id: windowId, max_depth: 12, max_nodes: 500 }
    } else if (step === 10 && recoveryTail) {
      assert(output.window.title.includes("tmp - Thunar"))
      assert(output.elements.some((e: any) => e.text === "/tmp/"))
      tool = "complete_task"
      args = { summary: "冷重建后已重新发现原生窗口，完成 /tmp 导航。", files: [] }
    } else if (step === 3) {
      assert(output.tree && output.elements?.length && output.observationId)
      const home = output.elements.find((e: any) => e.name === "Home")
      assert(home)
      tool = "desktop_element_action"
      args = {
        observationId: output.observationId,
        window_id: windowId,
        element_index: home.element_index,
      }
    } else if (step === 4) {
      assert.equal(output.effect, "dispatched")
      tool = "ask_user"
      args = { question: "本机固定响应验收：确认恢复后继续原生操作。" }
    } else if (step === 5) {
      tool = "desktop_get_window_state"
      args = { window_id: windowId, max_depth: 12, max_nodes: 500 }
    } else if (step === 6) {
      const location = output.elements.find(
        (e: any) => e.states?.includes("editable") && e.text === "/home/agent/"
      )
      assert(location, JSON.stringify(output))
      tool = "desktop_element_action"
      args = {
        observationId: output.observationId,
        element_index: location.element_index,
        operation: "focus",
        dispatch: "foreground",
      }
    } else if (step === 7) {
      assert.equal(output.focus_verified, true)
      const location = output.elements.find(
        (e: any) => e.states?.includes("editable") && e.text === "/home/agent/"
      )
      assert(location)
      tool = "desktop_ax_action"
      args = {
        observationId: output.observationId,
        path: location.path,
        operation: "set_value",
        value: "/tmp",
        submit: true,
        dispatch: "foreground",
      }
    } else if (step === 8) {
      assert.equal(output.effect, "dispatched")
      tool = "desktop_get_window_state"
      args = { window_id: windowId, max_depth: 12, max_nodes: 500 }
    } else {
      assert.equal(step, 9)
      assert(output.window.title.includes("tmp - Thunar"))
      assert(output.elements.some((e: any) => e.text === "/tmp/"))
      tool = "complete_task"
      args = {
        summary: "原生操作及恢复后已导航到 /tmp，核对当前原生状态和截图。",
        files: [],
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `native-${step}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "native-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `native-call-${step}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      })
    )
  })().catch((error) => {
    errors.push(String(error))
    res.writeHead(500).end(JSON.stringify({ error: String(error) }))
  })
})
model.listen(0, "127.0.0.1")
await once(model, "listening")
try {
  assert.equal(await start("scripts/migrate.ts", "migrate").done, 0)
  assert.equal(await start("scripts/owner.ts", "owner").done, 0)
  const { pool } = await import("@/db")
  const { setSetting } = await import("@/lib/config")
  await setSetting("provider.custom.apiKey", "local-fixed-no-cloud")
  await setSetting(
    "provider.custom.baseUrl",
    `http://${process.env.ATSPI_MODEL_HOST ?? "127.0.0.1"}:${(model.address() as { port: number }).port}/v1`
  )
  await setSetting("model.default", "custom/native-fixture")
  const ownerId = (await pool.query("SELECT user_id FROM owners")).rows[0].user_id
  const agentId = (await pool.query("SELECT id FROM agents LIMIT 1")).rows[0].id
  const { submitTask } = await import("@/lib/tasks")
  let worker = start("worker/main.ts", "worker-1")
  taskId = (
    await submitTask(ownerId, "atspi-runtime", {
      agentId,
      goal: "本机固定响应原生操作测试：打开 Thunar，用原生控件导航到 /tmp。",
      clientRequestId: randomUUID(),
      workstationChannel: "desktop",
      completionContract: { requireHumanReview: false },
      budget: { maxSteps: 30 },
    })
  ).taskId
  const pending = await until(async () => {
    const task = (
      await pool.query("SELECT status,error FROM tasks WHERE id=$1", [taskId])
    ).rows[0]
    if (["failed", "needs_review"].includes(task.status))
      throw new Error(JSON.stringify(task))
    return (
      await pool.query(
        "SELECT id,payload_version FROM task_requests WHERE task_id=$1 AND status='pending'",
        [taskId]
      )
    ).rows[0]
  }, "native recovery checkpoint")
  checks.push(
    cancelTail
      ? "production native focus result reaches the actual local model before the cancellation checkpoint"
      : recoveryTail
        ? "production native observations enter actual local model requests before a real worker restart"
        : "production Task/DBOS/action chain passes native observations and successful native press into actual local model requests"
  )
  const before = (
    await pool.query(
      "SELECT action_no,kind,receipt FROM task_actions WHERE task_id=$1 AND status='succeeded' ORDER BY action_no",
      [taskId]
    )
  ).rows
  if (cancelTail) {
    const { requestCancellation } = await import("@/lib/task-control")
    await requestCancellation(ownerId, taskId)
  } else {
    worker.child.kill("SIGTERM")
    assert.equal(await worker.done, 0)
    worker = start("worker/main.ts", "worker-2")
    const { respondToRequest } = await import("@/lib/task-control")
    await respondToRequest(ownerId, pending.id, "approve", pending.payload_version, {
      note: "继续",
    })
  }
  await until(async () => {
    const row = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
    ).rows[0]
    if (["failed", "needs_review"].includes(row.status))
      throw new Error(JSON.stringify(row))
    return row.status === (cancelTail ? "cancelled" : "completed") ? row : undefined
  }, "native task completion")
  const after = (
    await pool.query(
      "SELECT action_no,kind,receipt FROM task_actions WHERE task_id=$1 AND status='succeeded' ORDER BY action_no",
      [taskId]
    )
  ).rows
  for (const original of before)
    assert.deepEqual(
      after.find((a: any) => a.action_no === original.action_no),
      original
    )
  assert.equal(
    after.filter((a: any) => a.kind === "desktop_element_action").length,
    recoveryTail || cancelTail ? 1 : 2
  )
  assert.equal(steps, cancelTail ? 5 : recoveryTail ? 11 : 10)
  assert.deepEqual(errors, [])
  assert(requests.every((r) => r.images <= 2))
  await writeFile(path.join(directory, "actions.json"), JSON.stringify(after, null, 2))
  checks.push(
    cancelTail
      ? "owner cancellation finishes through the original worker control chain and preserves the successful native receipt without replay"
      : "real worker restart preserves original receipts; native focus/set_value submit use the original action chain and finish in /tmp"
  )
  if (cancelTail) {
    const control = (
      await pool.query(
        "SELECT active_task_id,desired_mode FROM workstation_control WHERE agent_id=$1",
        [agentId]
      )
    ).rows[0]
    assert.equal(control.active_task_id, null)
    assert.equal(control.desired_mode, null)
    const { dockerRaw } = await import("@/lib/docker")
    const { workstationName } = await import("@/lib/workstation")
    const status = await dockerRaw([
      "inspect",
      "--format",
      "{{.State.Running}}",
      workstationName(agentId),
    ])
    assert(status.exitCode !== 0 || status.stdout.toString().trim() === "false")
    checks.push(
      "cancelled native Task releases workstation ownership and the actual desktop container boundary"
    )
  }
  checks.push(
    "actual model requests keep native element data and at most two current images"
  )
  passed = true
} catch (error) {
  failure = (error as Error).stack
  throw error
} finally {
  for (const job of jobs)
    if (job.child.exitCode === null && job.child.signalCode === null)
      job.child.kill("SIGTERM")
  await Promise.race([Promise.all(jobs.map((j) => j.done)), delay(15000)])
  for (const job of jobs)
    if (job.child.exitCode === null && job.child.signalCode === null)
      process.kill(-job.child.pid!, "SIGKILL")
  const { docker } = await import("@/lib/docker")
  for (const name of workerContainers) {
    const existing = await docker([
      "ps",
      "-a",
      "--filter",
      `name=^${name}$`,
      "--format",
      "{{.Names}}",
    ])
    if (existing.stdout.toString().trim() === name) await docker(["rm", "--force", name])
  }
  await new Promise<void>((resolve) => model.close(() => resolve()))
  const { stopInstallationWorkstations } = await import("@/lib/workstation")
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const { pool } = await import("@/db")
  await pool.end()
  await writeFile(
    path.join(directory, "requests.json"),
    JSON.stringify(requests, null, 2)
  )
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        passed,
        database,
        directory,
        taskId,
        steps,
        summaries,
        checks,
        errors,
        failure,
        mainBefore,
        workerImage: process.env.ATSPI_WORKER_IMAGE ?? "host-source",
        workstationImage: process.env.WORKSTATION_IMAGE,
        cloudCalls: 0,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ passed, directory, steps, checks, failure }))
}
