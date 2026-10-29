import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"

// One isolated production-runtime Task, original public plugin sources, local fixed model.
// No real provider key is read or model API called. Retain the database and failure logs.
process.loadEnvFile(".env")
const database = `agent_a0_${randomUUID().replaceAll("-", "")}`
const directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const databaseUrl = new URL(process.env.DATABASE_URL!)
const admin = new pg.Client({ connectionString: databaseUrl.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
await admin.end()
databaseUrl.pathname = `/${database}`
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(),
  INSTALL_ID: randomUUID(),
  MASTER_KEY: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomUUID(),
  APP_URL: "http://127.0.0.1:17207",
  WORKER_PORT: "17208",
  WORKER_HOST: "127.0.0.1",
  WORKSTATION_IMAGE: "owndesk-workstation:0.6.2",
  WORKSTATION_MEMORY_MB: "2048",
  WORKSTATION_IDLE_MINUTES: "0",
  ARTIFACT_DIR: path.join(directory, "artifacts"),
  OWNER_EMAIL: "plugin-test@example.test",
  OWNER_PASSWORD: randomUUID(),
})
const jobs: { child: ChildProcess; done: Promise<unknown> }[] = []
function start(args: string[], name: string) {
  const child = spawn(process.execPath, args, { env: process.env, detached: true })
  let output = ""
  child.stdout!.on("data", (part) => {
    output += part
  })
  child.stderr!.on("data", (part) => {
    output += part
  })
  const done = once(child, "exit").then(async () => {
    await writeFile(path.join(directory, `${name}.log`), output)
    return child.exitCode
  })
  const job = { child, done }
  jobs.push(job)
  return job
}
async function until<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const end = Date.now() + 240000
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined) return value
    await delay(200)
  }
  throw new Error(`Timed out: ${message}`)
}
const modelErrors: string[] = []
let modelCalls = 0
let taskId: string | undefined
let passed = false
let failure: string | undefined
let replayVerified = false
let createdTodoId: string | undefined
const checks: string[] = []
const model = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    assert(body.tools.some((tool: any) => tool.function.name === "agent_zero_call"))
    const previous = body.messages
      .filter((message: any) => message.role === "tool")
      .at(-1)
    const output = previous ? JSON.parse(previous.content) : undefined
    const step = modelCalls++
    let tool: string, args: Record<string, unknown>
    if (step === 0) {
      tool = "shell"
      args = {
        command:
          "sudo apt-get update -qq && sudo apt-get install -y ripgrep tree && mkdir -p /home/agent/plugin-demo && printf 'needle community plugin\\n' > /home/agent/plugin-demo/example.txt",
        timeout: 180,
      }
    } else if (step === 1) {
      assert.equal(output.exitCode, 0, previous.content)
      tool = "agent_zero_call"
      args = {
        plugin: "rg",
        tool: "rg",
        args: { pattern: "needle", path: "/home/agent/plugin-demo" },
      }
    } else if (step === 2) {
      assert.equal(output.ok, true, previous.content)
      assert(output.message.includes("needle community plugin"))
      tool = "agent_zero_call"
      args = {
        plugin: "todo_list",
        tool: "todo_create_task",
        args: { title: "Community compatibility check", priority: "high" },
      }
    } else if (step === 3) {
      assert.equal(JSON.parse(output.message).task.title, "Community compatibility check")
      createdTodoId = JSON.parse(output.message).task.id
      tool = "agent_zero_call"
      args = {
        plugin: "todo_list",
        tool: "todo_get_tasks",
        args: { search: "Community compatibility check" },
      }
    } else {
      assert.equal(step, 4)
      assert.equal(JSON.parse(output.message).count, 1)
      const { pool, db } = await import("@/db")
      const { tasks } = await import("@/db/schema")
      const { eq } = await import("drizzle-orm")
      const { executeAgentZeroTool } = await import("@/worker/agent-zero")
      const { workspaceRow } = await import("@/lib/workstation")
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId!))
      const action = (
        await pool.query(
          "SELECT action_no FROM task_actions WHERE task_id=$1 AND input->>'command' LIKE '%todo_create_task%'",
          [taskId]
        )
      ).rows[0]
      const again = await executeAgentZeroTool(
        task,
        1,
        action.action_no,
        {
          plugin: "todo_list",
          tool: "todo_create_task",
          args: { title: "Community compatibility check", priority: "high" },
        },
        (await workspaceRow(task.agentId)).epoch
      )
      assert.equal(again.ok, true)
      assert.equal(JSON.parse(String(again.output.message)).task.id, createdTodoId)
      replayVerified = true
      tool = "complete_task"
      args = {
        summary:
          "Original Agent Zero rg and todo_list tools executed successfully in the Linux workstation.",
        files: [],
      }
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        id: `plugin-fixture-${step}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "plugin-fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `plugin-call-${step}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      })
    )
  })().catch((error) => {
    modelErrors.push(String(error))
    response.writeHead(500).end(JSON.stringify({ error: String(error) }))
  })
})
model.listen(0, "127.0.0.1")
await once(model, "listening")
const modelPort = (model.address() as { port: number }).port
try {
  assert.equal(await start(["--import", "tsx", "scripts/migrate.ts"], "migrate").done, 0)
  assert.equal(await start(["--import", "tsx", "scripts/owner.ts"], "owner").done, 0)
  const { setSetting } = await import("@/lib/config")
  const { pool } = await import("@/db")
  await setSetting("provider.custom.apiKey", "local-fixed-response-no-cloud")
  await setSetting("provider.custom.baseUrl", `http://127.0.0.1:${modelPort}/v1`)
  await setSetting("model.default", "custom/plugin-fixture")
  start(
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "17207",
    ],
    "web"
  )
  await until(async () => {
    try {
      return (await fetch(`${process.env.APP_URL}/login`)).ok ? true : undefined
    } catch (error) {
      if ((error as Error).cause && (error as Error).message === "fetch failed")
        return undefined
      throw error
    }
  }, "web readiness")
  const base = process.env.APP_URL!
  assert.equal((await fetch(`${base}/api/plugins/agent-zero`)).status, 401)
  const auth = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.OWNER_EMAIL,
      password: process.env.OWNER_PASSWORD,
    }),
  })
  assert.equal(auth.status, 200)
  const headers = {
    Origin: base,
    "Content-Type": "application/json",
    Cookie: auth.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  }
  const foreign = await fetch(`${base}/api/plugins/agent-zero`, {
    method: "PATCH",
    headers: { ...headers, Origin: "https://untrusted.example" },
    body: "{}",
  })
  assert.equal(foreign.status, 403)
  const catalogResponse = await fetch(`${base}/api/plugins/agent-zero?catalog=1`, {
    headers,
  })
  assert.equal(catalogResponse.status, 200, await catalogResponse.clone().text())
  const catalog = await catalogResponse.json()
  assert(catalog.some((entry: any) => entry.id === "rg"))
  const installed: any[] = []
  for (const entry of [
    {
      id: "rg",
      repository: "https://github.com/linkliti/a0-plugin-rg",
      ref: "66e6d6ddf6ef115985ac60a2c1f79bb56c36b010",
    },
    {
      id: "todo_list",
      repository: "https://github.com/Reaperrhs/agent-zero-todo-list",
      ref: "888b8c36327972c41a86e9a68a685f6f7c525ded",
    },
  ]) {
    const response = await fetch(`${base}/api/plugins/agent-zero`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository: entry.repository,
        ref: entry.ref,
        expectedName: entry.id,
      }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const plugin = (await response.json()).find((row: any) => row.id === entry.id)
    assert.equal(plugin.enabled, false)
    assert(plugin.tools.length)
    const enabled = await fetch(`${base}/api/plugins/agent-zero`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: entry.id, enabled: true, config: plugin.config }),
    })
    assert.equal(enabled.status, 200, await enabled.clone().text())
    installed.push(plugin)
  }
  checks.push(
    "Official Plugin Index plus pinned original rg and todo_list sources installed through owner API; foreign-origin and anonymous calls rejected"
  )
  const { submitTask } = await import("@/lib/tasks")
  const agent = (await pool.query("SELECT id FROM agents WHERE model IS NULL LIMIT 1"))
    .rows[0]
  const owner = (await pool.query("SELECT user_id FROM owners LIMIT 1")).rows[0]
  const accepted = await submitTask(owner.user_id, "plugin-compatibility", {
    agentId: agent.id,
    goal: "Verify installed Agent Zero tools using the controlled local provider",
    clientRequestId: randomUUID(),
    completionContract: { requireHumanReview: false },
    budget: { maxSteps: 12 },
  })
  taskId = accepted.taskId
  const frozen = (
    await pool.query("SELECT config_snapshot FROM tasks WHERE id=$1", [taskId])
  ).rows[0].config_snapshot
  for (const plugin of installed) {
    const disabled = await fetch(`${base}/api/plugins/agent-zero`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: plugin.id, enabled: false, config: plugin.config }),
    })
    assert.equal(disabled.status, 200)
  }
  assert.equal(frozen.agentZeroPlugins.length, 2)
  start(["--import", "tsx", "worker/main.ts"], "worker")
  const task = await until(async () => {
    const row = (
      await pool.query("SELECT status,result,error FROM tasks WHERE id=$1", [taskId])
    ).rows[0]
    if (["failed", "needs_review"].includes(row.status))
      throw new Error(JSON.stringify(row))
    return row.status === "completed" ? row : undefined
  }, "plugin task completion")
  assert.equal(replayVerified, true)
  assert.deepEqual(modelErrors, [])
  assert.equal(modelCalls, 5)
  const actions = (
    await pool.query(
      "SELECT action_no,kind,status,input,receipt FROM task_actions WHERE task_id=$1 ORDER BY action_no",
      [taskId]
    )
  ).rows
  assert.equal(
    actions.filter((action) => action.input.command?.includes(".pa-bridge.py")).length,
    3
  )
  assert(actions.every((action) => action.status === "succeeded"))
  checks.push(
    "Production worker, real Linux desktop, original rg search and todo create/read, same-action replay, frozen config after disable; one Task and five local model responses"
  )
  passed = true
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ taskId, task, actions, modelCalls, checks, installed }, null, 2)
  )
} catch (error) {
  failure = (error as Error).stack
  throw error
} finally {
  for (const job of jobs.filter(
    (job) => job.child.exitCode === null && job.child.signalCode === null
  ))
    job.child.kill("SIGTERM")
  await Promise.race([Promise.all(jobs.map((job) => job.done)), delay(15000)])
  for (const job of jobs.filter(
    (job) => job.child.exitCode === null && job.child.signalCode === null
  ))
    process.kill(-job.child.pid!, "SIGKILL")
  await new Promise<void>((resolve) => model.close(() => resolve()))
  const { stopInstallationWorkstations } = await import("@/lib/workstation")
  await stopInstallationWorkstations()
  const { closeDurableClient } = await import("@/lib/durable")
  await closeDurableClient()
  const { pool } = await import("@/db")
  await pool.end()
  const report = {
    passed,
    database,
    directory,
    taskId,
    modelCalls,
    cloudModelRequests: 0,
    replayVerified,
    checks,
    failure,
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2))
  await writeFile(
    "docs/evidence/agent-zero-plugins.json",
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify(report, null, 2))
}
