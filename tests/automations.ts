import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { MockLanguageModelV3 } from "ai/test"
process.loadEnvFile(".env")
const database = `agent_automations_${randomUUID().replaceAll("-", "")}`,
  directory = path.resolve("data/experiments", database)
await mkdir(directory, { recursive: true })
const url = new URL(process.env.DATABASE_URL!),
  admin = new pg.Client({ connectionString: url.toString() })
await admin.connect()
await admin.query(`CREATE DATABASE "${database}"`)
url.pathname = `/${database}`
process.env.DATABASE_URL = url.toString()
let content = "first",
  sourceStatus = 200
const source = createServer((_req, res) => {
  res.writeHead(sourceStatus, { "Content-Type": "text/plain" })
  res.end(content)
})
source.listen(0, "127.0.0.1")
await once(source, "listening")
const sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`
let passed = false
const checks: string[] = []
try {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  await once(child, "exit")
  assert.equal(child.exitCode, 0)
  const { pool } = await import("@/db"),
    { closeDurableClient } = await import("@/lib/durable")
  try {
    const { updateCompanion } = await import("@/lib/companion/store")
    const { manageChatRoutine } = await import("@/lib/companion/routines")
    const { companionChat } = await import("@/lib/companion/chat")
    const { acceptRoutineEvent, rotateRoutineWebhook, stageChangedRoutines } =
      await import("@/lib/routine-events")
    const { routineOverview } = await import("@/lib/routines")
    const owner = "automation-owner",
      agent = randomUUID(),
      other = randomUUID()
    await pool.query(
      "INSERT INTO owners(id,user_id,time_zone,created_at) VALUES(1,$1,'UTC',now())",
      [owner]
    )
    for (const id of [agent, other]) {
      await pool.query(
        "INSERT INTO agents(id,name,role,glyph,model,created_at,updated_at) VALUES($1,'Automation','Assistant','fixture','custom/mock',now(),now())",
        [id]
      )
      await updateCompanion(owner, id, { typingPace: "off" })
    }
    const plan = {
      name: "Daily report",
      prompt: "Read report",
      schedule: { kind: "daily", time: "09:00" },
      enabled: true,
    }
    const command = { action: "create", plan }
    const created = (await manageChatRoutine(owner, agent, "first", command)) as {
      id: string
      version: number
    }
    assert.deepEqual(await manageChatRoutine(owner, agent, "first", command), created)
    await assert.rejects(
      manageChatRoutine(owner, agent, "first", {
        ...command,
        plan: { ...plan, name: "Changed" },
      }),
      { status: 409 }
    )
    let listed = (await manageChatRoutine(owner, agent, "list", { action: "list" })) as {
      routines: { id: string; version: number; enabled: boolean }[]
    }
    assert.equal(listed.routines.length, 1)
    await manageChatRoutine(owner, agent, "pause", {
      action: "pause",
      id: created.id,
      version: 1,
    })
    await assert.rejects(
      manageChatRoutine(owner, agent, "stale", {
        action: "resume",
        id: created.id,
        version: 1,
      }),
      { status: 409 }
    )
    await manageChatRoutine(owner, agent, "resume", {
      action: "resume",
      id: created.id,
      version: 2,
    })
    await manageChatRoutine(owner, agent, "update", {
      action: "update",
      id: created.id,
      version: 3,
      plan: { ...plan, name: "Revised report" },
    })
    await assert.rejects(
      manageChatRoutine(owner, other, "foreign", {
        action: "delete",
        id: created.id,
        version: 4,
      }),
      { status: 404 }
    )
    await manageChatRoutine(owner, agent, "delete", {
      action: "delete",
      id: created.id,
      version: 4,
    })
    listed = (await manageChatRoutine(owner, agent, "list2", {
      action: "list",
    })) as typeof listed
    assert.equal(listed.routines.length, 0)
    checks.push(
      "Chat routine CRUD/pause/resume is atomic and idempotent; stale versions and cross-agent commands rejected"
    )
    let calls = 0
    const chat = await companionChat(
      { ownerId: owner, agentId: agent, text: "每天九点帮我看报表" },
      {
        price: { kind: "local" },
        model: new MockLanguageModelV3({
          doStream: async () => {
            const parts =
              calls++ === 0
                ? [
                    {
                      type: "tool-call",
                      toolCallId: "create-routine",
                      toolName: "manage_routine",
                      input: JSON.stringify(command),
                    },
                  ]
                : [
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: "每天九点查报表。" },
                    { type: "text-end", id: "t" },
                  ]
            return {
              stream: new ReadableStream({
                start(c) {
                  c.enqueue({ type: "stream-start", warnings: [] })
                  for (const part of parts) c.enqueue(part as never)
                  c.enqueue({
                    type: "finish",
                    finishReason: {
                      unified: parts[0].type === "tool-call" ? "tool-calls" : "stop",
                      raw: undefined,
                    },
                    usage: {
                      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 1, text: 1, reasoning: 0 },
                    },
                  })
                  c.close()
                },
              }),
            }
          },
        }),
      }
    )
    assert(chat.replies.some((message) => message.content.includes("每天九点")))
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM routines WHERE deleted_at IS NULL"
        )
      ).rows[0].n,
      1
    )
    checks.push(
      "Actual Companion tool loop creates requested routine and returns its result into chat"
    )
    const webhook = (await manageChatRoutine(owner, agent, "hook", {
      action: "create",
      plan: { ...plan, name: "Event report", eventTrigger: { kind: "webhook" } },
    })) as { id: string }
    const credential = await rotateRoutineWebhook(webhook.id)
    await assert.rejects(
      acceptRoutineEvent(webhook.id, "bad", { id: "e1", data: { value: 1 } }),
      { status: 401 }
    )
    const accepted = await acceptRoutineEvent(webhook.id, credential.token, {
      id: "e1",
      data: { value: 1 },
    })
    assert.equal(
      (
        await acceptRoutineEvent(webhook.id, credential.token, {
          id: "e1",
          data: { value: 1 },
        })
      ).runId,
      accepted.runId
    )
    await assert.rejects(
      acceptRoutineEvent(webhook.id, credential.token, { id: "e1", data: { value: 2 } }),
      { status: 409 }
    )
    await rotateRoutineWebhook(webhook.id)
    await assert.rejects(
      acceptRoutineEvent(webhook.id, credential.token, { id: "e2", data: { value: 1 } }),
      { status: 401 }
    )
    assert(!JSON.stringify(await routineOverview(owner)).includes(credential.token))
    assert(
      !JSON.stringify((await pool.query("SELECT * FROM routines")).rows).includes(
        credential.token
      )
    )
    checks.push(
      "Webhook tokens are private/encrypted and rotate; duplicate event creates one frozen run"
    )
    const watch = (await manageChatRoutine(owner, agent, "watch", {
      action: "create",
      plan: {
        ...plan,
        name: "Watch report",
        eventTrigger: { kind: "url_change", url: sourceUrl, everyMinutes: 1 },
      },
    })) as { id: string }
    let at = new Date(Date.now() + 1000)
    assert.equal(await stageChangedRoutines(at), 0)
    at = new Date(at.getTime() + 61000)
    assert.equal(await stageChangedRoutines(at), 0)
    content = "second"
    at = new Date(at.getTime() + 61000)
    const counts = await Promise.all([stageChangedRoutines(at), stageChangedRoutines(at)])
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      1
    )
    const run = (
      await pool.query("SELECT snapshot FROM routine_runs WHERE routine_id=$1", [
        watch.id,
      ])
    ).rows[0]
    assert.match(run.snapshot.input.goal, /second/)
    content = "third"
    sourceStatus = 503
    at = new Date(at.getTime() + 61000)
    assert.equal(await stageChangedRoutines(at), 0)
    const state = (
      await pool.query("SELECT watch_state,last_error FROM routines WHERE id=$1", [
        watch.id,
      ])
    ).rows[0]
    assert.equal(state.watch_state.content, "second")
    assert.match(state.last_error, /503/)
    await manageChatRoutine(owner, agent, "pausewatch", {
      action: "pause",
      id: watch.id,
      version: 1,
    })
    sourceStatus = 200
    assert.equal(await stageChangedRoutines(new Date(at.getTime() + 61000)), 0)
    checks.push(
      "URL watcher records baseline, only changes trigger, concurrent polls dedupe, failures preserve baseline and pause stops polling"
    )
    passed = true
  } finally {
    await closeDurableClient()
    await pool.end()
  }
} finally {
  source.closeAllConnections()
  await new Promise<void>((resolve) => source.close(() => resolve()))
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed, checks, database }, null, 2)
  )
  if (passed) await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
}
console.log(JSON.stringify({ passed, checks, directory }, null, 2))
